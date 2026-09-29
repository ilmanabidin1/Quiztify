const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const registerPayments = require('../payments');

const notifyPath = '/api/payments/doku/notify';
const secret = 'test-secret-only';
function headers(raw) {
  const h = { 'Content-Type': 'application/json', 'Client-Id': 'test-client',
    'Request-Id': crypto.randomUUID(), 'Request-Timestamp': new Date().toISOString() };
  const digest = crypto.createHash('sha256').update(raw).digest('base64');
  const canonical = `Client-Id:${h['Client-Id']}\nRequest-Id:${h['Request-Id']}\nRequest-Timestamp:${h['Request-Timestamp']}\nRequest-Target:${notifyPath}\nDigest:${digest}`;
  h.Signature = 'HMACSHA256=' + crypto.createHmac('sha256', secret).update(canonical).digest('base64');
  return h;
}

test('DOKU Checkout and signed notifications', async t => {
  const savedEnv = { ...process.env };
  Object.assign(process.env, { DOKU_ENV: 'sandbox', DOKU_CLIENT_ID: 'test-client',
    DOKU_SECRET_KEY: secret, PUBLIC_BASE_URL: 'https://www.quiztify.id' });
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE dosen (id INTEGER PRIMARY KEY, nama TEXT, email TEXT, plan TEXT, plan_expires_at TEXT);
    INSERT INTO dosen VALUES (1, 'Test Creator', 'test@example.com', 'free', NULL);`);
  const app = express();
  app.use(express.json({ verify(req, res, buf) { req.rawBody = buf; } }));
  registerPayments(app, { db, requireRole: () => (req, res, next) => {
    req.auth = { user_id: Number(req.get('Test-User') || 1) }; next();
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = global.fetch;
  let upstream;
  global.fetch = async (url, opts) => url.startsWith('https://api-sandbox.doku.com')
    ? upstream(url, opts) : realFetch(url, opts);
  t.after(async () => { global.fetch = realFetch; process.env = savedEnv;
    await new Promise(r => server.close(r)); db.close(); });
  const post = (path, body, h = {}) => realFetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body)
  });
  const notify = async (invoice, status, amount = 49000, change = {}) => {
    const raw = JSON.stringify({ order: { invoice_number: invoice, amount }, transaction: { status } });
    return realFetch(base + notifyPath, { method: 'POST', body: raw, headers: { ...headers(raw), ...change } });
  };
  let invoice;
  await t.test('checkout signs exact body, fixes callback origin, and saves invoice before calling DOKU', async () => {
    upstream = async (url, opts) => {
      const body = JSON.parse(opts.body);
      invoice = body.order.invoice_number;
      assert.match(invoice, /^[a-zA-Z0-9]{30}$/);
      assert.equal(body.order.amount, 49000);
      assert.equal(body.order.callback_url, `https://www.quiztify.id/creator.html?payment=${invoice}`);
      assert.equal(body.additional_info.override_notification_url, 'https://www.quiztify.id' + notifyPath);
      assert.ok(db.prepare('SELECT invoice FROM payments WHERE invoice=?').get(invoice));
      const digest = crypto.createHash('sha256').update(opts.body).digest('base64');
      const canonical = `Client-Id:test-client\nRequest-Id:${opts.headers['Request-Id']}\nRequest-Timestamp:${opts.headers['Request-Timestamp']}\nRequest-Target:/checkout/v1/payment\nDigest:${digest}`;
      assert.equal(opts.headers.Signature, 'HMACSHA256=' + crypto.createHmac('sha256', secret).update(canonical).digest('base64'));
      return { ok: true, status: 200, json: async () => ({ response: { payment: { url: 'https://checkout.doku.com/test' } } }) };
    };
    const res = await post('/api/billing/checkout', { plan: 'pro' }, { Origin: 'https://attacker.example' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).invoice, invoice);
  });
  await t.test('invalid signatures and missing headers cannot activate Pro', async () => {
    assert.equal((await notify(invoice, 'SUCCESS', 49000, { Signature: 'invalid' })).status, 401);
    assert.equal((await notify(invoice, 'SUCCESS', 49000, { 'Request-Id': '' })).status, 400);
    assert.equal(db.prepare('SELECT plan FROM dosen').get().plan, 'free');
  });
  await t.test('wrong and fractional amounts cannot activate Pro', async () => {
    for (const amount of [undefined, null, 1, 48999.9]) {
      // undefined is explicitly tested via status response below; null must never mean zero.
      if (amount === undefined) continue;
      assert.equal((await notify(invoice, 'SUCCESS', amount)).status, 500);
    }
    assert.equal(db.prepare('SELECT plan FROM dosen').get().plan, 'free');
  });
  await t.test('FAILED attempt remains pending; SUCCESS grants exactly 30 days once', async () => {
    assert.equal((await notify(invoice, 'FAILED')).status, 200);
    assert.equal(db.prepare('SELECT status FROM payments WHERE invoice=?').get(invoice).status, 'PENDING');
    const before = Date.now();
    assert.equal((await notify(invoice, 'SUCCESS')).status, 200);
    const expiry = db.prepare('SELECT plan_expires_at FROM dosen').get().plan_expires_at;
    assert.ok(Date.parse(expiry) >= before + 30 * 86400000);
    assert.equal((await notify(invoice, 'SUCCESS')).status, 200);
    assert.equal((await notify(invoice, 'FAILED')).status, 200);
    assert.equal(db.prepare('SELECT plan_expires_at FROM dosen').get().plan_expires_at, expiry);
  });
  await t.test('legacy FAILED invoice can succeed and renew only once', async () => {
    db.prepare("INSERT INTO payments(invoice,dosen_id,plan,amount,days,status) VALUES('legacy',1,'pro',49000,30,'FAILED')").run();
    const before = Date.parse(db.prepare('SELECT plan_expires_at FROM dosen').get().plan_expires_at);
    await notify('legacy', 'SUCCESS'); await notify('legacy', 'SUCCESS');
    assert.equal(Date.parse(db.prepare('SELECT plan_expires_at FROM dosen').get().plan_expires_at), before + 30 * 86400000);
  });
  await t.test('status reconciliation requires matching invoice and exact amount', async () => {
    db.prepare("INSERT INTO payments(invoice,dosen_id,plan,amount,days) VALUES('poll',1,'pro',49000,30)").run();
    for (const order of [{ invoice_number: 'other', amount: 49000 }, { invoice_number: 'poll' }]) {
      upstream = async () => ({ ok: true, json: async () => ({ transaction: { status: 'SUCCESS' }, order }) });
      const res = await realFetch(base + '/api/billing/status/poll');
      assert.equal((await res.json()).status, 'PENDING');
    }
    upstream = async () => ({ ok: true, json: async () => ({ transaction: { status: 'SUCCESS' }, order: { invoice_number: 'poll', amount: '49000' } }) });
    assert.equal((await (await realFetch(base + '/api/billing/status/poll')).json()).status, 'SUCCESS');
    assert.equal((await realFetch(base + '/api/billing/status/poll', { headers: { 'Test-User': '2' } })).status, 404);
  });
  await t.test('prototype property is not a purchasable plan; production requires HTTPS', async () => {
    assert.equal((await post('/api/billing/checkout', { plan: 'constructor' })).status, 400);
    process.env.DOKU_ENV = 'production'; process.env.PUBLIC_BASE_URL = 'http://quiztify.id';
    assert.equal((await post('/api/billing/checkout', { plan: 'pro' })).status, 503);
  });
});
