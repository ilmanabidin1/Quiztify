// Quiz Unisba - server platform (v2: akun, kelas, quiz per kelas, hasil)
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- util ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), crypto.scryptSync(pw, salt, 32));
}
function norm(s) { return String(s || '').trim(); }
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSession(res, role, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, role, user_id) VALUES (?, ?, ?)').run(token, role, userId);
  res.setHeader('Set-Cookie', `qu_session=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`);
  return token;
}
function clearSession(req, res) {
  const token = parseCookies(req).qu_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', 'qu_session=; HttpOnly; Path=/; Max-Age=0');
}
function auth(req) {
  const s = db.prepare('SELECT role, user_id FROM sessions WHERE token = ?').get(parseCookies(req).qu_session || '');
  return s || null;
}
function requireRole(role) {
  return (req, res, next) => {
    const a = auth(req);
    if (!a || a.role !== role) return res.status(401).json({ error: 'Harus login sebagai ' + role });
    req.auth = a;
    next();
  };
}
function ngain(pre, post) {
  if (pre === null || post === null) return null;
  if (pre === 100) return post >= pre ? 1 : 0;
  return Math.max(0, Math.round(((post - pre) / (100 - pre)) * 100) / 100);
}

// seed akun dosen default; jika DOSEN_PASSWORD env berubah, hash di DB ikut diperbarui (env = sumber kebenaran)
const DOSEN_ENV_PASS = process.env.DOSEN_PASSWORD;
const dosenRow = db.prepare('SELECT id, password_hash FROM dosen LIMIT 1').get();
if (!dosenRow) {
  db.prepare('INSERT INTO dosen (nama, email, password_hash) VALUES (?, ?, ?)').run(
    'Dosen', 'dosen@unisba.ac.id', hashPassword(DOSEN_ENV_PASS || 'unisba2026'));
} else if (DOSEN_ENV_PASS && !verifyPassword(DOSEN_ENV_PASS, dosenRow.password_hash)) {
  db.prepare('UPDATE dosen SET password_hash = ? WHERE id = ?').run(hashPassword(DOSEN_ENV_PASS), dosenRow.id);
}

// ---------- auth umum ----------
app.post('/api/auth/dosen/login', (req, res) => {
  const { email, password } = req.body || {};
  const d = db.prepare('SELECT * FROM dosen WHERE lower(email) = lower(?)').get(norm(email));
  if (!d || !verifyPassword(password, d.password_hash)) return res.status(401).json({ error: 'Email atau password salah' });
  setSession(res, 'dosen', d.id);
  res.json({ id: d.id, nama: d.nama, email: d.email });
});

app.post('/api/auth/mahasiswa/register', (req, res) => {
  const { nama, npm, password, class_id } = req.body || {};
  const n = norm(nama), m = norm(npm);
  if (!n || n.length < 3) return res.status(400).json({ error: 'Nama lengkap wajib diisi' });
  if (!/^\d{6,12}$/.test(m)) return res.status(400).json({ error: 'NPM harus 6-12 digit angka' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
  const kls = db.prepare('SELECT id FROM classes WHERE id = ?').get(Number(class_id));
  if (!kls) return res.status(400).json({ error: 'Pilih kelas yang tersedia' });
  if (db.prepare('SELECT id FROM students WHERE npm = ?').get(m)) return res.status(409).json({ error: 'NPM ini sudah terdaftar, silakan login' });
  const info = db.prepare('INSERT INTO students (class_id, nama, npm, password_hash) VALUES (?, ?, ?, ?)').run(kls.id, n, m, hashPassword(password));
  setSession(res, 'mahasiswa', info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid, nama: n, npm: m, class_id: kls.id });
});

app.post('/api/auth/mahasiswa/login', (req, res) => {
  const { npm, password } = req.body || {};
  const s = db.prepare('SELECT * FROM students WHERE npm = ?').get(norm(npm));
  if (!s || !verifyPassword(password, s.password_hash)) return res.status(401).json({ error: 'NPM atau password salah' });
  setSession(res, 'mahasiswa', s.id);
  res.json({ id: s.id, nama: s.nama, npm: s.npm, class_id: s.class_id });
});

app.post('/api/auth/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const a = auth(req);
  if (!a) return res.json({ role: null });
  if (a.role === 'dosen') {
    const d = db.prepare('SELECT id, nama, email FROM dosen WHERE id = ?').get(a.user_id);
    return res.json({ role: 'dosen', ...d });
  }
  const s = db.prepare(`SELECT s.id, s.nama, s.npm, c.id AS class_id, c.name AS class_name, c.course
    FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`).get(a.user_id);
  res.json({ role: 'mahasiswa', ...s });
});

// daftar kelas publik (untuk pendaftaran mahasiswa)
app.get('/api/classes/public', (req, res) => {
  res.json(db.prepare(`SELECT c.id, c.name, c.course, COUNT(s.id) AS n_students
    FROM classes c LEFT JOIN students s ON s.class_id = c.id GROUP BY c.id ORDER BY c.created_at DESC`).all());
});

// ---------- mahasiswa ----------
function requireStudent(req, res, next) {
  const a = auth(req);
  if (!a || a.role !== 'mahasiswa') return res.status(401).json({ error: 'Harus login sebagai mahasiswa' });
  req.student = db.prepare('SELECT * FROM students WHERE id = ?').get(a.user_id);
  next();
}

app.get('/api/student/quizzes', requireStudent, (req, res) => {
  const rows = db.prepare(`SELECT q.id, q.title, q.type, q.duration_min, q.deadline, q.pair_key
    FROM quizzes q WHERE q.class_id = ? AND q.active = 1 ORDER BY q.created_at DESC`).all(req.student.class_id);
  const done = db.prepare(`SELECT quiz_id, score FROM attempts WHERE student_id = ?`).all(req.student.id);
  const dmap = Object.fromEntries(done.map(d => [d.quiz_id, d.score]));
  const now = Date.now();
  res.json(rows.map(q => ({
    ...q,
    open: !q.deadline || new Date(q.deadline).getTime() > now,
    my_score: dmap[q.id] ?? null,
    done: q.id in dmap
  })));
});

app.get('/api/student/quiz/:id', requireStudent, (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ? AND active = 1').get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz tidak ditemukan' });
  if (quiz.class_id !== req.student.class_id) return res.status(403).json({ error: 'Quiz ini bukan untuk kelas kamu' });
  if (db.prepare('SELECT id FROM attempts WHERE quiz_id = ? AND student_id = ?').get(quiz.id, req.student.id)) {
    return res.status(409).json({ error: 'Kamu sudah mengerjakan quiz ini' });
  }
  const qs = db.prepare('SELECT id, position, text, options FROM questions WHERE quiz_id = ? ORDER BY position').all(quiz.id);
  res.json({ id: quiz.id, title: quiz.title, type: quiz.type, duration_min: quiz.duration_min,
    questions: qs.map(q => ({ id: q.id, position: q.position, text: q.text, options: JSON.parse(q.options) })) });
});

app.post('/api/student/quiz/:id/submit', requireStudent, (req, res) => {
  const { answers } = req.body || {};
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ? AND active = 1').get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz tidak ditemukan' });
  if (quiz.class_id !== req.student.class_id) return res.status(403).json({ error: 'Quiz ini bukan untuk kelas kamu' });
  const qs = db.prepare('SELECT id, correct_idx FROM questions WHERE quiz_id = ?').all(quiz.id);
  let correct = 0;
  for (const q of qs) if (answers && Number(answers[q.id]) === q.correct_idx) correct++;
  const score = qs.length ? Math.round((correct / qs.length) * 100) : 0;
  try {
    db.prepare(`INSERT INTO attempts (quiz_id, student_id, score, correct_count, total_count, answers)
      VALUES (?, ?, ?, ?, ?, ?)`).run(quiz.id, req.student.id, score, correct, qs.length, JSON.stringify(answers || {}));
  } catch (e) {
    return res.status(409).json({ error: 'Kamu sudah mengerjakan quiz ini' });
  }
  let gain = null;
  if (quiz.pair_key) {
    const pair = db.prepare(`SELECT q.type, a.score FROM attempts a JOIN quizzes q ON q.id = a.quiz_id
      WHERE a.student_id = ? AND q.pair_key = ?`).all(req.student.id, quiz.pair_key);
    const pre = pair.find(p => p.type === 'pre');
    const post = pair.find(p => p.type === 'post');
    if (pre && post) gain = ngain(pre.score, post.score);
  }
  res.json({ score, correct, total: qs.length, ngain: gain });
});

app.get('/api/student/results', requireStudent, (req, res) => {
  const rows = db.prepare(`SELECT q.id AS quiz_id, q.title, q.type, q.pair_key, a.score, a.created_at
    FROM attempts a JOIN quizzes q ON q.id = a.quiz_id
    WHERE a.student_id = ? ORDER BY a.created_at DESC`).all(req.student.id);
  const byPair = {};
  for (const r of rows) {
    if (!r.pair_key) continue;
    byPair[r.pair_key] = byPair[r.pair_key] || {};
    byPair[r.pair_key][r.type] = r.score;
  }
  const gains = Object.entries(byPair)
    .map(([key, p]) => ({ key, pre: p.pre ?? null, post: p.post ?? null, ngain: ngain(p.pre ?? null, p.post ?? null) }))
    .filter(g => g.ngain !== null);
  res.json({ attempts: rows, gains });
});

// ---------- dosen ----------
app.get('/api/dosen/classes', requireRole('dosen'), (req, res) => {
  res.json(db.prepare(`SELECT c.id, c.name, c.course, c.created_at,
      (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS n_students,
      (SELECT COUNT(*) FROM quizzes q WHERE q.class_id = c.id) AS n_quizzes
    FROM classes c WHERE c.dosen_id = ? ORDER BY c.created_at DESC`).all(req.auth.user_id));
});

app.post('/api/dosen/classes', requireRole('dosen'), (req, res) => {
  const { name, course } = req.body || {};
  if (!norm(name)) return res.status(400).json({ error: 'Nama kelas wajib diisi' });
  const info = db.prepare('INSERT INTO classes (dosen_id, name, course) VALUES (?, ?, ?)').run(req.auth.user_id, norm(name), norm(course || ''));
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/dosen/classes/:id', requireRole('dosen'), (req, res) => {
  const c = db.prepare('SELECT id FROM classes WHERE id = ? AND dosen_id = ?').get(req.params.id, req.auth.user_id);
  if (!c) return res.status(404).json({ error: 'Kelas tidak ditemukan' });
  db.prepare('DELETE FROM classes WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

app.get('/api/dosen/classes/:id/students', requireRole('dosen'), (req, res) => {
  const c = db.prepare('SELECT id FROM classes WHERE id = ? AND dosen_id = ?').get(req.params.id, req.auth.user_id);
  if (!c) return res.status(404).json({ error: 'Kelas tidak ditemukan' });
  res.json(db.prepare('SELECT id, nama, npm, created_at FROM students WHERE class_id = ? ORDER BY nama').all(c.id));
});

app.post('/api/dosen/quizzes', requireRole('dosen'), (req, res) => {
  const { class_id, title, type, duration_min, deadline, pair_key, questions } = req.body || {};
  const c = db.prepare('SELECT id FROM classes WHERE id = ? AND dosen_id = ?').get(Number(class_id), req.auth.user_id);
  if (!c) return res.status(400).json({ error: 'Kelas tidak valid' });
  if (!norm(title)) return res.status(400).json({ error: 'Judul wajib diisi' });
  if (!['pre', 'post'].includes(type)) return res.status(400).json({ error: 'Tipe harus pre atau post' });
  if (!Array.isArray(questions) || questions.length === 0) return res.status(400).json({ error: 'Minimal 1 soal' });
  for (const q of questions) {
    if (!norm(q.text) || !Array.isArray(q.options) || q.options.length < 2 || q.options.some(o => !norm(o))) {
      return res.status(400).json({ error: 'Tiap soal butuh teks dan minimal 2 opsi terisi' });
    }
    if (!(Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length)) {
      return res.status(400).json({ error: 'Kunci jawaban belum dipilih untuk semua soal' });
    }
  }
  const info = db.prepare(`INSERT INTO quizzes (class_id, title, type, duration_min, deadline, pair_key)
    VALUES (?, ?, ?, ?, ?, ?)`).run(c.id, norm(title), type, Number(duration_min) || null,
      deadline ? new Date(deadline).toISOString() : null, norm(pair_key) || null);
  const ins = db.prepare('INSERT INTO questions (quiz_id, position, text, options, correct_idx) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < questions.length; i++) {
    ins.run(info.lastInsertRowid, i + 1, norm(questions[i].text), JSON.stringify(questions[i].options), questions[i].correct);
  }
  res.json({ id: info.lastInsertRowid });
});

app.get('/api/dosen/quizzes/:id/qr', requireRole('dosen'), (req, res) => {
  const q = db.prepare(`SELECT q.id FROM quizzes q JOIN classes c ON c.id = q.class_id
    WHERE q.id = ? AND c.dosen_id = ?`).get(req.params.id, req.auth.user_id);
  if (!q) return res.status(404).json({ error: 'Quiz tidak ditemukan' });
  const base = process.env.PUBLIC_BASE_URL || req.headers.origin || `http://localhost:${process.env.PORT || 3000}`;
  const url = `${base.replace(/\/$/, '')}/?quiz=${q.id}`;
  QRCode.toDataURL(url, { margin: 1, width: 320, color: { dark: '#0b1a30', light: '#ffffff' } }, (err, dataUrl) => {
    if (err) return res.status(500).json({ error: 'Gagal membuat QR' });
    res.json({ url, qr: dataUrl });
  });
});

app.delete('/api/dosen/quizzes/:id', requireRole('dosen'), (req, res) => {
  const q = db.prepare(`SELECT q.id FROM quizzes q JOIN classes c ON c.id = q.class_id
    WHERE q.id = ? AND c.dosen_id = ?`).get(req.params.id, req.auth.user_id);
  if (!q) return res.status(404).json({ error: 'Quiz tidak ditemukan' });
  db.prepare('DELETE FROM quizzes WHERE id = ?').run(q.id);
  res.json({ ok: true });
});

// hasil per kelas: quiz list + per mahasiswa pre/post/n-gain
app.get('/api/dosen/classes/:id/results', requireRole('dosen'), (req, res) => {
  const c = db.prepare('SELECT id FROM classes WHERE id = ? AND dosen_id = ?').get(req.params.id, req.auth.user_id);
  if (!c) return res.status(404).json({ error: 'Kelas tidak ditemukan' });
  const quizzes = db.prepare(`SELECT q.*, (SELECT COUNT(*) FROM attempts a WHERE a.quiz_id = q.id) AS n_attempts
    FROM quizzes q WHERE q.class_id = ? ORDER BY q.created_at DESC`).all(c.id);
  const students = db.prepare('SELECT id, nama, npm FROM students WHERE class_id = ? ORDER BY nama').all(c.id);
  const scores = db.prepare(`SELECT a.student_id, q.type, q.pair_key, a.score
    FROM attempts a JOIN quizzes q ON q.id = a.quiz_id WHERE q.class_id = ?`).all(c.id);
  const byStudent = {};
  for (const s of scores) {
    byStudent[s.student_id] = byStudent[s.student_id] || {};
    if (s.pair_key) {
      byStudent[s.student_id][s.pair_key] = byStudent[s.student_id][s.pair_key] || {};
      byStudent[s.student_id][s.pair_key][s.type] = s.score;
    }
  }
  const rows = students.map(s => {
    const pairs = Object.entries(byStudent[s.id] || {}).map(([key, p]) => ({ key, pre: p.pre ?? null, post: p.post ?? null, ngain: ngain(p.pre ?? null, p.post ?? null) }));
    const gains = pairs.filter(p => p.ngain !== null).map(p => p.ngain);
    return {
      ...s,
      pairs,
      avg_ngain: gains.length ? Math.round((gains.reduce((a, b) => a + b, 0) / gains.length) * 100) / 100 : null
    };
  });
  const g = rows.filter(r => r.avg_ngain !== null);
  res.json({
    quizzes,
    students: rows,
    class_avg_ngain: g.length ? Math.round((g.reduce((a, b) => a + b.avg_ngain, 0) / g.length) * 100) / 100 : null
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quiz Unisba jalan di http://localhost:${PORT}`));
