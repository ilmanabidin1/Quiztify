// Quiztify.id - Server Platform (v2.0)
// Platform Kuis Interaktif, Gamifikasi & Asesmen Modern ala Quizizz
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- UTILITIES ----------
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
  const token = parseCookies(req).qu_session || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const s = db.prepare('SELECT role, user_id FROM sessions WHERE token = ?').get(token);
  return s || null;
}

function requireRole(...roles) {
  return (req, res, next) => {
    const a = auth(req);
    const normalizedRoles = roles.flatMap(r => {
      if (r === 'creator' || r === 'dosen') return ['creator', 'dosen'];
      if (r === 'student' || r === 'mahasiswa') return ['student', 'mahasiswa'];
      return [r];
    });
    if (!a || !normalizedRoles.includes(a.role)) {
      return res.status(401).json({ error: 'Akses terbatas. Silakan login terlebih dahulu.' });
    }
    req.auth = a;
    next();
  };
}

// Hake's Normalized Gain (N-Gain)
function ngain(pre, post) {
  if (pre === null || post === null) return null;
  if (pre === 100) return post >= pre ? 1 : 0;
  return Math.max(0, Math.round(((post - pre) / (100 - pre)) * 100) / 100);
}

// ---------- SEED DATA ----------
function seedInitialData() {
  // 1. Akun Creator Default
  const admin = db.prepare('SELECT * FROM dosen WHERE email = ?').get('admin@quiztify.id');
  if (!admin) {
    db.prepare(`INSERT INTO dosen (nama, email, password_hash, plan, institution)
      VALUES (?, ?, ?, 'pro', 'Quiztify Master Lab')`).run(
        'Super Creator Quiztify',
        'admin@quiztify.id',
        hashPassword('quiztify2026')
      );
  }

  // Akun backward compatibility
  const dosenLama = db.prepare('SELECT * FROM dosen WHERE email = ?').get('dosen@unisba.ac.id');
  if (!dosenLama) {
    db.prepare(`INSERT INTO dosen (nama, email, password_hash, plan, institution)
      VALUES (?, ?, ?, 'pro', 'Universitas Islam Bandung')`).run(
        'Dosen Unisba',
        'dosen@unisba.ac.id',
        hashPassword('unisba2026')
      );
  }

  // 2. Sample Kelas
  let defaultClass = db.prepare('SELECT * FROM classes LIMIT 1').get();
  if (!defaultClass) {
    const creator = db.prepare('SELECT id FROM dosen LIMIT 1').get();
    const info = db.prepare('INSERT INTO classes (dosen_id, name, course, code) VALUES (?, ?, ?, ?)').run(
      creator.id, 'Kelas Inovasi Digital 2026', 'Teknologi & Artificial Intelligence', 'QZ-2026'
    );
    defaultClass = { id: info.lastInsertRowid };
  }

  // 3. Sample Demo Quiz ala Quizizz
  const demoQuiz = db.prepare('SELECT * FROM quizzes WHERE title LIKE ?').get('%Kuis Seru%');
  if (!demoQuiz) {
    const creator = db.prepare('SELECT id FROM dosen LIMIT 1').get();
    const qInfo = db.prepare(`INSERT INTO quizzes 
      (class_id, creator_id, title, description, category, type, cover_emoji, time_per_q, points_per_q)
      VALUES (?, ?, ?, ?, ?, 'standard', '🚀', 20, 1000)`).run(
        defaultClass.id,
        creator.id,
        'Kuis Seru: Teknologi, AI & Logika Pintar 🚀',
        'Tantangan kuis kilat seru menguji pemahaman seputar teknologi modern, kecerdasan buatan, dan inovasi web!',
        'Teknologi'
      );
    
    const quizId = qInfo.lastInsertRowid;
    const questions = [
      {
        text: 'Singkatan dari AI dalam dunia teknologi adalah...',
        options: ['Automated Internet', 'Artificial Intelligence', 'Applied Interface', 'Advanced Integration'],
        correct: 1,
        time: 20,
        explanation: 'AI adalah Artificial Intelligence atau Kecerdasan Buatan.'
      },
      {
        text: 'Manakah dari berikut ini yang BUKAN bahasa pemrograman web sisi klien (browser)?',
        options: ['JavaScript', 'HTML & CSS', 'WebAssembly', 'Python (tanpa transpiler)'],
        correct: 3,
        time: 20,
        explanation: 'Browser secara bawaan mengeksekusi HTML, CSS, JavaScript, dan WebAssembly. Python membutuhkan runtime/transpiler.'
      },
      {
        text: 'Metrik evaluasi pembelajaran untuk mengukur peningkatan nilai Pre-Test ke Post-Test disebut...',
        options: ['P-Value Regression', 'Hake\'s Normalized Gain (N-Gain)', 'Standard Deviation', 'Cronbach Alpha'],
        correct: 1,
        time: 20,
        explanation: 'N-Gain (Hake, 1998) mengukur efektivitas peningkatan pemahaman siswa dengan rumus (Post - Pre) / (100 - Pre).'
      },
      {
        text: 'Fitur utama yang membuat platform seperti Quiztify & Quizizz menyenangkan dan memotivasi belajar adalah...',
        options: ['Gamifikasi & Live Feedback', 'Buku teks tebal tanpa gambar', 'Ujian hening 4 jam', 'Absensi kertas manual'],
        correct: 0,
        time: 15,
        explanation: 'Gamifikasi dengan poin kecepatan, streak api, leaderboard, dan feedback langsung terbukti meningkatkan engagement!'
      },
      {
        text: 'Berapa hasil dari 2 pangkat 8 (2^8) dalam komputasi biner/byte?',
        options: ['128', '256', '512', '1024'],
        correct: 1,
        time: 20,
        explanation: '2^8 = 256, yang merupakan jumlah kombinasi nilai dalam 1 byte (0 - 255).'
      }
    ];

    const insQ = db.prepare(`INSERT INTO questions (quiz_id, position, text, options, correct_idx, time_limit, points, explanation)
      VALUES (?, ?, ?, ?, ?, ?, 1000, ?)`);
    questions.forEach((q, idx) => {
      insQ.run(quizId, idx + 1, q.text, JSON.stringify(q.options), q.correct, q.time, q.explanation);
    });
  }
}
seedInitialData();

// ---------- AUTH ENDPOINTS ----------
app.post('/api/auth/creator/login', (req, res) => {
  const { email, password } = req.body || {};
  const d = db.prepare('SELECT * FROM dosen WHERE lower(email) = lower(?)').get(norm(email));
  if (!d || !verifyPassword(password, d.password_hash)) {
    return res.status(401).json({ error: 'Email atau password salah' });
  }
  setSession(res, 'creator', d.id);
  res.json({ id: d.id, nama: d.nama, email: d.email, role: 'creator', plan: d.plan || 'pro', institution: d.institution });
});

// Backward compatible dosen login
app.post('/api/auth/dosen/login', (req, res) => {
  const { email, password } = req.body || {};
  const d = db.prepare('SELECT * FROM dosen WHERE lower(email) = lower(?)').get(norm(email));
  if (!d || !verifyPassword(password, d.password_hash)) {
    return res.status(401).json({ error: 'Email atau password salah' });
  }
  setSession(res, 'dosen', d.id);
  res.json({ id: d.id, nama: d.nama, email: d.email, role: 'creator', plan: d.plan || 'pro' });
});

app.post('/api/auth/creator/register', (req, res) => {
  const { nama, email, password, institution } = req.body || {};
  const n = norm(nama), em = norm(email).toLowerCase(), p = norm(password), inst = norm(institution) || 'Quiztify Academy';
  if (!n || n.length < 2) return res.status(400).json({ error: 'Nama lengkap wajib diisi' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).json({ error: 'Format email tidak valid' });
  if (!p || p.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
  if (db.prepare('SELECT id FROM dosen WHERE lower(email) = ?').get(em)) {
    return res.status(409).json({ error: 'Email sudah terdaftar. Silakan login.' });
  }
  const info = db.prepare(`INSERT INTO dosen (nama, email, password_hash, plan, institution)
    VALUES (?, ?, ?, 'pro', ?)`).run(n, em, hashPassword(p), inst);
  setSession(res, 'creator', info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid, nama: n, email: em, role: 'creator', plan: 'pro', institution: inst });
});

app.post('/api/auth/student/register', (req, res) => {
  const { nama, npm, password, class_id, avatar } = req.body || {};
  const n = norm(nama), m = norm(npm);
  if (!n || n.length < 2) return res.status(400).json({ error: 'Nama lengkap wajib diisi' });
  if (!m || m.length < 3) return res.status(400).json({ error: 'ID/NIM/NISN minimal 3 karakter' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
  
  let classId = Number(class_id) || null;
  if (!classId) {
    const firstClass = db.prepare('SELECT id FROM classes LIMIT 1').get();
    classId = firstClass ? firstClass.id : null;
  }
  if (db.prepare('SELECT id FROM students WHERE npm = ?').get(m)) {
    return res.status(409).json({ error: 'NPM/NISN ini sudah terdaftar, silakan login' });
  }
  const info = db.prepare('INSERT INTO students (class_id, nama, npm, password_hash, avatar) VALUES (?, ?, ?, ?, ?)').run(
    classId, n, m, hashPassword(password), avatar || '🦊'
  );
  setSession(res, 'student', info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid, nama: n, npm: m, class_id: classId, avatar: avatar || '🦊' });
});

// Backward compatible student register
app.post('/api/auth/mahasiswa/register', (req, res) => {
  return app._router.handle({ ...req, url: '/api/auth/student/register' }, res);
});

app.post('/api/auth/student/login', (req, res) => {
  const { npm, password } = req.body || {};
  const s = db.prepare('SELECT * FROM students WHERE npm = ?').get(norm(npm));
  if (!s || !verifyPassword(password, s.password_hash)) {
    return res.status(401).json({ error: 'ID/NIM atau password salah' });
  }
  setSession(res, 'student', s.id);
  res.json({ id: s.id, nama: s.nama, npm: s.npm, class_id: s.class_id, avatar: s.avatar || '🦊', points: s.points || 0 });
});

// Backward compatible student login
app.post('/api/auth/mahasiswa/login', (req, res) => {
  const { npm, password } = req.body || {};
  const s = db.prepare('SELECT * FROM students WHERE npm = ?').get(norm(npm));
  if (!s || !verifyPassword(password, s.password_hash)) {
    return res.status(401).json({ error: 'NPM atau password salah' });
  }
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
  if (a.role === 'creator' || a.role === 'dosen') {
    const d = db.prepare('SELECT id, nama, email, plan, institution FROM dosen WHERE id = ?').get(a.user_id);
    return res.json({ role: 'creator', ...d });
  }
  const s = db.prepare(`SELECT s.id, s.nama, s.npm, s.avatar, s.points, c.id AS class_id, c.name AS class_name, c.course
    FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE s.id = ?`).get(a.user_id);
  res.json({ role: 'student', ...s });
});

// Mock Upgrade Subscription
app.post('/api/subscription/upgrade', requireRole('creator', 'dosen'), (req, res) => {
  const { plan } = req.body || {};
  const targetPlan = ['pro', 'enterprise'].includes(plan) ? plan : 'pro';
  db.prepare('UPDATE dosen SET plan = ? WHERE id = ?').run(targetPlan, req.auth.user_id);
  res.json({ ok: true, plan: targetPlan, message: `Selamat! Akun Quiztify Anda kini berstatus ${targetPlan.toUpperCase()}` });
});

// ---------- LIVE GAME MULTIPLAYER ENGINE (QUIZIZZ-STYLE) ----------

// 1. Host Create Live Room
app.post('/api/rooms/create', requireRole('creator', 'dosen'), async (req, res) => {
  const { quiz_id } = req.body || {};
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(Number(quiz_id));
  if (!quiz) return res.status(404).json({ error: 'Kuis tidak ditemukan' });

  const questionsCount = db.prepare('SELECT COUNT(*) as count FROM questions WHERE quiz_id = ?').get(quiz.id).count;
  if (questionsCount === 0) {
    return res.status(400).json({ error: 'Kuis belum memiliki pertanyaan' });
  }

  // Generate 6 digit PIN unik
  let pin = '';
  let attempts = 0;
  while (attempts < 20) {
    pin = Math.floor(100000 + Math.random() * 900000).toString();
    const exists = db.prepare('SELECT pin FROM game_rooms WHERE pin = ?').get(pin);
    if (!exists) break;
    attempts++;
  }

  db.prepare(`INSERT INTO game_rooms (pin, quiz_id, host_id, status, current_q_idx, q_started_at)
    VALUES (?, ?, ?, 'lobby', 0, 0)`).run(pin, quiz.id, req.auth.user_id);

  const base = process.env.PUBLIC_BASE_URL || req.headers.origin || `http://localhost:${process.env.PORT || 3000}`;
  const joinUrl = `${base.replace(/\/$/, '')}/?pin=${pin}`;
  const qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 280, color: { dark: '#1a103c', light: '#ffffff' } });

  res.json({
    pin,
    join_url: joinUrl,
    qr,
    quiz: { id: quiz.id, title: quiz.title, total_questions: questionsCount }
  });
});

// 2. Player Join Live Room with Game PIN
app.post('/api/rooms/join', (req, res) => {
  const { pin, nickname, avatar } = req.body || {};
  const p = norm(pin);
  const name = norm(nickname);
  if (!p || p.length !== 6) return res.status(400).json({ error: 'PIN Kuis harus 6 digit angka' });
  if (!name || name.length < 2) return res.status(400).json({ error: 'Nama/Nickname minimal 2 karakter' });

  const room = db.prepare('SELECT * FROM game_rooms WHERE pin = ?').get(p);
  if (!room) return res.status(404).json({ error: 'Room Game tidak ditemukan. Periksa kembali PIN Anda!' });
  if (room.status === 'finished') return res.status(400).json({ error: 'Permainan kuis ini telah selesai.' });

  const quiz = db.prepare('SELECT title, cover_emoji FROM quizzes WHERE id = ?').get(room.quiz_id);

  // Buat player token unik
  const playerToken = crypto.randomBytes(16).toString('hex');
  const chosenAvatar = avatar || ['🦁', '🦊', '🚀', '⚡', '🎮', '🦄', '🌟', '🍕'][Math.floor(Math.random() * 8)];

  db.prepare(`INSERT OR REPLACE INTO room_players (pin, player_token, name, avatar, score, streak, updated_at)
    VALUES (?, ?, ?, ?, 0, 0, ?)`).run(p, playerToken, name, chosenAvatar, Date.now());

  res.json({
    ok: true,
    pin: p,
    player_token: playerToken,
    name,
    avatar: chosenAvatar,
    quiz_title: quiz ? quiz.title : 'Quiztify Live',
    cover_emoji: quiz ? quiz.cover_emoji : '⚡'
  });
});

// 3. Room State (Polled by Host & Players)
app.get('/api/rooms/:pin/state', (req, res) => {
  const pin = req.params.pin;
  const playerToken = req.query.player_token;
  const room = db.prepare('SELECT * FROM game_rooms WHERE pin = ?').get(pin);
  if (!room) return res.status(404).json({ error: 'Room tidak ditemukan' });

  const quiz = db.prepare('SELECT id, title, cover_emoji FROM quizzes WHERE id = ?').get(room.quiz_id);
  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY position ASC').all(room.quiz_id);
  const players = db.prepare('SELECT player_token, name, avatar, score, streak, last_correct, last_points FROM room_players WHERE pin = ? ORDER BY score DESC').all(pin);

  const totalQuestions = questions.length;
  const currentQ = questions[room.current_q_idx] || null;

  let myInfo = null;
  if (playerToken) {
    myInfo = players.find(p => p.player_token === playerToken) || null;
  }

  // Hitung leaderboard top 5
  const leaderboard = players.map((p, idx) => ({
    rank: idx + 1,
    name: p.name,
    avatar: p.avatar,
    score: p.score,
    streak: p.streak,
    last_correct: p.last_correct,
    last_points: p.last_points,
    is_me: playerToken ? p.player_token === playerToken : false
  }));

  // Sanitasi data pertanyaan untuk pemain (jangan bocorkan correct_idx saat kuis berjalan)
  let safeQuestion = null;
  if (currentQ) {
    const isReview = room.status === 'leaderboard' || room.status === 'finished';
    safeQuestion = {
      index: room.current_q_idx,
      total: totalQuestions,
      text: currentQ.text,
      options: JSON.parse(currentQ.options || '[]'),
      time_limit: currentQ.time_limit || 20,
      points: currentQ.points || 1000,
      q_started_at: room.q_started_at,
      ...(isReview ? { correct_idx: currentQ.correct_idx, explanation: currentQ.explanation } : {})
    };
  }

  res.json({
    pin: room.pin,
    status: room.status,
    quiz_title: quiz.title,
    current_q_idx: room.current_q_idx,
    total_questions: totalQuestions,
    question: safeQuestion,
    players_count: players.length,
    players: players.map(p => ({ name: p.name, avatar: p.avatar, score: p.score, streak: p.streak })),
    leaderboard: leaderboard.slice(0, 10),
    my_rank: myInfo ? leaderboard.findIndex(l => l.is_me) + 1 : null,
    my_score: myInfo ? myInfo.score : 0,
    my_streak: myInfo ? myInfo.streak : 0
  });
});

// 4. Host Control Action (Start, Next Question, Show Leaderboard, Finish)
app.post('/api/rooms/:pin/control', requireRole('creator', 'dosen'), (req, res) => {
  const pin = req.params.pin;
  const { action } = req.body || {};
  const room = db.prepare('SELECT * FROM game_rooms WHERE pin = ? AND host_id = ?').get(pin, req.auth.user_id);
  if (!room) return res.status(403).json({ error: 'Bukan host room ini' });

  const totalQuestions = db.prepare('SELECT COUNT(*) as c FROM questions WHERE quiz_id = ?').get(room.quiz_id).c;

  if (action === 'start') {
    db.prepare(`UPDATE game_rooms SET status = 'question', current_q_idx = 0, q_started_at = ? WHERE pin = ?`).run(Date.now(), pin);
  } else if (action === 'leaderboard') {
    db.prepare(`UPDATE game_rooms SET status = 'leaderboard' WHERE pin = ?`).run(pin);
  } else if (action === 'next') {
    const nextIdx = room.current_q_idx + 1;
    if (nextIdx >= totalQuestions) {
      db.prepare(`UPDATE game_rooms SET status = 'finished' WHERE pin = ?`).run(pin);
    } else {
      db.prepare(`UPDATE game_rooms SET status = 'question', current_q_idx = ?, q_started_at = ? WHERE pin = ?`).run(nextIdx, Date.now(), pin);
    }
  } else if (action === 'finish') {
    db.prepare(`UPDATE game_rooms SET status = 'finished' WHERE pin = ?`).run(pin);
  }

  res.json({ ok: true, action });
});

// 5. Player Submit Live Answer
app.post('/api/rooms/:pin/answer', (req, res) => {
  const pin = req.params.pin;
  const { player_token, answer_idx, time_spent_ms } = req.body || {};
  const room = db.prepare('SELECT * FROM game_rooms WHERE pin = ?').get(pin);
  if (!room || room.status !== 'question') {
    return res.status(400).json({ error: 'Waktu menjawab telah selesai atau belum dimulai' });
  }

  const player = db.prepare('SELECT * FROM room_players WHERE pin = ? AND player_token = ?').get(pin, player_token);
  if (!player) return res.status(404).json({ error: 'Player tidak ditemukan' });

  const currentQ = db.prepare('SELECT * FROM questions WHERE quiz_id = ? AND position = ?').get(room.quiz_id, room.current_q_idx + 1);
  if (!currentQ) return res.status(404).json({ error: 'Pertanyaan tidak ditemukan' });

  // Cek apakah sudah pernah jawab pertanyaan ini
  const answersMap = JSON.parse(player.answers_json || '{}');
  if (answersMap[room.current_q_idx] !== undefined) {
    return res.status(409).json({ error: 'Kamu sudah menjawab soal ini!' });
  }

  const isCorrect = Number(answer_idx) === currentQ.correct_idx;
  let pointsEarned = 0;
  let newStreak = isCorrect ? (player.streak + 1) : 0;

  if (isCorrect) {
    const basePts = 600;
    const timeLimitMs = (currentQ.time_limit || 20) * 1000;
    const timeRemaining = Math.max(0, timeLimitMs - (Number(time_spent_ms) || 0));
    const speedRatio = Math.min(1, Math.max(0, timeRemaining / timeLimitMs));
    const speedBonus = Math.round(speedRatio * 300);
    const streakBonus = newStreak >= 3 ? 150 : (newStreak >= 2 ? 75 : 0);
    pointsEarned = basePts + speedBonus + streakBonus;
  }

  answersMap[room.current_q_idx] = { answer_idx, is_correct: isCorrect, points: pointsEarned };
  const newScore = player.score + pointsEarned;

  db.prepare(`UPDATE room_players SET 
    score = ?, 
    streak = ?, 
    last_correct = ?, 
    last_points = ?, 
    answers_json = ?,
    updated_at = ?
    WHERE pin = ? AND player_token = ?`).run(
      newScore, newStreak, isCorrect ? 1 : 0, pointsEarned, JSON.stringify(answersMap), Date.now(), pin, player_token
    );

  res.json({
    correct: isCorrect,
    correct_idx: currentQ.correct_idx,
    explanation: currentQ.explanation,
    points_earned: pointsEarned,
    new_score: newScore,
    streak: newStreak
  });
});

// ---------- AI SMART QUIZ GENERATOR ----------
app.post('/api/quizzes/generate-ai', requireRole('creator', 'dosen'), (req, res) => {
  const { topic, count } = req.body || {};
  const t = norm(topic) || 'Teknologi Informasi & Pemrograman';
  const n = Math.min(10, Math.max(3, Number(count) || 5));

  // Cerdas & kontekstual generator bank soal
  const sampleBanks = {
    web: [
      { text: 'Apa peran utama dari protokol HTTPS dibandingkan HTTP standar?', options: ['Mengompresi gambar', 'Enkripsi data melalui SSL/TLS', 'Mempercepat kecepatan internet', 'Menghapus cookies pengguna'], correct: 1, explanation: 'HTTPS mengamankan komunikasi data antara browser dan server dengan enkripsi SSL/TLS.' },
      { text: 'CSS Flexbox dirancang untuk mengatur tata letak elemen secara...', options: ['Tiga dimensi kompleks', 'Satu dimensi (baris atau kolom)', 'Hanya tabel hierarki', 'Animasi video'], correct: 1, explanation: 'Flexbox adalah model layout satu dimensi untuk mendistribusikan ruang di antara item.' },
      { text: 'Dalam JavaScript modern, kata kunci untuk mendeklarasikan variabel bernilai tetap (immutable reference) adalah...', options: ['var', 'let', 'const', 'static'], correct: 2, explanation: 'const digunakan untuk variabel yang referensinya tidak dapat diubah kembali.' }
    ],
    math: [
      { text: 'Berapa nilai dari akar kuadrat 144?', options: ['10', '11', '12', '14'], correct: 2, explanation: '12 x 12 = 144.' },
      { text: 'Berapa jumlah sudut dalam sebuah segitiga datar?', options: ['90 derajat', '180 derajat', '270 derajat', '360 derajat'], correct: 1, explanation: 'Total jumlah sudut segitiga Euclidean selalu 180 derajat.' }
    ],
    general: [
      { text: `Konsep dasar yang paling esensial dalam topik "${t}" adalah...`, options: ['Pemahaman fondasi dan teori utama', 'Hafalan tanpa penerapan', 'Meninggalkan dokumentasi resmi', 'Melakukan tindakan tanpa rencana'], correct: 0, explanation: `Memahami fondasi teori dan metodologi sangat krusial dalam menguasai ${t}.` },
      { text: `Manakah strategi terbaik untuk mengevaluasi hasil pembelajaran ${t}?`, options: ['Mengabaikan umpan balik peserta', 'Asesmen formatif berkala & analisis N-Gain', 'Hanya mengadakan ujian sekali di awal', 'Tidak memberikan kunci jawaban'], correct: 1, explanation: 'Asesmen berkala dan pengukuran gain efektivitas memberikan wawasan pembelajaran terbaik.' },
      { text: `Tantangan terbesar yang sering dihadapi praktisi saat mengimplementasikan ${t} adalah...`, options: ['Adaptasi terhadap perubahan & konsistensi', 'Terlalu banyak waktu luang', 'Tidak adanya referensi ilmiah', 'Biaya internet gratis'], correct: 0, explanation: 'Konsistensi dan adaptasi terhadap perkembangan baru merupakan kunci sukses keberlanjutan.' },
      { text: `Langkah awal yang paling tepat dalam menyusun strategi pembelajaran ${t} interaktif adalah...`, options: ['Menentukan tujuan capaian pembelajaran (LO)', 'Langsung memberi hukuman jika salah', 'Menutup sesi tanya jawab', 'Membagikan materi tanpa penjelasan'], correct: 0, explanation: 'Perumusan Learning Outcomes (Capaian Pembelajaran) mengarahkan seluruh materi dan soal kuis.' },
      { text: `Indikator keberhasilan dari penerapan inovasi pada domain ${t} terlihat dari...`, options: ['Peningkatan efisiensi, akurasi, dan pemahaman', 'Penurunan motivasi peserta', 'Stagnasi data', 'Meningkatnya keluhan pengguna'], correct: 0, explanation: 'Peningkatan efisiensi dan pemahaman terukur menandai keberhasilan inovasi.' }
    ]
  };

  const lowerT = t.toLowerCase();
  let selected = sampleBanks.general;
  if (lowerT.includes('web') || lowerT.includes('coding') || lowerT.includes('js') || lowerT.includes('program')) {
    selected = [...sampleBanks.web, ...sampleBanks.general];
  } else if (lowerT.includes('matematika') || lowerT.includes('hitung')) {
    selected = [...sampleBanks.math, ...sampleBanks.general];
  }

  const resultQuestions = [];
  for (let i = 0; i < n; i++) {
    const q = selected[i % selected.length];
    resultQuestions.push({
      text: q.text.replace(/\{t\}/g, t),
      options: q.options,
      correct: q.correct,
      time_limit: 20,
      points: 1000,
      explanation: q.explanation
    });
  }

  res.json({
    topic: t,
    generated_count: resultQuestions.length,
    questions: resultQuestions
  });
});

// ---------- QUIZ & CLASS MANAGEMENT (CREATOR) ----------

app.get('/api/creator/quizzes', requireRole('creator', 'dosen'), (req, res) => {
  const rows = db.prepare(`SELECT q.*, 
    c.name as class_name,
    (SELECT COUNT(*) FROM questions WHERE quiz_id = q.id) as question_count,
    (SELECT COUNT(*) FROM attempts WHERE quiz_id = q.id) as attempt_count,
    (SELECT AVG(score) FROM attempts WHERE quiz_id = q.id) as avg_score
    FROM quizzes q 
    LEFT JOIN classes c ON c.id = q.class_id
    WHERE q.creator_id = ? OR q.creator_id IS NULL
    ORDER BY q.created_at DESC`).all(req.auth.user_id);
  res.json(rows);
});

// Backward compatible dosen quiz list
app.get('/api/dosen/classes', requireRole('creator', 'dosen'), (req, res) => {
  res.json(db.prepare(`SELECT c.id, c.name, c.course, c.code, c.created_at,
      (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS n_students,
      (SELECT COUNT(*) FROM quizzes q WHERE q.class_id = c.id) AS n_quizzes
    FROM classes c WHERE c.dosen_id = ? ORDER BY c.created_at DESC`).all(req.auth.user_id));
});

app.post('/api/dosen/classes', requireRole('creator', 'dosen'), (req, res) => {
  const { name, course } = req.body || {};
  if (!norm(name)) return res.status(400).json({ error: 'Nama kelas wajib diisi' });
  const code = 'QZ-' + Math.floor(1000 + Math.random() * 9000);
  const info = db.prepare('INSERT INTO classes (dosen_id, name, course, code) VALUES (?, ?, ?, ?)').run(
    req.auth.user_id, norm(name), norm(course || ''), code
  );
  res.json({ id: info.lastInsertRowid, code });
});

app.delete('/api/dosen/classes/:id', requireRole('creator', 'dosen'), (req, res) => {
  const c = db.prepare('SELECT id FROM classes WHERE id = ? AND dosen_id = ?').get(req.params.id, req.auth.user_id);
  if (!c) return res.status(404).json({ error: 'Kelas tidak ditemukan' });
  db.prepare('DELETE FROM classes WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

app.get('/api/dosen/classes/:id/students', requireRole('creator', 'dosen'), (req, res) => {
  const c = db.prepare('SELECT id FROM classes WHERE id = ? AND dosen_id = ?').get(req.params.id, req.auth.user_id);
  if (!c) return res.status(404).json({ error: 'Kelas tidak ditemukan' });
  res.json(db.prepare('SELECT id, nama, npm, avatar, points, created_at FROM students WHERE class_id = ? ORDER BY nama').all(c.id));
});

// Create Quiz (Studio Pro)
app.post('/api/dosen/quizzes', requireRole('creator', 'dosen'), (req, res) => {
  const { class_id, title, description, category, type, duration_min, time_per_q, deadline, pair_key, cover_emoji, questions } = req.body || {};
  if (!norm(title)) return res.status(400).json({ error: 'Judul kuis wajib diisi' });
  if (!Array.isArray(questions) || questions.length === 0) return res.status(400).json({ error: 'Minimal 1 soal' });

  const qType = ['pre', 'post', 'standard'].includes(type) ? type : 'standard';
  const cEmoji = cover_emoji || '⚡';

  for (const q of questions) {
    if (!norm(q.text) || !Array.isArray(q.options) || q.options.length < 2 || q.options.some(o => !norm(o))) {
      return res.status(400).json({ error: 'Tiap soal butuh teks dan minimal 2 opsi jawaban terisi' });
    }
    if (!(Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length)) {
      return res.status(400).json({ error: 'Kunci jawaban belum dipilih untuk semua soal' });
    }
  }

  const classId = class_id ? Number(class_id) : null;
  const info = db.prepare(`INSERT INTO quizzes 
    (class_id, creator_id, title, description, category, type, duration_min, time_per_q, deadline, pair_key, cover_emoji)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      classId,
      req.auth.user_id,
      norm(title),
      norm(description || ''),
      norm(category || 'Umum'),
      qType,
      Number(duration_min) || null,
      Number(time_per_q) || 30,
      deadline ? new Date(deadline).toISOString() : null,
      norm(pair_key) || null,
      cEmoji
    );

  const quizId = info.lastInsertRowid;
  const ins = db.prepare(`INSERT INTO questions 
    (quiz_id, position, text, options, correct_idx, time_limit, points, explanation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    ins.run(
      quizId,
      i + 1,
      norm(q.text),
      JSON.stringify(q.options),
      q.correct,
      Number(q.time_limit) || Number(time_per_q) || 30,
      Number(q.points) || 1000,
      norm(q.explanation || '')
    );
  }

  res.json({ id: quizId, ok: true });
});

app.get('/api/dosen/quizzes/:id/details', requireRole('creator', 'dosen'), (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Kuis tidak ditemukan' });
  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY position ASC').all(quiz.id);
  res.json({
    ...quiz,
    questions: questions.map(q => ({
      ...q,
      options: JSON.parse(q.options || '[]')
    }))
  });
});

app.delete('/api/dosen/quizzes/:id', requireRole('creator', 'dosen'), (req, res) => {
  const q = db.prepare('SELECT id FROM quizzes WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Kuis tidak ditemukan' });
  db.prepare('DELETE FROM quizzes WHERE id = ?').run(q.id);
  res.json({ ok: true });
});

// QR Code Kuis Asinkron / Langsung
app.get('/api/dosen/quizzes/:id/qr', requireRole('creator', 'dosen'), (req, res) => {
  const q = db.prepare('SELECT id, title FROM quizzes WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Quiz tidak ditemukan' });
  const base = process.env.PUBLIC_BASE_URL || req.headers.origin || `http://localhost:${process.env.PORT || 3000}`;
  const url = `${base.replace(/\/$/, '')}/?quiz=${q.id}`;
  QRCode.toDataURL(url, { margin: 1, width: 320, color: { dark: '#1a103c', light: '#ffffff' } }, (err, dataUrl) => {
    if (err) return res.status(500).json({ error: 'Gagal membuat QR' });
    res.json({ url, qr: dataUrl, title: q.title });
  });
});

// Analisis Hasil Kelas & N-Gain
app.get('/api/dosen/classes/:id/results', requireRole('creator', 'dosen'), (req, res) => {
  const c = db.prepare('SELECT id, name, course FROM classes WHERE id = ? AND dosen_id = ?').get(req.params.id, req.auth.user_id);
  if (!c) return res.status(404).json({ error: 'Kelas tidak ditemukan' });

  const quizzes = db.prepare(`SELECT q.*, (SELECT COUNT(*) FROM attempts a WHERE a.quiz_id = q.id) AS n_attempts
    FROM quizzes q WHERE q.class_id = ? ORDER BY q.created_at DESC`).all(c.id);
  const students = db.prepare('SELECT id, nama, npm, avatar, points FROM students WHERE class_id = ? ORDER BY nama').all(c.id);
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
    const pairs = Object.entries(byStudent[s.id] || {}).map(([key, p]) => ({
      key,
      pre: p.pre ?? null,
      post: p.post ?? null,
      ngain: ngain(p.pre ?? null, p.post ?? null)
    }));
    const gains = pairs.filter(p => p.ngain !== null).map(p => p.ngain);
    return {
      ...s,
      pairs,
      avg_ngain: gains.length ? Math.round((gains.reduce((a, b) => a + b, 0) / gains.length) * 100) / 100 : null
    };
  });

  const g = rows.filter(r => r.avg_ngain !== null);
  const classAvgNgain = g.length ? Math.round((g.reduce((a, b) => a + b.avg_ngain, 0) / g.length) * 100) / 100 : null;

  res.json({
    class_name: c.name,
    quizzes,
    students: rows,
    class_avg_ngain: classAvgNgain
  });
});

// Ekspor Rekap Nilai CSV
app.get('/api/classes/:id/export-csv', requireRole('creator', 'dosen'), (req, res) => {
  const c = db.prepare('SELECT id, name FROM classes WHERE id = ? AND dosen_id = ?').get(req.params.id, req.auth.user_id);
  if (!c) return res.status(404).send('Kelas tidak ditemukan');

  const students = db.prepare('SELECT id, nama, npm FROM students WHERE class_id = ? ORDER BY nama').all(c.id);
  const quizzes = db.prepare('SELECT id, title, type, pair_key FROM quizzes WHERE class_id = ?').all(c.id);
  const attempts = db.prepare(`SELECT a.student_id, a.quiz_id, a.score FROM attempts a 
    JOIN quizzes q ON q.id = a.quiz_id WHERE q.class_id = ?`).all(c.id);

  const attemptMap = {};
  attempts.forEach(a => {
    attemptMap[`${a.student_id}_${a.quiz_id}`] = a.score;
  });

  let csv = 'Nama Lengkap,ID/NPM,' + quizzes.map(q => `"${q.title} (${q.type})"`).join(',') + ',Rata-Rata Nilai\n';
  students.forEach(s => {
    let total = 0, count = 0;
    const scores = quizzes.map(q => {
      const val = attemptMap[`${s.id}_${q.id}`];
      if (val !== undefined) {
        total += val;
        count++;
        return val;
      }
      return '-';
    });
    const avg = count > 0 ? Math.round(total / count) : 0;
    csv += `"${s.nama}","${s.npm}",` + scores.join(',') + `,${avg}\n`;
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Rekap_Nilai_${c.name.replace(/[^a-zA-Z0-9]/g, '_')}.csv"`);
  res.send(csv);
});

// ---------- STUDENT ASYNC QUIZ & GRADEBOOK ----------

function requireStudent(req, res, next) {
  const a = auth(req);
  if (!a || (a.role !== 'mahasiswa' && a.role !== 'student')) {
    return res.status(401).json({ error: 'Harus login sebagai mahasiswa/siswa' });
  }
  req.student = db.prepare('SELECT * FROM students WHERE id = ?').get(a.user_id);
  if (!req.student) return res.status(401).json({ error: 'Data profil siswa tidak ditemukan' });
  next();
}

app.get('/api/student/quizzes', requireStudent, (req, res) => {
  const rows = db.prepare(`SELECT q.id, q.title, q.description, q.category, q.type, q.cover_emoji, q.duration_min, q.deadline, q.pair_key
    FROM quizzes q 
    WHERE (q.class_id = ? OR q.class_id IS NULL OR q.is_public = 1) AND q.active = 1 
    ORDER BY q.created_at DESC`).all(req.student.class_id || 0);

  const done = db.prepare('SELECT quiz_id, score FROM attempts WHERE student_id = ?').all(req.student.id);
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
  if (!quiz) return res.status(404).json({ error: 'Kuis tidak ditemukan' });

  if (quiz.class_id && req.student.class_id && quiz.class_id !== req.student.class_id) {
    return res.status(403).json({ error: 'Kuis ini bukan untuk kelas Anda' });
  }

  if (db.prepare('SELECT id FROM attempts WHERE quiz_id = ? AND student_id = ?').get(quiz.id, req.student.id)) {
    return res.status(409).json({ error: 'Anda sudah mengerjakan kuis ini sebelumnya' });
  }

  const qs = db.prepare('SELECT id, position, text, options, time_limit, points FROM questions WHERE quiz_id = ? ORDER BY position').all(quiz.id);
  res.json({
    id: quiz.id,
    title: quiz.title,
    description: quiz.description,
    type: quiz.type,
    duration_min: quiz.duration_min,
    questions: qs.map(q => ({
      id: q.id,
      position: q.position,
      text: q.text,
      options: JSON.parse(q.options || '[]'),
      time_limit: q.time_limit || 30,
      points: q.points || 1000
    }))
  });
});

app.post('/api/student/quiz/:id/submit', requireStudent, (req, res) => {
  const { answers, time_spent_sec } = req.body || {};
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ? AND active = 1').get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Kuis tidak ditemukan' });

  const qs = db.prepare('SELECT id, correct_idx, explanation FROM questions WHERE quiz_id = ?').all(quiz.id);
  let correct = 0;
  const review = [];

  for (const q of qs) {
    const studentAns = answers ? Number(answers[q.id]) : null;
    const isOk = studentAns === q.correct_idx;
    if (isOk) correct++;
    review.push({
      question_id: q.id,
      correct: isOk,
      correct_idx: q.correct_idx,
      student_answer: studentAns,
      explanation: q.explanation
    });
  }

  const score = qs.length ? Math.round((correct / qs.length) * 100) : 0;

  try {
    db.prepare(`INSERT INTO attempts (quiz_id, student_id, score, correct_count, total_count, answers, time_spent_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        quiz.id, req.student.id, score, correct, qs.length, JSON.stringify(answers || {}), Number(time_spent_sec) || 0
      );
    // Tambah points gamifikasi ke student
    db.prepare('UPDATE students SET points = points + ? WHERE id = ?').run(score * 10, req.student.id);
  } catch (e) {
    return res.status(409).json({ error: 'Kuis ini sudah tersimpan dalam riwayat Anda' });
  }

  let gain = null;
  if (quiz.pair_key) {
    const pair = db.prepare(`SELECT q.type, a.score FROM attempts a JOIN quizzes q ON q.id = a.quiz_id
      WHERE a.student_id = ? AND q.pair_key = ?`).all(req.student.id, quiz.pair_key);
    const pre = pair.find(p => p.type === 'pre');
    const post = pair.find(p => p.type === 'post');
    if (pre && post) gain = ngain(pre.score, post.score);
  }

  res.json({
    score,
    correct,
    total: qs.length,
    ngain: gain,
    review
  });
});

app.get('/api/student/results', requireStudent, (req, res) => {
  const rows = db.prepare(`SELECT q.id AS quiz_id, q.title, q.type, q.pair_key, a.score, a.correct_count, a.total_count, a.created_at
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

// Public Classes List
app.get('/api/classes/public', (req, res) => {
  res.json(db.prepare(`SELECT c.id, c.name, c.course, c.code, COUNT(s.id) AS n_students
    FROM classes c LEFT JOIN students s ON s.class_id = c.id GROUP BY c.id ORDER BY c.created_at DESC`).all());
});

// Default Fallback
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Quiztify.id jalan di http://localhost:${PORT}`));
