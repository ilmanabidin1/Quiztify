// Quiz Unisba - MVP server
const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DOSEN_PASS = process.env.DOSEN_PASSWORD || 'unisba2026';

// --- helpers ---
function dosenAuth(req, res, next) {
  if (req.header('x-dosen-pass') !== DOSEN_PASS) return res.status(401).json({ error: 'Password dosen salah' });
  next();
}
function norm(s) { return String(s || '').trim(); }

// --- API Mahasiswa ---
// list quiz aktif untuk mahasiswa (tanpa kunci jawaban)
app.get('/api/quizzes', (req, res) => {
  const rows = db.prepare(`SELECT id, title, course, type, class_name, duration_min, deadline, pair_key
    FROM quizzes WHERE active = 1 ORDER BY created_at DESC`).all();
  const now = Date.now();
  const open = rows.filter(q => !q.deadline || new Date(q.deadline).getTime() > now);
  res.json(open);
});

// ambil soal satu quiz (tanpa kunci)
app.get('/api/quizzes/:id', (req, res) => {
  const quiz = db.prepare(`SELECT id, title, course, type, class_name, duration_min, deadline FROM quizzes WHERE id = ? AND active = 1`).get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz tidak ditemukan' });
  const qs = db.prepare(`SELECT id, position, text, options FROM questions WHERE quiz_id = ? ORDER BY position`).all(quiz.id);
  res.json({ ...quiz, questions: qs.map(q => ({ id: q.id, position: q.position, text: q.text, options: JSON.parse(q.options) })) });
});

// submit jawaban mahasiswa (nama + npm)
app.post('/api/quizzes/:id/submit', (req, res) => {
  const { nama, npm, answers } = req.body;
  if (!norm(nama) || !/^\d{6,12}$/.test(norm(npm))) return res.status(400).json({ error: 'Nama dan NPM wajib diisi (NPM 6-12 digit)' });
  const quiz = db.prepare(`SELECT * FROM quizzes WHERE id = ? AND active = 1`).get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz tidak ditemukan' });

  const qs = db.prepare(`SELECT id, correct_idx FROM questions WHERE quiz_id = ?`).all(quiz.id);
  let correct = 0;
  for (const q of qs) {
    if (answers && Number(answers[q.id]) === q.correct_idx) correct++;
  }
  const score = qs.length ? Math.round((correct / qs.length) * 100) : 0;

  // cegah submit ganda
  const dup = db.prepare(`SELECT id FROM attempts WHERE quiz_id = ? AND npm = ?`).get(quiz.id, norm(npm));
  if (dup) return res.status(409).json({ error: 'NPM ini sudah pernah mengerjakan quiz ini' });

  db.prepare(`INSERT INTO attempts (quiz_id, nama, npm, score, correct_count, total_count, answers)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(quiz.id, norm(nama), norm(npm), score, correct, qs.length, JSON.stringify(answers || {}));

  // jika quiz ini punya pair_key, cek apakah pre & post sudah selesai -> hitung n-gain
  let ngain = null;
  if (quiz.pair_key) {
    const pair = db.prepare(`SELECT a.score, q.type FROM attempts a JOIN quizzes q ON q.id = a.quiz_id
      WHERE a.npm = ? AND q.pair_key = ?`).all(norm(npm), quiz.pair_key);
    const pre = pair.find(p => p.type === 'pre');
    const post = pair.find(p => p.type === 'post');
    if (pre && post) {
      const max = 100;
      ngain = pre.score === max ? (post.score >= pre.score ? 1 : 0) : (post.score - pre.score) / (max - pre.score);
      ngain = Math.max(0, Math.round(ngain * 100) / 100);
    }
  }
  res.json({ score, correct, total: qs.length, ngain });
});

// status mahasiswa: quiz mana yang sudah dikerjakan (by npm)
app.get('/api/my-status', (req, res) => {
  const npm = norm(req.query.npm);
  if (!npm) return res.status(400).json({ error: 'NPM wajib diisi' });
  const rows = db.prepare(`SELECT quiz_id FROM attempts WHERE npm = ?`).all(npm);
  res.json({ done: rows.map(r => r.quiz_id) });
});

// --- API Dosen ---
app.post('/api/quizzes', dosenAuth, (req, res) => {
  const { title, course, type, class_name, duration_min, deadline, pair_key, questions } = req.body;
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
  const info = db.prepare(`INSERT INTO quizzes (title, course, type, class_name, duration_min, deadline, pair_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(norm(title), norm(course), type, norm(class_name), Number(duration_min) || null,
      deadline ? new Date(deadline).toISOString() : null, norm(pair_key) || null);
  const quizId = info.lastInsertRowid;
  const ins = db.prepare(`INSERT INTO questions (quiz_id, position, text, options, correct_idx) VALUES (?, ?, ?, ?, ?)`);
  for (let i = 0; i < questions.length; i++) {
    ins.run(quizId, i + 1, norm(questions[i].text), JSON.stringify(questions[i].options), questions[i].correct);
  }
  res.json({ id: quizId });
});

app.get('/api/dosen/results/:id', dosenAuth, (req, res) => {
  const quiz = db.prepare(`SELECT * FROM quizzes WHERE id = ?`).get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz tidak ditemukan' });
  const attempts = db.prepare(`SELECT nama, npm, score, correct_count, total_count, created_at FROM attempts WHERE quiz_id = ? ORDER BY score DESC`).all(quiz.id);
  let stats = null;
  if (quiz.pair_key) {
    const pairs = db.prepare(`
      SELECT a.npm, MAX(CASE WHEN q.type = 'pre' THEN a.score END) AS pre, MAX(CASE WHEN q.type = 'post' THEN a.score END) AS post
      FROM attempts a JOIN quizzes q ON q.id = a.quiz_id
      WHERE q.pair_key = ? GROUP BY a.npm`).all(quiz.pair_key);
    const gains = pairs.filter(p => p.pre !== null && p.post !== null).map(p => ({
      ...p,
      ngain: p.pre === 100 ? (p.post >= p.pre ? 1 : 0) : (p.post - p.pre) / (100 - p.pre)
    }));
    if (gains.length) {
      const avg = gains.reduce((s, g) => s + g.ngain, 0) / gains.length;
      stats = { pairs: gains, avg_ngain: Math.round(avg * 100) / 100 };
    }
  }
  res.json({ quiz, attempts, stats });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quiz Unisba jalan di http://localhost:${PORT}`));
