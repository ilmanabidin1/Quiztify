// Pembayaran langganan lewat DOKU Checkout (API non-SNAP).
// Alur: dosen klik upgrade -> server membuat invoice + minta payment.url ke DOKU
// -> dosen bayar di halaman DOKU -> DOKU kirim HTTP Notification ke /api/payments/doku/notify
// -> server verifikasi signature, cocokkan nominal, lalu aktifkan paket.
// Env: DOKU_CLIENT_ID, DOKU_SECRET_KEY, DOKU_ENV (sandbox | production).
const crypto = require('crypto');

const PRICES = { pro: { amount: 49000, days: 30, name: 'Quiztify Pro Creator (30 hari)' } };
const NOTIFY_PATH = '/api/payments/doku/notify';

module.exports = function registerPayments(app, { db, requireRole }) {
  db.exec(`CREATE TABLE IF NOT EXISTS payments (
    invoice TEXT PRIMARY KEY,
    dosen_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    amount INTEGER NOT NULL,
    days INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    payment_url TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    paid_at TEXT
  )`);

  const cfg = () => ({
    clientId: process.env.DOKU_CLIENT_ID,
    secret: process.env.DOKU_SECRET_KEY,
    host: process.env.DOKU_ENV === 'production' ? 'https://api.doku.com' : 'https://api-sandbox.doku.com'
  });
  const configured = () => {
    const c = cfg();
    try {
      const base = new URL(process.env.PUBLIC_BASE_URL);
      return !!(c.clientId && c.secret) &&
        ['sandbox', 'production'].includes(process.env.DOKU_ENV || 'sandbox') &&
        ['http:', 'https:'].includes(base.protocol) && !base.username && !base.password &&
        (process.env.DOKU_ENV !== 'production' || base.protocol === 'https:');
    } catch { return false; }
  };

  const digestOf = (raw) => crypto.createHash('sha256').update(raw).digest('base64');
  function signature({ clientId, requestId, timestamp, target, digest }, secret) {
    let comp = `Client-Id:${clientId}\nRequest-Id:${requestId}\nRequest-Timestamp:${timestamp}\nRequest-Target:${target}`;
    if (digest) comp += `\nDigest:${digest}`;
    return 'HMACSHA256=' + crypto.createHmac('sha256', secret).update(comp).digest('base64');
  }
  function safeEqual(a, b) {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  async function dokuRequest(method, target, body) {
    const c = cfg();
    const raw = body ? JSON.stringify(body) : '';
    const headers = {
      'Client-Id': c.clientId,
      'Request-Id': crypto.randomUUID(),
      'Request-Timestamp': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    };
    headers.Signature = signature({
      clientId: c.clientId, requestId: headers['Request-Id'], timestamp: headers['Request-Timestamp'],
      target, digest: body ? digestOf(raw) : null
    }, c.secret);
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(c.host + target, { method, headers, body: body ? raw : undefined, signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  // Satu invoice hanya memberi masa aktif sekali, termasuk notifikasi ulang/terlambat.
  function markPaid(invoice, paidAmount) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const p = db.prepare('SELECT * FROM payments WHERE invoice = ?').get(invoice);
      if (!p || p.status === 'SUCCESS') { db.exec('COMMIT'); return p; }
      if (!['number', 'string'].includes(typeof paidAmount) ||
          !Number.isSafeInteger(Number(paidAmount)) || Number(paidAmount) !== p.amount) {
        throw new Error('Payment amount mismatch');
      }
      const d = db.prepare('SELECT plan, plan_expires_at FROM dosen WHERE id = ?').get(p.dosen_id);
      if (!d) throw new Error('Payment account missing');
      const current = d.plan === p.plan && d.plan_expires_at ? Date.parse(d.plan_expires_at) : 0;
      const expires = new Date(Math.max(Date.now(), current || 0) + p.days * 86400000).toISOString();
      db.prepare("UPDATE payments SET status='SUCCESS', paid_at=datetime('now') WHERE invoice=?").run(invoice);
      db.prepare('UPDATE dosen SET plan = ?, plan_expires_at = ? WHERE id = ?').run(p.plan, expires, p.dosen_id);
      db.exec('COMMIT');
      return db.prepare('SELECT * FROM payments WHERE invoice = ?').get(invoice);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  app.post('/api/billing/checkout', requireRole('creator', 'dosen'), async (req, res) => {
    const plan = (req.body || {}).plan;
    const price = Object.hasOwn(PRICES, plan) ? PRICES[plan] : null;
    if (!price) return res.status(400).json({ error: 'Paket tidak tersedia untuk pembelian online. Untuk paket Campus, hubungi contact@quiztify.id.' });
    if (!configured()) return res.status(503).json({ error: 'Pembayaran belum aktif. Coba lagi nanti.' });

    const dosen = db.prepare('SELECT id, nama, email FROM dosen WHERE id = ?').get(req.auth.user_id);
    if (!dosen) return res.status(404).json({ error: 'Akun tidak ditemukan.' });

    // Tanpa simbol, maksimal 30 karakter supaya aman untuk semua kanal (kartu kredit, KKI).
    const invoice = 'QZ' + crypto.randomBytes(14).toString('hex');
    const base = new URL(process.env.PUBLIC_BASE_URL).origin;
    const back = `${base}/creator.html?payment=${invoice}`;

    const body = {
      order: {
        amount: price.amount,
        invoice_number: invoice,
        currency: 'IDR',
        callback_url: back,
        callback_url_result: back,
        language: 'ID',
        auto_redirect: true,
        line_items: [{ id: plan, name: price.name, quantity: 1, price: price.amount }]
      },
      payment: { payment_due_date: 60 },
      customer: { id: `DSN${dosen.id}`, name: String(dosen.nama || 'Dosen').slice(0, 255), email: dosen.email }
    };
    if (process.env.PUBLIC_BASE_URL) body.additional_info = { override_notification_url: `${base}${NOTIFY_PATH}` };

    try {
      // Simpan sebelum API dipanggil agar notifikasi yang cepat tidak hilang.
      db.prepare('INSERT INTO payments (invoice, dosen_id, plan, amount, days) VALUES (?, ?, ?, ?, ?)')
        .run(invoice, dosen.id, plan, price.amount, price.days);
      const r = await dokuRequest('POST', '/checkout/v1/payment', body);
      const url = r.data && r.data.response && r.data.response.payment && r.data.response.payment.url;
      if (!r.ok || !url) {
        console.error('[DOKU] Gagal membuat checkout', r.status, invoice);
        return res.status(502).json({ error: 'Halaman pembayaran gagal dibuat. Coba lagi beberapa saat lagi.' });
      }
      db.prepare('UPDATE payments SET payment_url = ? WHERE invoice = ?').run(url, invoice);
      res.json({ invoice, payment_url: url });
    } catch (e) {
      console.error('[DOKU] Error checkout', e.name, invoice);
      res.status(502).json({ error: 'Tidak bisa terhubung ke DOKU. Coba lagi beberapa saat lagi.' });
    }
  });

  // Balas 200 setelah diproses; error harus tetap bisa dikirim ulang oleh DOKU.
  app.post(NOTIFY_PATH, (req, res) => {
    const c = cfg();
    if (!configured()) return res.status(503).end();
    if (!req.rawBody || !req.get('Request-Id') || !req.get('Request-Timestamp')) {
      return res.status(400).json({ error: 'missing notification headers or body' });
    }
    const raw = req.rawBody;
    const expected = signature({
      clientId: req.get('Client-Id'), requestId: req.get('Request-Id'),
      timestamp: req.get('Request-Timestamp'), target: NOTIFY_PATH, digest: digestOf(raw)
    }, c.secret);
    if (req.get('Client-Id') !== c.clientId || !safeEqual(req.get('Signature'), expected)) {
      console.warn('[DOKU] Signature notifikasi tidak valid');
      return res.status(401).json({ error: 'invalid signature' });
    }
    const b = req.body || {};
    const invoice = b.order && b.order.invoice_number;
    const status = b.transaction && b.transaction.status;
    if (typeof invoice !== 'string' || !status) return res.status(400).json({ error: 'invalid notification' });
    try {
      if (status === 'SUCCESS') {
        if (b.order.currency && b.order.currency !== 'IDR') return res.status(400).json({ error: 'invalid currency' });
        if (!markPaid(invoice, b.order.amount)) return res.status(404).json({ error: 'invoice not found' });
      }
      // Checkout dapat dicoba ulang dengan metode lain; FAILED bukan status akhir invoice.
    } catch (e) {
      console.error('[DOKU] Notifikasi belum diproses', invoice, e.message);
      return res.status(500).json({ error: 'notification not processed' });
    }
    res.status(200).json({ ok: true });
  });

  // Dipanggil halaman creator saat kembali dari DOKU. Kalau notifikasi belum masuk, tanya langsung ke DOKU.
  app.get('/api/billing/status/:invoice', requireRole('creator', 'dosen'), async (req, res) => {
    let p = db.prepare('SELECT * FROM payments WHERE invoice = ? AND dosen_id = ?').get(req.params.invoice, req.auth.user_id);
    if (!p) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    if (['PENDING', 'FAILED'].includes(p.status) && configured()) {
      try {
        const r = await dokuRequest('GET', `/orders/v1/status/${encodeURIComponent(p.invoice)}`);
        const t = r.ok && r.data && r.data.transaction;
        const order = r.data && r.data.order;
        if (t && t.status === 'SUCCESS' && order && order.invoice_number === p.invoice &&
            (!order.currency || order.currency === 'IDR')) p = markPaid(p.invoice, order.amount);
      } catch (e) { console.error('[DOKU] Error cek status', e.message); }
    }
    const d = db.prepare('SELECT plan, plan_expires_at FROM dosen WHERE id = ?').get(req.auth.user_id);
    res.json({ invoice: p.invoice, status: p.status, plan: d.plan, plan_expires_at: d.plan_expires_at });
  });

  app.get('/api/billing/history', requireRole('creator', 'dosen'), (req, res) => {
    res.json(db.prepare(`SELECT invoice, plan, amount, status, created_at, paid_at FROM payments
      WHERE dosen_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.auth.user_id));
  });
};
