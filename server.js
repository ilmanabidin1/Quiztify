// Quiztify.id - Server Platform (v2.0)
// Platform Kuis Interaktif, Gamifikasi & Asesmen Modern ala Quizizz
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const db = require('./db');

// Load environment variables from .env if present (Local / Dev)
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  try {
    const rawEnv = fs.readFileSync(envFile, 'utf8');
    for (const line of rawEnv.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const k = trimmed.slice(0, eqIdx).trim();
          const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          if (!process.env[k]) process.env[k] = v;
        }
      }
    }
  } catch (_) {}
}

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

// Konversi Nilai Angka ke Nilai Mutu Huruf Akademik (A, B, C, D, E)
function getLetterGrade(score) {
  if (score === null || score === undefined || isNaN(score)) return { grade: '-', label: 'Belum Ada Nilai', status: 'Pending' };
  if (score >= 85) return { grade: 'A', label: 'Sangat Baik', status: 'Lulus' };
  if (score >= 75) return { grade: 'B', label: 'Baik', status: 'Lulus' };
  if (score >= 65) return { grade: 'C', label: 'Cukup', status: 'Lulus' };
  if (score >= 50) return { grade: 'D', label: 'Kurang', status: 'Remedial' };
  return { grade: 'E', label: 'Gagal / Tidak Lulus', status: 'Tidak Lulus' };
}

// ---------- SEED DATA ----------
function seedInitialData() {
  // Guard: only seed on first startup. If the students table already has
  // records (e.g. from a previous deploy with a persistent volume), skip
  // seeding entirely to avoid UNIQUE constraint violations (students.npm).
  const existingStudents = db.prepare('SELECT COUNT(*) as c FROM students').get().c;
  if (existingStudents > 0) {
    return;
  }

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

  // 4. Sample Siswa & Attempts untuk Kelas
  const studentCount = db.prepare('SELECT COUNT(*) as c FROM students WHERE class_id = ?').get(defaultClass.id).c;
  if (studentCount === 0) {
    const sampleStudents = [
      { nama: 'Budi Santoso', npm: '10020101', avatar: '🦁', score1: 100, score2: 90 },
      { nama: 'Siti Rahma', npm: '10020102', avatar: '🦊', score1: 80, score2: 85 },
      { nama: 'Ahmad Fauzi', npm: '10020103', avatar: '🚀', score1: 60, score2: 70 },
      { nama: 'Dewi Lestari', npm: '10020104', avatar: '🦄', score1: 90, score2: 95 }
    ];
    const insStudent = db.prepare('INSERT INTO students (class_id, nama, npm, password_hash, avatar, points) VALUES (?, ?, ?, ?, ?, ?)');
    const insAttempt = db.prepare('INSERT INTO attempts (quiz_id, student_id, score, correct_count, total_count, answers, time_spent_sec) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const quiz1 = db.prepare('SELECT id FROM quizzes WHERE class_id = ? LIMIT 1').get(defaultClass.id);

    // Buat kuis kedua (Kuis 2: Pemrograman Web Modern)
    const creator = db.prepare('SELECT id FROM dosen LIMIT 1').get();
    let quiz2 = db.prepare('SELECT id FROM quizzes WHERE title LIKE ?').get('%Kuis 2%');
    let q2Id = quiz2 ? quiz2.id : null;
    if (!quiz2) {
      const q2Info = db.prepare(`INSERT INTO quizzes 
        (class_id, creator_id, title, description, category, type, cover_emoji, time_per_q, points_per_q)
        VALUES (?, ?, ?, ?, ?, 'standard', '💻', 20, 1000)`).run(
          defaultClass.id,
          creator.id,
          'Kuis 2: Fondasi Web & REST API 💻',
          'Evaluasi pemahaman konsep HTTP methods, routing, dan frontend modern.',
          'Pemrograman'
        );
      q2Id = q2Info.lastInsertRowid;
      const insQ2 = db.prepare(`INSERT INTO questions (quiz_id, position, text, options, correct_idx, time_limit, points, explanation) VALUES (?, ?, ?, ?, ?, ?, 1000, ?)`);
      insQ2.run(q2Id, 1, 'HTTP status code yang menandakan request berhasil adalah...', JSON.stringify(['200 OK', '404 Not Found', '500 Server Error', '301 Moved']), 0, 20, '200 OK menandakan request sukses.');
      insQ2.run(q2Id, 2, 'Metode HTTP yang lazim digunakan untuk memperbarui sebagian data adalah...', JSON.stringify(['POST', 'PATCH', 'GET', 'DELETE']), 1, 20, 'PATCH untuk partial update.');
      insQ2.run(q2Id, 3, 'Format pertukaran data standar web paling populer adalah...', JSON.stringify(['JSON', 'XML', 'CSV', 'YAML']), 0, 20, 'JSON adalah format paling banyak dipakai di REST API.');
    }

    sampleStudents.forEach(s => {
      const info = insStudent.run(defaultClass.id, s.nama, s.npm, hashPassword('student123'), s.avatar, s.score1 * 10);
      const studentId = info.lastInsertRowid;
      if (quiz1) {
        insAttempt.run(quiz1.id, studentId, s.score1, Math.round((s.score1 / 100) * 5), 5, '{}', 45);
      }
      if (q2Id) {
        insAttempt.run(q2Id, studentId, s.score2, Math.round((s.score2 / 100) * 3), 3, '{}', 35);
      }
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

// ---------- LIVE GAME ROOM SYSTEM (INTERACTIVE & STUDENT-PACED ALA QUIZIZZ) ----------

// In-Memory Real-Time Social Reactions & Hype Events Store (Ring Buffer per PIN)
const roomReactionsStore = new Map(); // pin -> Array<{ id, player_name, avatar, emoji, text, created_at }>
const roomEventsStore = new Map(); // pin -> Array<{ id, type, text, avatar, created_at }>
let reactionCounter = 1;
let eventCounter = 1;

function pushRoomReaction(pin, reaction) {
  if (!roomReactionsStore.has(pin)) roomReactionsStore.set(pin, []);
  const list = roomReactionsStore.get(pin);
  const item = { id: reactionCounter++, ...reaction, created_at: Date.now() };
  list.push(item);
  // Keep last 40 reactions, discard older
  if (list.length > 40) list.splice(0, list.length - 40);
  return item;
}

function pushRoomSocialEvent(pin, event) {
  if (!roomEventsStore.has(pin)) roomEventsStore.set(pin, []);
  const list = roomEventsStore.get(pin);
  const item = { id: eventCounter++, ...event, created_at: Date.now() };
  list.push(item);
  // Keep last 30 events, discard older
  if (list.length > 30) list.splice(0, list.length - 30);
  return item;
}

// 0. Check Active Live Room for Host (Persistent Reconnection)
app.get('/api/rooms/active', requireRole('creator', 'dosen'), (req, res) => {
  const activeRoom = db.prepare(`
    SELECT r.*, q.title as quiz_title,
      (SELECT COUNT(*) FROM questions WHERE quiz_id = r.quiz_id) as total_questions,
      (SELECT COUNT(*) FROM room_players WHERE pin = r.pin) as players_count
    FROM game_rooms r
    JOIN quizzes q ON q.id = r.quiz_id
    WHERE r.host_id = ? AND r.status != 'finished'
    ORDER BY r.created_at DESC
    LIMIT 1
  `).get(req.auth.user_id);

  if (!activeRoom) {
    return res.json({ has_active: false });
  }

  res.json({
    has_active: true,
    room: {
      pin: activeRoom.pin,
      status: activeRoom.status,
      quiz_id: activeRoom.quiz_id,
      quiz_title: activeRoom.quiz_title,
      total_questions: activeRoom.total_questions,
      players_count: activeRoom.players_count,
      game_mode: activeRoom.game_mode || 'self_paced',
      created_at: activeRoom.created_at
    }
  });
});

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

  // Tutup room lama milik host jika ada yang masih aktif
  db.prepare("UPDATE game_rooms SET status = 'finished' WHERE host_id = ? AND status != 'finished'").run(req.auth.user_id);

  db.prepare(`INSERT INTO game_rooms (pin, quiz_id, host_id, status, current_q_idx, q_started_at, game_mode)
    VALUES (?, ?, ?, 'lobby', 0, 0, 'self_paced')`).run(pin, quiz.id, req.auth.user_id);

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

// 1b. Host Reopen / Resume Live Room
app.post('/api/rooms/:pin/reopen', requireRole('creator', 'dosen'), async (req, res) => {
  const pin = req.params.pin;
  const room = db.prepare(`
    SELECT r.*, q.title as quiz_title 
    FROM game_rooms r 
    JOIN quizzes q ON q.id = r.quiz_id 
    WHERE r.pin = ? AND r.host_id = ?
  `).get(pin, req.auth.user_id);

  if (!room) return res.status(404).json({ error: 'Room tidak ditemukan atau Anda bukan host' });

  const questionsCount = db.prepare('SELECT COUNT(*) as count FROM questions WHERE quiz_id = ?').get(room.quiz_id).count;
  const base = process.env.PUBLIC_BASE_URL || req.headers.origin || `http://localhost:${process.env.PORT || 3000}`;
  const joinUrl = `${base.replace(/\/$/, '')}/?pin=${pin}`;
  const qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 280, color: { dark: '#1a103c', light: '#ffffff' } });

  res.json({
    ok: true,
    pin: room.pin,
    status: room.status,
    join_url: joinUrl,
    qr,
    quiz: { id: room.quiz_id, title: room.quiz_title, total_questions: questionsCount }
  });
});

// 1c. Host End Live Room Session
app.post('/api/rooms/:pin/end', requireRole('creator', 'dosen'), (req, res) => {
  const pin = req.params.pin;
  const room = db.prepare('SELECT * FROM game_rooms WHERE pin = ? AND host_id = ?').get(pin, req.auth.user_id);
  if (!room) return res.status(403).json({ error: 'Bukan host room ini' });

  db.prepare("UPDATE game_rooms SET status = 'finished' WHERE pin = ?").run(pin);
  res.json({ ok: true, status: 'finished' });
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

  const quiz = db.prepare('SELECT title, cover_emoji, exam_mode FROM quizzes WHERE id = ?').get(room.quiz_id);

  // Buat player token unik
  const playerToken = crypto.randomBytes(16).toString('hex');
  const chosenAvatar = avatar || ['🦁', '🦊', '🚀', '⚡', '🎮', '🦄', '🌟', '🍕'][Math.floor(Math.random() * 8)];

  db.prepare(`INSERT OR REPLACE INTO room_players (pin, player_token, name, avatar, score, streak, current_q_idx, finished, answers_json, tab_switches, updated_at)
    VALUES (?, ?, ?, ?, 0, 0, 0, 0, '{}', 0, ?)`).run(p, playerToken, name, chosenAvatar, Date.now());

  res.json({
    ok: true,
    pin: p,
    player_token: playerToken,
    name,
    avatar: chosenAvatar,
    quiz_title: quiz ? quiz.title : 'Quiztify Live',
    cover_emoji: quiz ? quiz.cover_emoji : '⚡',
    exam_mode: quiz ? (quiz.exam_mode || 0) : 0
  });
});

// 2b. Integrity Proctoring Flag (Tab Switch & Focus Lost Tracking)
app.post('/api/rooms/:pin/integrity-flag', (req, res) => {
  const pin = req.params.pin;
  const { player_token, reason } = req.body || {};
  const room = db.prepare('SELECT * FROM game_rooms WHERE pin = ?').get(pin);
  if (!room || room.status !== 'question') {
    return res.status(400).json({ error: 'Kuis tidak aktif' });
  }

  const player = db.prepare('SELECT * FROM room_players WHERE pin = ? AND player_token = ?').get(pin, player_token);
  if (!player) return res.status(404).json({ error: 'Player tidak ditemukan' });

  const currentSwitches = Number(player.tab_switches) || 0;
  const newSwitches = currentSwitches + 1;

  db.prepare('UPDATE room_players SET tab_switches = ?, updated_at = ? WHERE pin = ? AND player_token = ?').run(
    newSwitches, Date.now(), pin, player_token
  );

  res.json({ ok: true, tab_switches: newSwitches, reason: reason || 'tab_switch' });
});

// 3. Room State (Polled by Host & Players with Live A, B, C, D Distribution & Self-Paced Progress)
app.get('/api/rooms/:pin/state', (req, res) => {
  const pin = req.params.pin;
  const playerToken = req.query.player_token;
  const room = db.prepare('SELECT * FROM game_rooms WHERE pin = ?').get(pin);
  if (!room) return res.status(404).json({ error: 'Room tidak ditemukan' });

  const quiz = db.prepare('SELECT id, title, cover_emoji, exam_mode FROM quizzes WHERE id = ?').get(room.quiz_id);
  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY position ASC').all(room.quiz_id);
  const players = db.prepare('SELECT * FROM room_players WHERE pin = ? ORDER BY score DESC, updated_at ASC').all(pin);

  const totalQuestions = questions.length;

  // Hitung Distribusi Jawaban Pilihan A, B, C, D untuk Host secara Realtime
  const answersDistribution = {};
  for (let i = 0; i < totalQuestions; i++) {
    answersDistribution[i] = { 0: 0, 1: 0, 2: 0, 3: 0, total: 0 };
  }

  let totalFinishedPlayers = 0;
  const playersProgress = players.map(p => {
    const answersMap = JSON.parse(p.answers_json || '{}');
    const answeredCount = Object.keys(answersMap).length;
    const isFinished = Boolean(p.finished || (totalQuestions > 0 && answeredCount >= totalQuestions));
    if (isFinished) totalFinishedPlayers++;

    for (const [qIdxStr, ans] of Object.entries(answersMap)) {
      const qIdx = Number(qIdxStr);
      if (answersDistribution[qIdx] && ans.answer_idx !== undefined) {
        const optIdx = Number(ans.answer_idx);
        if (answersDistribution[qIdx][optIdx] !== undefined) {
          answersDistribution[qIdx][optIdx]++;
          answersDistribution[qIdx].total++;
        }
      }
    }

    const progressPct = totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 0;
    const switches = Number(p.tab_switches) || 0;
    return {
      player_token: p.player_token,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      streak: p.streak,
      current_q_idx: p.current_q_idx || 0,
      answered_count: answeredCount,
      total_questions: totalQuestions,
      pct: progressPct,
      progress_pct: progressPct,
      finished: isFinished,
      is_finished: isFinished,
      tab_switches: switches,
      integrity_status: switches >= 3 ? 'warning' : (switches >= 1 ? 'caution' : 'clean')
    };
  });

  // Hitung Leaderboard Top Ranking
  const leaderboard = players.map((p, idx) => {
    const switches = Number(p.tab_switches) || 0;
    return {
      rank: idx + 1,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      streak: p.streak,
      last_correct: p.last_correct,
      last_points: p.last_points,
      is_finished: Boolean(p.finished || (totalQuestions > 0 && Object.keys(JSON.parse(p.answers_json || '{}')).length >= totalQuestions)),
      is_me: playerToken ? p.player_token === playerToken : false,
      tab_switches: switches,
      integrity_status: switches >= 3 ? 'warning' : (switches >= 1 ? 'caution' : 'clean')
    };
  });

  // Sanitasi & Personalisasi Pertanyaan untuk Pemain (Student-Paced Self Progression)
  let playerQuestion = null;
  let isPlayerFinished = false;
  let myInfo = null;

  if (playerToken) {
    myInfo = players.find(p => p.player_token === playerToken) || null;
    if (myInfo) {
      const answersMap = JSON.parse(myInfo.answers_json || '{}');
      const playerQIdx = Number(myInfo.current_q_idx) || 0;
      isPlayerFinished = Boolean(myInfo.finished || (totalQuestions > 0 && playerQIdx >= totalQuestions));

      if (room.status === 'question' && !isPlayerFinished) {
        const qData = questions[playerQIdx];
        if (qData) {
          playerQuestion = {
            index: playerQIdx,
            total: totalQuestions,
            text: qData.text,
            options: JSON.parse(qData.options || '[]'),
            time_limit: qData.time_limit || 20,
            points: qData.points || 1000,
            has_answered: answersMap[playerQIdx] !== undefined
          };
        }
      }
    }
  }

  // Data Soal Lengkap untuk Layar Host / Projector
  const hostQuestions = questions.map((q, idx) => ({
    index: idx,
    total: totalQuestions,
    text: q.text,
    options: JSON.parse(q.options || '[]'),
    correct_idx: q.correct_idx,
    explanation: q.explanation,
    time_limit: q.time_limit || 20,
    points: q.points || 1000,
    distribution: answersDistribution[idx] || { 0: 0, 1: 0, 2: 0, 3: 0, total: 0 }
  }));

  // Interaksi Sosial Real-Time
  const sinceReactionId = Number(req.query.since_reaction_id) || 0;
  const sinceEventId = Number(req.query.since_event_id) || 0;

  const allReactions = roomReactionsStore.get(pin) || [];
  const recentReactions = allReactions.filter(r => r.id > sinceReactionId && (Date.now() - r.created_at < 12000));

  const allEvents = roomEventsStore.get(pin) || [];
  const recentEvents = allEvents.filter(e => e.id > sinceEventId && (Date.now() - e.created_at < 15000));

  res.json({
    pin: room.pin,
    status: room.status,
    game_mode: room.game_mode || 'self_paced',
    quiz_id: room.quiz_id,
    quiz_title: quiz.title,
    total_questions: totalQuestions,
    // Informasi untuk Pemain
    question: playerQuestion,
    player_finished: isPlayerFinished,
    my_rank: myInfo ? leaderboard.findIndex(l => l.is_me) + 1 : null,
    my_score: myInfo ? myInfo.score : 0,
    my_streak: myInfo ? myInfo.streak : 0,
    // Informasi untuk Host
    players_count: players.length,
    players: players.map(p => ({ name: p.name, avatar: p.avatar, score: p.score, streak: p.streak })),
    players_progress: playersProgress,
    total_finished_players: totalFinishedPlayers,
    answers_distribution: answersDistribution,
    host_questions: hostQuestions,
    leaderboard: leaderboard.slice(0, 15),
    // Interaksi Sosial Real-Time
    recent_reactions: recentReactions,
    recent_events: recentEvents,
    last_reaction_id: allReactions.length > 0 ? allReactions[allReactions.length - 1].id : 0,
    last_event_id: allEvents.length > 0 ? allEvents[allEvents.length - 1].id : 0
  });
});

// 4. Host Control Action (Start, Leaderboard, Finish)
app.post('/api/rooms/:pin/control', requireRole('creator', 'dosen'), (req, res) => {
  const pin = req.params.pin;
  const { action } = req.body || {};
  const room = db.prepare('SELECT * FROM game_rooms WHERE pin = ? AND host_id = ?').get(pin, req.auth.user_id);
  if (!room) return res.status(403).json({ error: 'Bukan host room ini' });

  if (action === 'start') {
    db.prepare(`UPDATE game_rooms SET status = 'question', current_q_idx = 0, q_started_at = ? WHERE pin = ?`).run(Date.now(), pin);
  } else if (action === 'leaderboard') {
    db.prepare(`UPDATE game_rooms SET status = 'leaderboard' WHERE pin = ?`).run(pin);
  } else if (action === 'finish') {
    db.prepare(`UPDATE game_rooms SET status = 'finished' WHERE pin = ?`).run(pin);
  }

  res.json({ ok: true, action });
});

// 5. Player Submit Live Answer (Self-Paced Progression)
app.post('/api/rooms/:pin/answer', (req, res) => {
  const pin = req.params.pin;
  const { player_token, answer_idx, time_spent_ms, active_powerup } = req.body || {};
  const room = db.prepare('SELECT * FROM game_rooms WHERE pin = ?').get(pin);
  if (!room || room.status !== 'question') {
    return res.status(400).json({ error: 'Waktu menjawab telah selesai atau kuis belum dimulai' });
  }

  const player = db.prepare('SELECT * FROM room_players WHERE pin = ? AND player_token = ?').get(pin, player_token);
  if (!player) return res.status(404).json({ error: 'Player tidak ditemukan' });

  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY position ASC').all(room.quiz_id);
  const totalQuestions = questions.length;
  const playerQIdx = Number(player.current_q_idx) || 0;

  if (playerQIdx >= totalQuestions) {
    return res.status(400).json({ error: 'Kamu telah menyelesaikan semua pertanyaan kuis ini!' });
  }

  const currentQ = questions[playerQIdx];
  if (!currentQ) return res.status(404).json({ error: 'Pertanyaan tidak ditemukan' });

  const answersMap = JSON.parse(player.answers_json || '{}');
  if (answersMap[playerQIdx] !== undefined) {
    return res.status(409).json({ error: 'Kamu sudah menjawab pertanyaan ini!' });
  }

  const isCorrect = Number(answer_idx) === currentQ.correct_idx;
  let pointsEarned = 0;
  let newStreak = isCorrect ? (player.streak + 1) : 0;
  let powerupApplied = null;

  if (isCorrect) {
    const basePts = 600;
    const timeLimitMs = (currentQ.time_limit || 20) * 1000;
    const timeRemaining = Math.max(0, timeLimitMs - (Number(time_spent_ms) || 0));
    const speedRatio = Math.min(1, Math.max(0, timeRemaining / timeLimitMs));
    const speedBonus = Math.round(speedRatio * 300);
    const streakBonus = newStreak >= 3 ? 150 : (newStreak >= 2 ? 75 : 0);
    pointsEarned = basePts + speedBonus + streakBonus;

    // Power-Up: Double Points
    if (active_powerup === 'double_points') {
      pointsEarned *= 2;
      powerupApplied = 'double_points';
    }
  } else {
    // Power-Up: Streak Shield (jika salah, streak tidak kembali ke 0)
    if (active_powerup === 'streak_shield') {
      newStreak = player.streak;
      powerupApplied = 'streak_shield';
    }
  }

  const topPlayerBefore = db.prepare('SELECT name, score FROM room_players WHERE pin = ? ORDER BY score DESC, updated_at ASC LIMIT 1').get(pin);

  answersMap[playerQIdx] = { 
    answer_idx: Number(answer_idx), 
    is_correct: isCorrect, 
    points: pointsEarned,
    powerup: powerupApplied 
  };
  const newScore = player.score + pointsEarned;
  const nextQIdx = playerQIdx + 1;
  const isFinished = nextQIdx >= totalQuestions ? 1 : 0;

  db.prepare(`UPDATE room_players SET 
    score = ?, 
    streak = ?, 
    last_correct = ?, 
    last_points = ?, 
    answers_json = ?,
    current_q_idx = ?,
    finished = ?,
    updated_at = ?
    WHERE pin = ? AND player_token = ?`).run(
      newScore, newStreak, isCorrect ? 1 : 0, pointsEarned, JSON.stringify(answersMap), nextQIdx, isFinished, Date.now(), pin, player_token
    );

  // Trigger Real-Time Social Hype Events
  // 1. Leaderboard Overtake #1
  if (topPlayerBefore && player.name !== topPlayerBefore.name && newScore > topPlayerBefore.score) {
    pushRoomSocialEvent(pin, {
      type: 'rank_one',
      text: `👑 ${player.name} merebut posisi #1 dengan ${newScore.toLocaleString()} PTS!`,
      avatar: player.avatar
    });
  }

  // 2. High Streak Milestones (x3, x5, x7, x10)
  if (isCorrect && (newStreak === 3 || newStreak === 5 || newStreak === 7 || newStreak === 10)) {
    pushRoomSocialEvent(pin, {
      type: 'streak',
      text: `🔥 ${player.name} mencapai STREAK x${newStreak}!`,
      avatar: player.avatar
    });
  }

  // 3. Power-Up Activation
  if (powerupApplied) {
    const puName = powerupApplied === 'double_points' ? '⚡ 2x Poin' : (powerupApplied === 'streak_shield' ? '🛡️ Streak Shield' : powerupApplied);
    pushRoomSocialEvent(pin, {
      type: 'powerup',
      text: `${player.avatar} ${player.name} mengaktifkan ${puName}!`,
      avatar: player.avatar
    });
  }

  // 4. Completed all questions
  if (isFinished) {
    pushRoomSocialEvent(pin, {
      type: 'finished',
      text: `🏁 ${player.name} telah menyelesaikan semua soal!`,
      avatar: player.avatar
    });
  }

  res.json({
    ok: true,
    correct: isCorrect,
    correct_idx: currentQ.correct_idx,
    explanation: currentQ.explanation,
    points_earned: pointsEarned,
    new_score: newScore,
    streak: newStreak,
    is_finished: Boolean(isFinished),
    next_q_idx: nextQIdx,
    total_questions: totalQuestions,
    powerup_applied: powerupApplied
  });
});

// 5b. Power-Up: Fifty-Fifty (Eliminates 2 wrong answer choices for current question)
app.post('/api/rooms/:pin/powerup/fifty-fifty', (req, res) => {
  const pin = req.params.pin;
  const { player_token } = req.body || {};
  const room = db.prepare('SELECT * FROM game_rooms WHERE pin = ?').get(pin);
  if (!room || room.status !== 'question') {
    return res.status(400).json({ error: 'Kuis belum aktif' });
  }
  const player = db.prepare('SELECT * FROM room_players WHERE pin = ? AND player_token = ?').get(pin, player_token);
  if (!player) return res.status(404).json({ error: 'Player tidak ditemukan' });

  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY position ASC').all(room.quiz_id);
  const playerQIdx = Number(player.current_q_idx) || 0;
  const currentQ = questions[playerQIdx];
  if (!currentQ) return res.status(404).json({ error: 'Pertanyaan tidak ditemukan' });

  const options = JSON.parse(currentQ.options || '[]');
  const wrongIndices = [];
  for (let i = 0; i < options.length; i++) {
    if (i !== currentQ.correct_idx) {
      wrongIndices.push(i);
    }
  }

  // Shuffle and pick 2 wrong indices to eliminate
  const shuffled = wrongIndices.sort(() => 0.5 - Math.random());
  const eliminated = shuffled.slice(0, Math.min(2, wrongIndices.length));

  // Trigger social event for 50:50 power-up
  pushRoomSocialEvent(pin, {
    type: 'powerup',
    text: `${player.avatar} ${player.name} menggunakan ✂️ 50:50 Eliminator!`,
    avatar: player.avatar
  });

  res.json({ ok: true, eliminated });
});

// 5c. Submit Real-Time Reaction / Cheer Sticker (Floating Emotes Stream)
const reactionRateLimits = new Map(); // player_token -> lastTimestamp

app.post('/api/rooms/:pin/reaction', (req, res) => {
  const pin = req.params.pin;
  const { player_token, emoji, text } = req.body || {};
  if (!player_token) return res.status(400).json({ error: 'Token pemain diperlukan' });

  // Rate limit: 1 reaction per 350ms per player
  const lastTime = reactionRateLimits.get(player_token) || 0;
  if (Date.now() - lastTime < 350) {
    return res.status(429).json({ error: 'Terlalu cepat' });
  }
  reactionRateLimits.set(player_token, Date.now());

  const player = db.prepare('SELECT name, avatar FROM room_players WHERE pin = ? AND player_token = ?').get(pin, player_token);
  if (!player) return res.status(404).json({ error: 'Player tidak ditemukan' });

  const safeEmoji = (emoji || '🔥').slice(0, 10);
  const safeText = text ? String(text).slice(0, 30) : null;

  const item = pushRoomReaction(pin, {
    player_name: player.name,
    avatar: player.avatar,
    emoji: safeEmoji,
    text: safeText
  });

  res.json({ ok: true, reaction: item });
});

// ---------- DEEPSEEK AI SMART QUIZ GENERATOR (DeepSeek V4.1 Flash) ----------

function extractJsonFromText(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  try {
    return JSON.parse(s);
  } catch (_) {}

  // 1. Ekstrak dari blok markdown ```json ... ```
  const codeBlock = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlock) {
    try {
      return JSON.parse(codeBlock[1].trim());
    } catch (_) {}
  }

  // 2. Cari kurung kurawal terluar { ... }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch (_) {}
  }

  // 3. Cari array [ ... ] jika kuis berupa array langsung
  const startArr = s.indexOf('[');
  const endArr = s.lastIndexOf(']');
  if (startArr !== -1 && endArr > startArr) {
    try {
      const arr = JSON.parse(s.slice(startArr, endArr + 1));
      if (Array.isArray(arr)) return { questions: arr };
    } catch (_) {}
  }

  return null;
}

async function callDeepSeekApi({ apiKey, model, topic, count, difficulty }) {
  const n = Math.min(15, Math.max(3, Number(count) || 5));
  const diff = difficulty || 'Menengah / Analisis (C3-C4)';

  const systemPrompt = `Anda adalah pakar pembuat soal kuis edukasi dan asesmen akademik untuk Quiztify.id.
Tugas Anda adalah merancang paket soal kuis pilihan ganda yang akurat, berbobot, menantang, dan mendidik dalam Bahasa Indonesia.

PENTING: Output Anda WAJIB berupa JSON yang valid (format: \`\`\`json ... \`\`\` atau teks JSON murni) tanpa ada teks pengantar atau penutup lain:
{
  "topic": "Judul Topik Kuis",
  "category": "Kategori Ilmu",
  "questions": [
    {
      "text": "Teks pertanyaan yang jelas, spesifik, dan tidak ambigu?",
      "options": [
        "Pilihan A",
        "Pilihan B",
        "Pilihan C",
        "Pilihan D"
      ],
      "correct": 0,
      "time_limit": 20,
      "points": 1000,
      "explanation": "Penjelasan konsep kenapa opsi tersebut benar."
    }
  ]
}

Aturan Penulisan:
1. Buat tepat ${n} butir soal pilihan ganda.
2. Setiap butir soal WAJIB memiliki tepat 4 opsi jawaban ("options").
3. "correct" adalah indeks angka: 0 untuk opsi 1, 1 untuk opsi 2, 2 untuk opsi 3, atau 3 untuk opsi 4.
4. Buat kunci jawaban bervariasi secara proporsional antara indeks 0, 1, 2, dan 3.
5. "time_limit" adalah 20 atau 30 detik.
6. "points" adalah 1000.
7. "explanation" wajib memuat pembahasan singkat materi yang bermanfaat.`;

  const userPrompt = `Buatkan ${n} butir soal pilihan ganda tentang materi: "${topic}".
Tingkat Kesulitan: ${diff}.
Keluarkan HANYA dalam format JSON yang valid.`;

  // Coba model yang diminta (default: deepseek-flash), lalu fallback ke deepseek-chat jika perlu
  const modelsToTry = [model];
  if (model !== 'deepseek-chat') modelsToTry.push('deepseek-chat');
  if (model !== 'deepseek-flash' && !modelsToTry.includes('deepseek-flash')) modelsToTry.push('deepseek-flash');

  let lastError = null;

  for (const m of modelsToTry) {
    // 2 Strategi:
    // Strategi 1: Prompt murni tanpa response_format strict (menghindari bug empty content DeepSeek)
    // Strategi 2: Dengan response_format: { type: 'json_object' } jika Strategi 1 gagal
    const strategies = [
      { name: 'Standard Prompt', jsonMode: false },
      { name: 'JSON Mode Strict', jsonMode: true }
    ];

    for (const strat of strategies) {
      console.log(`[Quiztify AI] Menghubungi DeepSeek API (${m}, strategi: ${strat.name})...`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);

      try {
        const payload = {
          model: m,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 4000
        };

        if (strat.jsonMode) {
          payload.response_format = { type: 'json_object' };
        }

        const response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey.trim()}`
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errText = await response.text();
          let errMsg = `HTTP ${response.status}`;
          try {
            const parsedErr = JSON.parse(errText);
            if (parsedErr.error?.message) errMsg = parsedErr.error.message;
          } catch (_) {}
          console.warn(`[Quiztify AI] DeepSeek error (${m}, ${strat.name}):`, errMsg);
          lastError = errMsg;
          if (response.status === 404 || errMsg.toLowerCase().includes('model')) break;
          continue;
        }

        const data = await response.json();
        const choice = data.choices?.[0] || {};
        const msg = choice.message || {};

        let text = (msg.content || '').trim();
        // Fallback: Jika content kosong, periksa reasoning_content
        if (!text && msg.reasoning_content) {
          console.log(`[Quiztify AI] (${m}) content kosong, mengambil dari reasoning_content...`);
          text = msg.reasoning_content.trim();
        }

        if (!text) {
          console.warn(`[Quiztify AI] (${m}, ${strat.name}) Respons kosong dari DeepSeek. Detail choice:`, JSON.stringify(choice));
          lastError = 'Respons kosong dari DeepSeek API';
          continue;
        }

        const parsed = extractJsonFromText(text);
        if (!parsed || !parsed.questions || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
          console.warn(`[Quiztify AI] (${m}) Gagal membaca pertanyaan dari respons DeepSeek:`, text.slice(0, 250));
          lastError = 'Format respons DeepSeek tidak memuat array questions yang valid';
          continue;
        }

        const sanitizedQuestions = parsed.questions.map((q, idx) => {
          let correctIdx = 0;
          if (typeof q.correct === 'number') {
            correctIdx = Math.max(0, Math.min(3, Math.round(q.correct)));
          } else if (typeof q.correct === 'string') {
            const char = q.correct.trim().toLowerCase();
            const map = { 'a': 0, 'b': 1, 'c': 2, 'd': 3, '0': 0, '1': 1, '2': 2, '3': 3 };
            correctIdx = map[char] ?? 0;
          }

          let opts = Array.isArray(q.options)
            ? q.options.filter(o => o !== null && o !== undefined).map(o => String(o).trim())
            : [];
          if (opts.length < 4) {
            while (opts.length < 4) opts.push(`Pilihan ${String.fromCharCode(65 + opts.length)}`);
          } else if (opts.length > 4) {
            opts = opts.slice(0, 4);
          }

          return {
            text: String(q.text || `Pertanyaan #${idx + 1} tentang ${topic}`).trim(),
            options: opts,
            correct: correctIdx,
            time_limit: Math.min(60, Math.max(10, Number(q.time_limit) || 20)),
            points: Number(q.points) || 1000,
            explanation: String(q.explanation || 'Jawaban benar berdasarkan konsep materi.').trim()
          };
        });

        console.log(`[Quiztify AI] Sukses membuat ${sanitizedQuestions.length} butir soal dari DeepSeek (${m})!`);
        return {
          ok: true,
          model: m,
          topic: parsed.topic || topic,
          category: parsed.category || 'Materi Umum',
          questions: sanitizedQuestions
        };

      } catch (err) {
        clearTimeout(timeoutId);
        const errMsg = err.name === 'AbortError' ? 'Koneksi ke DeepSeek API timeout (45 detik)' : err.message;
        console.warn(`[Quiztify AI] Exception (${m}, ${strat.name}):`, errMsg);
        lastError = errMsg;
      }
    }
  }

  return { ok: false, error: lastError || 'Gagal berkomunikasi dengan DeepSeek AI' };
}

app.post('/api/quizzes/generate-ai', requireRole('creator', 'dosen'), async (req, res) => {
  const { topic, count, difficulty } = req.body || {};
  const t = norm(topic) || 'Teknologi Informasi & Pemrograman Modern';
  const n = Math.min(15, Math.max(3, Number(count) || 5));
  const diff = norm(difficulty) || 'Menengah / Analisis (C3-C4)';

  // Periksa environment variable dari Railway (mendukung huruf besar & kecil)
  const apiKey = (process.env.DEEPSEEK_API_KEY || process.env.deepseek_api_key || process.env.DEEPSEEK_KEY || process.env.OPENAI_API_KEY || '').trim();

  // Model resmi DeepSeek V4.1 Flash adalah 'deepseek-flash'
  const primaryModel = process.env.DEEPSEEK_MODEL || 'deepseek-flash';

  if (apiKey) {
    console.log(`[Quiztify AI] Memulai generate kuis via DeepSeek API (Model Primer: ${primaryModel}, Topik: "${t}", Jumlah: ${n})...`);
    
    const aiRes = await callDeepSeekApi({ apiKey, model: primaryModel, topic: t, count: n, difficulty: diff });

    if (aiRes.ok) {
      const modelLabel = aiRes.model === 'deepseek-flash' ? 'DeepSeek V4.1 Flash' : `DeepSeek AI (${aiRes.model})`;
      console.log(`[Quiztify AI] Sukses membuat ${aiRes.questions.length} butir soal kuis menggunakan ${modelLabel}!`);
      return res.json({
        success: true,
        source: 'deepseek-api',
        model: aiRes.model,
        model_display: modelLabel,
        topic: aiRes.topic,
        category: aiRes.category,
        generated_count: aiRes.questions.length,
        questions: aiRes.questions
      });
    }

    console.warn(`[Quiztify AI] Panggilan DeepSeek API gagal: ${aiRes.error}. Mengalihkan ke generator cadangan.`);
  } else {
    console.warn('[Quiztify AI] DEEPSEEK_API_KEY belum terdeteksi di env Railway/lokal. Menggunakan bank soal cerdas.');
  }

  // Generator Fallback Cadangan (Jika API Key belum diset atau kuota habis)
  const sampleBanks = {
    web: [
      { text: 'Apa peran utama dari protokol HTTPS dibandingkan HTTP standar?', options: ['Mengompresi gambar situs', 'Enkripsi data melalui SSL/TLS secara aman', 'Mempercepat kecepatan internet pengguna', 'Menghapus cookies sesi otomatis'], correct: 1, explanation: 'HTTPS mengamankan komunikasi data antara peramban dan server dengan enkripsi kriptografi SSL/TLS.' },
      { text: 'CSS Flexbox dirancang untuk mengatur tata letak elemen secara...', options: ['Tiga dimensi spasial', 'Satu dimensi (baris atau kolom responsif)', 'Hanya tabel hierarki bertingkat', 'Pemrosesan animasi raster'], correct: 1, explanation: 'Flexbox adalah model tata letak satu dimensi untuk mendistribusikan ruang di antara elemen secara fleksibel.' },
      { text: 'Dalam JavaScript modern (ES6+), kata kunci untuk mendeklarasikan variabel bernilai tetap (immutable reference) adalah...', options: ['var', 'let', 'const', 'static'], correct: 2, explanation: 'const digunakan untuk deklarasi variabel yang referensinya tidak dapat di-reassign kembali.' }
    ],
    math: [
      { text: 'Berapa nilai dari akar kuadrat 144?', options: ['10', '11', '12', '14'], correct: 2, explanation: '12 x 12 = 144.' },
      { text: 'Berapa jumlah total sudut dalam sebuah bangun segitiga datar (Euclidean)?', options: ['90 derajat', '180 derajat', '270 derajat', '360 derajat'], correct: 1, explanation: 'Total jumlah ketiga sudut dalam segitiga Euclidean selalu tepat 180 derajat.' }
    ],
    general: [
      { text: `Konsep dasar yang paling esensial dalam topik "${t}" adalah...`, options: ['Pemahaman fondasi dan metodologi utama', 'Menghafal rumus tanpa memahami konsep', 'Meninggalkan dokumentasi serta referensi resmi', 'Menjalankan instruksi secara spekulatif'], correct: 0, explanation: `Memahami fondasi teori dan metodologi sangat krusial dalam menguasai kompetensi ${t}.` },
      { text: `Strategi asesmen paling tepat untuk mengukur efektivitas pembelajaran ${t} adalah...`, options: ['Mengabaikan umpan balik evaluasi peserta', 'Asesmen formatif berkala & analisis N-Gain', 'Hanya mengadakan ujian sekali di akhir tanpa evaluasi', 'Tidak memberikan kunci dan pembahasan soal'], correct: 1, explanation: 'Asesmen formatif berkala dan pengukuran gain efektivitas memberikan wawasan capaian pembelajaran terbaik.' },
      { text: `Indikator keberhasilan dari penerapan inovasi pada materi ${t} terlihat dari...`, options: ['Peningkatan efisiensi, pemahaman konseptual, dan daya kritis', 'Penurunan partisipasi peserta didik', 'Stagnasi data pencapaian', 'Meningkatnya kebingungan pengguna'], correct: 0, explanation: 'Peningkatan efisiensi dan pemahaman terukur menandai keberhasilan inovasi pembelajaran.' },
      { text: `Langkah awal yang paling tepat dalam menyusun strategi pembelajaran ${t} adalah...`, options: ['Menentukan tujuan capaian pembelajaran (Learning Outcomes)', 'Langsung memberi hukuman jika jawaban salah', 'Menutup sesi diskusi dan tanya jawab', 'Membagikan materi tanpa penjelasan konteks'], correct: 0, explanation: 'Perumusan Learning Outcomes mengarahkan seluruh materi, penyusunan kuis, dan evaluasi.' },
      { text: `Tantangan terbesar yang sering dihadapi praktisi saat mengimplementasikan ${t} adalah...`, options: ['Adaptasi terhadap perkembangan baru & konsistensi', 'Terlalu banyak waktu luang', 'Tidak adanya referensi ilmiah', 'Biaya internet gratis'], correct: 0, explanation: 'Konsistensi dan adaptasi terhadap perkembangan baru merupakan kunci sukses keberlanjutan kompetensi.' }
    ]
  };

  const lowerT = t.toLowerCase();
  let selected = sampleBanks.general;
  if (lowerT.includes('web') || lowerT.includes('coding') || lowerT.includes('js') || lowerT.includes('program') || lowerT.includes('it')) {
    selected = [...sampleBanks.web, ...sampleBanks.general];
  } else if (lowerT.includes('matematika') || lowerT.includes('hitung') || lowerT.includes('angka')) {
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

  return res.json({
    success: true,
    source: 'fallback',
    model: 'Smart Fallback Engine',
    model_display: 'Smart Fallback Engine (Atur deepseek_api_key di Railway untuk aktivasi DeepSeek V4.1 Flash)',
    warning: apiKey ? 'Gagal menghubungi DeepSeek API. Menggunakan bank soal cadangan.' : 'deepseek_api_key belum terpasang di Environment Railway.',
    topic: t,
    category: t,
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

// Daftar Kumpulan Kuis di Kelas Tertentu
app.get('/api/classes/:id/quizzes', requireRole('creator', 'dosen'), (req, res) => {
  const c = db.prepare('SELECT id, name, course, code FROM classes WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Kelas tidak ditemukan' });

  const totalStudents = db.prepare('SELECT COUNT(*) as count FROM students WHERE class_id = ?').get(c.id).count;

  const quizzes = db.prepare(`SELECT q.*,
    (SELECT COUNT(*) FROM questions WHERE quiz_id = q.id) as question_count,
    (SELECT COUNT(*) FROM attempts WHERE quiz_id = q.id) as attempt_count,
    (SELECT AVG(score) FROM attempts WHERE quiz_id = q.id) as avg_score,
    (SELECT MAX(score) FROM attempts WHERE quiz_id = q.id) as max_score,
    (SELECT MIN(score) FROM attempts WHERE quiz_id = q.id) as min_score
    FROM quizzes q
    WHERE q.class_id = ?
    ORDER BY q.created_at DESC`).all(c.id);

  res.json({
    class: c,
    total_students: totalStudents,
    quizzes: quizzes.map(q => ({
      ...q,
      avg_score: q.avg_score !== null ? Math.round(q.avg_score) : null,
      completion_rate: totalStudents > 0 ? Math.round((q.attempt_count / totalStudents) * 100) : 0
    }))
  });
});

// Hubungkan Kuis dari Library ke Kelas Ini
app.post('/api/classes/:id/assign-quiz', requireRole('creator', 'dosen'), (req, res) => {
  const { quiz_id } = req.body || {};
  const c = db.prepare('SELECT id FROM classes WHERE id = ? AND dosen_id = ?').get(req.params.id, req.auth.user_id);
  if (!c) return res.status(404).json({ error: 'Kelas tidak ditemukan' });

  const q = db.prepare('SELECT id FROM quizzes WHERE id = ?').get(Number(quiz_id));
  if (!q) return res.status(404).json({ error: 'Kuis tidak ditemukan' });

  db.prepare('UPDATE quizzes SET class_id = ? WHERE id = ?').run(c.id, q.id);
  res.json({ ok: true, message: 'Kuis berhasil dihubungkan ke kelas' });
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

// Detail Hasil & Nilai Mahasiswa per Kuis
app.get('/api/quizzes/:id/attempts-detail', requireRole('creator', 'dosen'), (req, res) => {
  const quiz = db.prepare('SELECT q.*, c.name as class_name FROM quizzes q LEFT JOIN classes c ON c.id = q.class_id WHERE q.id = ?').get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Kuis tidak ditemukan' });

  const totalQuestions = db.prepare('SELECT COUNT(*) as c FROM questions WHERE quiz_id = ?').get(quiz.id).c;

  let students = [];
  if (quiz.class_id) {
    students = db.prepare('SELECT id, nama, npm, avatar FROM students WHERE class_id = ? ORDER BY nama ASC').all(quiz.class_id);
  } else {
    students = db.prepare(`SELECT DISTINCT s.id, s.nama, s.npm, s.avatar 
      FROM attempts a JOIN students s ON s.id = a.student_id WHERE a.quiz_id = ? ORDER BY s.nama ASC`).all(quiz.id);
  }

  const attempts = db.prepare('SELECT student_id, score, correct_count, total_count, time_spent_sec, tab_switches, created_at FROM attempts WHERE quiz_id = ?').all(quiz.id);
  const attemptMap = Object.fromEntries(attempts.map(a => [a.student_id, a]));

  const rows = students.map(s => {
    const a = attemptMap[s.id];
    const switches = a ? (Number(a.tab_switches) || 0) : 0;
    return {
      student_id: s.id,
      nama: s.nama,
      npm: s.npm,
      avatar: s.avatar,
      status: a ? 'completed' : 'pending',
      score: a ? a.score : null,
      correct_count: a ? a.correct_count : 0,
      total_count: a ? a.total_count : totalQuestions,
      time_spent_sec: a ? a.time_spent_sec : 0,
      tab_switches: switches,
      integrity_status: a ? (switches >= 3 ? 'warning' : (switches >= 1 ? 'caution' : 'clean')) : 'clean',
      submitted_at: a ? a.created_at : null,
      letter_grade: a ? getLetterGrade(a.score) : null
    };
  });

  const completed = rows.filter(r => r.status === 'completed');
  const scores = completed.map(r => r.score);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const max = scores.length ? Math.max(...scores) : null;
  const min = scores.length ? Math.min(...scores) : null;

  res.json({
    quiz: {
      id: quiz.id,
      title: quiz.title,
      type: quiz.type,
      category: quiz.category,
      class_id: quiz.class_id,
      class_name: quiz.class_name,
      total_questions: totalQuestions,
      exam_mode: quiz.exam_mode || 0,
      is_remedial_for: quiz.is_remedial_for || 0
    },
    stats: {
      total_students: students.length,
      completed_count: completed.length,
      pending_count: students.length - completed.length,
      avg_score: avg,
      max_score: max,
      min_score: min,
      pass_count: completed.filter(r => r.score >= 65).length
    },
    students: rows
  });
});

// AI Learning Diagnostic: Analisis Butir Soal & Peta Kelemahan Konsep
app.get('/api/quizzes/:id/diagnostic', requireRole('creator', 'dosen'), (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = db.prepare('SELECT q.*, c.name as class_name FROM quizzes q LEFT JOIN classes c ON c.id = q.class_id WHERE q.id = ?').get(quizId);
  if (!quiz) return res.status(404).json({ error: 'Kuis tidak ditemukan' });

  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY position ASC').all(quizId);
  const attempts = db.prepare('SELECT * FROM attempts WHERE quiz_id = ?').all(quizId);
  
  // Ambil juga data dari room_players jika pernah dimainkan di live room
  const rooms = db.prepare('SELECT pin FROM game_rooms WHERE quiz_id = ?').all(quizId);
  const roomPins = rooms.map(r => r.pin);
  let livePlayers = [];
  if (roomPins.length > 0) {
    const placeholders = roomPins.map(() => '?').join(',');
    livePlayers = db.prepare(`SELECT answers_json FROM room_players WHERE pin IN (${placeholders})`).all(...roomPins);
  }

  const totalTakers = attempts.length + livePlayers.length;

  const analysis = questions.map((q, idx) => {
    let wrongCount = 0;
    let rightCount = 0;
    const options = JSON.parse(q.options || '[]');

    // Dari attempts
    attempts.forEach(a => {
      const ans = JSON.parse(a.answers || '{}');
      if (ans[idx] !== undefined || ans[q.id] !== undefined) {
        const studentAns = ans[idx] !== undefined ? ans[idx] : ans[q.id];
        if (Number(studentAns) === q.correct_idx) rightCount++;
        else wrongCount++;
      }
    });

    // Dari live players
    livePlayers.forEach(p => {
      const ansMap = JSON.parse(p.answers_json || '{}');
      if (ansMap[idx] !== undefined) {
        if (ansMap[idx].is_correct) rightCount++;
        else wrongCount++;
      }
    });

    const totalAnswered = rightCount + wrongCount;
    const errorRate = totalAnswered > 0 ? Math.round((wrongCount / totalAnswered) * 100) : 0;
    const isWeak = errorRate >= 40 || (totalAnswered === 0 && idx % 2 === 0);

    return {
      index: idx,
      question_id: q.id,
      text: q.text,
      options,
      correct_idx: q.correct_idx,
      correct_answer: options[q.correct_idx] || '',
      explanation: q.explanation,
      total_answered: totalAnswered,
      right_count: rightCount,
      wrong_count: wrongCount,
      error_rate: errorRate,
      status: isWeak ? 'weak' : 'mastered',
      recommendation: isWeak 
        ? `Perlu penguatan konsep: tingkat kesalahan ${errorRate}%. ${q.explanation ? 'Fokus: ' + q.explanation : 'Perlu penjelasan ulang konsep dasar.'}` 
        : 'Pemahaman materi baik dan tuntas.'
    };
  });

  const weakQuestions = analysis.filter(q => q.status === 'weak');
  const existingRemedial = db.prepare('SELECT id, title FROM quizzes WHERE is_remedial_for = ?').get(quizId);
  const avgErrorRate = analysis.length > 0 
    ? Math.round(analysis.reduce((sum, q) => sum + q.error_rate, 0) / analysis.length) 
    : 0;
  const totalAnswersAnalyzed = analysis.reduce((sum, q) => sum + q.total_answered, 0);

  const diagnosticSummary = [];
  if (weakQuestions.length > 0) {
    diagnosticSummary.push(`${weakQuestions.length} dari ${questions.length} butir soal teridentifikasi memiliki tingkat kegagalan tinggi (>40%).`);
    weakQuestions.slice(0, 2).forEach(w => {
      diagnosticSummary.push(`Miskonsepsi pada Soal #${w.index + 1}: "${w.text.slice(0, 60)}..." (${w.error_rate}% salah).`);
    });
  } else {
    diagnosticSummary.push(`Seluruh butir soal berhasil dikuasai peserta dengan tingkat ketuntasan sangat baik (Rata-rata kesalahan hanya ${avgErrorRate}%).`);
  }

  res.json({
    quiz: {
      id: quiz.id,
      title: quiz.title,
      category: quiz.category,
      class_name: quiz.class_name
    },
    stats: {
      average_error_rate: avgErrorRate,
      weak_questions_count: weakQuestions.length,
      total_answers_analyzed: totalAnswersAnalyzed
    },
    total_takers: totalTakers,
    total_questions: questions.length,
    weak_count: weakQuestions.length,
    mastered_count: questions.length - weakQuestions.length,
    diagnostic_summary: diagnosticSummary,
    questions: analysis,
    questions_analysis: analysis,
    weak_questions: weakQuestions,
    has_existing_remedial: Boolean(existingRemedial),
    existing_remedial: existingRemedial || null
  });
});

// 1-Click Auto-Remedial Generator via DeepSeek AI
app.post('/api/quizzes/:id/auto-remedial', requireRole('creator', 'dosen'), async (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(quizId);
  if (!quiz) return res.status(404).json({ error: 'Kuis tidak ditemukan' });

  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY position ASC').all(quizId);
  if (questions.length === 0) return res.status(400).json({ error: 'Kuis tidak memiliki soal' });

  const count = 5;
  let generatedQuestions = [];
  const apiKey = (process.env.DEEPSEEK_API_KEY || process.env.deepseek_api_key || process.env.DEEPSEEK_KEY || process.env.OPENAI_API_KEY || '').trim();
  const primaryModel = process.env.DEEPSEEK_MODEL || 'deepseek-flash';

  if (apiKey) {
    const aiPromptTopic = `Soal Remedial untuk memperkuat materi: "${quiz.title}". Berikan 5 pertanyaan terarah dengan pembahasan konsep bertahap agar siswa yang remedial memahami konsep dasar dengan benar.`;
    const aiRes = await callDeepSeekApi({ apiKey, model: primaryModel, topic: aiPromptTopic, count, difficulty: 'Dasar hingga Pemahaman Konseptual (C2-C3)' });
    if (aiRes.ok && aiRes.questions.length > 0) {
      generatedQuestions = aiRes.questions;
    }
  }

  // Fallback variasi soal penguatan berkualitas tinggi
  if (generatedQuestions.length === 0) {
    for (let i = 0; i < Math.min(count, questions.length); i++) {
      const baseQ = questions[i];
      const baseOpts = JSON.parse(baseQ.options || '[]');
      generatedQuestions.push({
        text: `[Remedial & Penguatan] Terkait materi "${quiz.title}", perhatikan soal ini: ${baseQ.text} — Manakah analisis yang paling tepat?`,
        options: baseOpts.length === 4 ? baseOpts : ['Pemahaman fondasi konsep sesuai standar materi', 'Terjadi inkonsistensi logika atau asumsi', 'Konsep tidak relevan dengan konteks materi', 'Tidak ada hubungan sebab akibat yang valid'],
        correct_idx: baseQ.correct_idx,
        explanation: baseQ.explanation || `Pertanyaan remedial ini menguji pemahaman konsep esensial pada topik ${quiz.title}.`
      });
    }
    while (generatedQuestions.length < count) {
      const idx = generatedQuestions.length;
      generatedQuestions.push({
        text: `[Penguatan Konsep #${idx + 1}] Bagaimanakah implementasi atau prinsip utama yang benar pada materi "${quiz.title}"?`,
        options: [
          'Memahami fondasi teori dan menjalankan langkah metodologi terstandar',
          'Mengabaikan panduan resmi dan melakukan tebakan spekulatif',
          'Melewatkan tahapan pengujian dan verifikasi akurasi',
          'Menghapus dokumentasi dan konfigurasi sistem'
        ],
        correct_idx: 0,
        explanation: `Pemahaman fondasi dan kepatuhan pada standar metodologi adalah kunci ketuntasan belajar topik ${quiz.title}.`
      });
    }
  }

  // Buat Kuis Remedial Baru di Database
  const remedialTitle = `[REMEDIAL] ${quiz.title}`;
  const insQuiz = db.prepare(`
    INSERT INTO quizzes (class_id, creator_id, title, description, category, type, cover_emoji, time_per_q, points_per_q, is_public, is_remedial_for)
    VALUES (?, ?, ?, ?, ?, 'standard', '🎯', ?, ?, 1, ?)
  `).run(
    quiz.class_id,
    req.auth.user_id,
    remedialTitle,
    `Kuis penguatan hasil diagnosa remedial untuk "${quiz.title}". Dirancang untuk menuntaskan pemahaman konsep.`,
    quiz.category,
    quiz.time_per_q || 30,
    quiz.points_per_q || 1000,
    quiz.id
  );

  const newQuizId = Number(insQuiz.lastInsertRowid);
  const insQ = db.prepare(`
    INSERT INTO questions (quiz_id, position, text, options, correct_idx, time_limit, points, explanation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  generatedQuestions.forEach((q, pos) => {
    insQ.run(
      newQuizId,
      pos + 1,
      q.text,
      JSON.stringify(q.options),
      q.correct_idx !== undefined ? q.correct_idx : (q.correct || 0),
      quiz.time_per_q || 30,
      quiz.points_per_q || 1000,
      q.explanation || ''
    );
  });

  res.json({
    ok: true,
    remedial_quiz_id: newQuizId,
    title: remedialTitle,
    questions_count: generatedQuestions.length,
    original_quiz_id: quiz.id,
    remedial_quiz: {
      id: newQuizId,
      title: remedialTitle,
      question_count: generatedQuestions.length
    }
  });
});

// Berita Acara Ujian Resmi & Transkrip Akademik Berstandar Dikti / Sekolah
app.get('/api/quizzes/:id/berita-acara', requireRole('creator', 'dosen'), async (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = db.prepare('SELECT q.*, c.name as class_name, c.course, c.code as class_code FROM quizzes q LEFT JOIN classes c ON c.id = q.class_id WHERE q.id = ?').get(quizId);
  if (!quiz) return res.status(404).json({ error: 'Kuis tidak ditemukan' });

  const creator = db.prepare('SELECT nama, email, institution, plan FROM dosen WHERE id = ?').get(req.auth.user_id) || { nama: 'Dosen Pengampu', institution: 'Quiztify Academic Institute' };
  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY position ASC').all(quizId);
  
  let students = [];
  if (quiz.class_id) {
    students = db.prepare('SELECT id, nama, npm, avatar FROM students WHERE class_id = ? ORDER BY nama ASC').all(quiz.class_id);
  } else {
    students = db.prepare(`SELECT DISTINCT s.id, s.nama, s.npm, s.avatar FROM attempts a JOIN students s ON s.id = a.student_id WHERE a.quiz_id = ? ORDER BY s.nama ASC`).all(quizId);
  }

  const attempts = db.prepare('SELECT student_id, score, correct_count, total_count, time_spent_sec, tab_switches, created_at FROM attempts WHERE quiz_id = ?').all(quizId);
  const attemptMap = Object.fromEntries(attempts.map(a => [a.student_id, a]));

  let gradeDistribution = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const rows = students.map((s, idx) => {
    const a = attemptMap[s.id];
    const letter = a ? getLetterGrade(a.score) : { grade: '-', label: 'Tidak Hadir', status: 'Gagal' };
    if (a && gradeDistribution[letter.grade] !== undefined) {
      gradeDistribution[letter.grade]++;
    }
    const switches = a ? (Number(a.tab_switches) || 0) : 0;
    return {
      no: idx + 1,
      npm: s.npm,
      nama: s.nama,
      score: a ? a.score : null,
      grade: letter.grade,
      status: a ? letter.status : 'Tidak Hadir',
      correct_count: a ? a.correct_count : 0,
      total_count: questions.length,
      time_spent_sec: a ? a.time_spent_sec : 0,
      tab_switches: switches,
      integrity_status: a ? (switches >= 3 ? 'Peringatan Curang' : (switches >= 1 ? 'Waspada' : 'Bersih')) : '-'
    };
  });

  const present = rows.filter(r => r.score !== null);
  const scores = present.map(r => r.score);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const max = scores.length ? Math.max(...scores) : 0;
  const min = scores.length ? Math.min(...scores) : 0;
  const passCount = gradeDistribution.A + gradeDistribution.B + gradeDistribution.C;
  const passRate = present.length > 0 ? Math.round((passCount / present.length) * 100) : 0;

  // Generate QR code verifikasi keaslian dokumen
  const docVerifyUrl = `https://quiztify.id/verify-doc?type=berita_acara&quiz_id=${quiz.id}&hash=${crypto.createHash('md5').update(`${quiz.id}_${Date.now()}`).digest('hex').substring(0, 10)}`;
  const qrDataUrl = await QRCode.toDataURL(docVerifyUrl, { margin: 1, width: 140, color: { dark: '#0f172a', light: '#ffffff' } });

  const gradeSummary = [
    { range: '85 - 100', grade: 'A', label: 'Sangat Memuaskan (Cum Laude)', count: gradeDistribution.A, percentage: present.length ? Math.round((gradeDistribution.A / present.length) * 100) : 0 },
    { range: '70 - 84', grade: 'B', label: 'Memuaskan (Baik)', count: gradeDistribution.B, percentage: present.length ? Math.round((gradeDistribution.B / present.length) * 100) : 0 },
    { range: '55 - 69', grade: 'C', label: 'Cukup (Lulus Standar)', count: gradeDistribution.C, percentage: present.length ? Math.round((gradeDistribution.C / present.length) * 100) : 0 },
    { range: '40 - 54', grade: 'D', label: 'Kurang (Remedial)', count: gradeDistribution.D, percentage: present.length ? Math.round((gradeDistribution.D / present.length) * 100) : 0 },
    { range: '0 - 39', grade: 'E', label: 'Gagal / Tidak Lulus', count: gradeDistribution.E, percentage: present.length ? Math.round((gradeDistribution.E / present.length) * 100) : 0 }
  ];

  const roster = rows.map(r => ({
    npm: r.npm,
    nama: r.nama,
    status: r.score !== null ? 'Hadir / Selesai' : 'Tidak Hadir',
    correct_count: r.correct_count,
    total_count: r.total_count,
    score: r.score !== null ? r.score : 0,
    letter_grade: r.grade,
    tab_switches: r.tab_switches
  }));

  const cleanCount = rows.filter(r => r.tab_switches === 0).length;
  const flaggedCount = rows.filter(r => r.tab_switches > 0).length;
  const docNumber = `BA-QZT/${new Date().getFullYear()}/${String(quiz.id).padStart(4, '0')}`;
  const verifyToken = `QZ-VAL-${crypto.createHash('md5').update(`${quiz.id}_${Date.now()}`).digest('hex').substring(0, 8).toUpperCase()}`;
  const dayDate = new Intl.DateTimeFormat('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());

  res.json({
    document_number: docNumber,
    day_date: dayDate,
    quiz: {
      id: quiz.id,
      title: quiz.title,
      total_questions: questions.length,
      category: quiz.category,
      course: quiz.course
    },
    lecturer: {
      nama: creator.nama,
      email: creator.email,
      institution: creator.institution || 'Quiztify Academic Institute'
    },
    class: {
      name: quiz.class_name || 'Reguler'
    },
    stats: {
      total_students: students.length,
      completed_students: present.length,
      attendance_pct: students.length ? Math.round((present.length / students.length) * 100) : 0,
      avg_score: avg,
      max_score: max,
      min_score: min,
      pass_count: passCount,
      pass_rate: passRate
    },
    integrity_summary: {
      clean_count: cleanCount,
      flagged_count: flaggedCount
    },
    grade_distribution: gradeSummary,
    roster: roster,
    qr_data_url: qrDataUrl,
    verification_token: verifyToken,
    sign_date: dayDate,
    berita_acara: {
      nomor_dokumen: docNumber,
      tanggal: dayDate,
      institusi: creator.institution,
      pengampu: creator.nama,
      judul_kuis: quiz.title,
      rata_rata: avg,
      distribusi_nilai: gradeDistribution,
      qr_code: qrDataUrl
    }
  });
});

// Export CSV Standar Akademik (SIAKAD Compatible)
app.get('/api/quizzes/:id/export-csv', requireRole('creator', 'dosen'), (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = db.prepare('SELECT q.*, c.name as class_name FROM quizzes q LEFT JOIN classes c ON c.id = q.class_id WHERE q.id = ?').get(quizId);
  if (!quiz) return res.status(404).send('Kuis tidak ditemukan');

  const students = quiz.class_id
    ? db.prepare('SELECT id, nama, npm FROM students WHERE class_id = ? ORDER BY nama ASC').all(quiz.class_id)
    : db.prepare(`SELECT DISTINCT s.id, s.nama, s.npm FROM attempts a JOIN students s ON s.id = a.student_id WHERE a.quiz_id = ? ORDER BY s.nama ASC`).all(quizId);

  const attempts = db.prepare('SELECT student_id, score, correct_count, total_count, time_spent_sec, tab_switches, created_at FROM attempts WHERE quiz_id = ?').all(quizId);
  const attemptMap = Object.fromEntries(attempts.map(a => [a.student_id, a]));

  const headers = ['No', 'NPM / NIM', 'Nama Mahasiswa', 'Nilai (0-100)', 'Huruf Mutu', 'Status Kelulusan', 'Benar', 'Total Soal', 'Durasi (Detik)', 'Pindah Tab (Integritas)', 'Tanggal Submit'];
  const lines = [headers.join(',')];

  students.forEach((s, idx) => {
    const a = attemptMap[s.id];
    const letter = a ? getLetterGrade(a.score) : { grade: '-', status: 'Belum Ujian' };
    const row = [
      idx + 1,
      `"${s.npm}"`,
      `"${s.nama.replace(/"/g, '""')}"`,
      a ? a.score : '',
      letter.grade,
      letter.status,
      a ? a.correct_count : 0,
      a ? a.total_count : 0,
      a ? a.time_spent_sec : 0,
      a ? (Number(a.tab_switches) || 0) : 0,
      a ? `"${a.created_at}"` : '""'
    ];
    lines.push(row.join(','));
  });

  const csvContent = '\uFEFF' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Nilai_${quiz.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv"`);
  res.send(csvContent);
});

// Upgrade Subscription Tier (Commercial Monetization)
app.post('/api/creator/upgrade-plan', requireRole('creator', 'dosen'), (req, res) => {
  const { plan, billing_cycle } = req.body || {};
  const targetPlan = (plan === 'campus_enterprise' || plan === 'pro') ? plan : 'pro';
  const days = (billing_cycle === 'yearly') ? 365 : 30;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const quota = targetPlan === 'campus_enterprise' ? 9999 : 500;

  db.prepare(`UPDATE dosen SET plan = ?, plan_expires_at = ?, quota_ai_gen = ? WHERE id = ?`).run(
    targetPlan, expiresAt, quota, req.auth.user_id
  );

  res.json({
    ok: true,
    plan: targetPlan,
    plan_display: targetPlan === 'campus_enterprise' ? 'CAMPUS ENTERPRISE' : 'PRO CREATOR',
    plan_expires_at: expiresAt,
    quota_ai_gen: quota,
    message: `Selamat! Akun Anda berhasil diaktifkan ke paket ${targetPlan.toUpperCase()}.`
  });
});

// Rekap Buku Nilai Akhir Kelas (Gradebook Mata Kuliah)
app.get('/api/classes/:id/gradebook', requireRole('creator', 'dosen'), (req, res) => {
  const c = db.prepare('SELECT id, name, course, code FROM classes WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Kelas tidak ditemukan' });

  const quizzes = db.prepare(`SELECT q.id, q.title, q.type, q.created_at,
    (SELECT COUNT(*) FROM questions WHERE quiz_id = q.id) as question_count
    FROM quizzes q WHERE q.class_id = ? ORDER BY q.created_at ASC`).all(c.id);

  const students = db.prepare('SELECT id, nama, npm, avatar FROM students WHERE class_id = ? ORDER BY nama ASC').all(c.id);

  const attempts = db.prepare(`SELECT a.student_id, a.quiz_id, a.score, a.created_at 
    FROM attempts a JOIN quizzes q ON q.id = a.quiz_id WHERE q.class_id = ?`).all(c.id);

  const attemptMap = {};
  attempts.forEach(a => {
    attemptMap[`${a.student_id}_${a.quiz_id}`] = a.score;
  });

  const studentRows = students.map(s => {
    const scores = {};
    let totalScore = 0;
    let quizAttemptedCount = 0;

    quizzes.forEach(q => {
      const score = attemptMap[`${s.id}_${q.id}`];
      if (score !== undefined) {
        scores[q.id] = score;
        totalScore += score;
        quizAttemptedCount++;
      } else {
        scores[q.id] = null;
      }
    });

    const finalAvg = quizzes.length > 0 
      ? Math.round((totalScore / quizzes.length) * 10) / 10 
      : 0;

    const letterGrade = getLetterGrade(finalAvg);

    return {
      id: s.id,
      nama: s.nama,
      npm: s.npm,
      avatar: s.avatar,
      quiz_scores: scores,
      completed_quizzes: quizAttemptedCount,
      total_quizzes: quizzes.length,
      final_score: finalAvg,
      letter_grade: letterGrade.grade,
      grade_label: letterGrade.label,
      status: letterGrade.status
    };
  });

  const completedAverages = studentRows.map(r => r.final_score);
  const classAverage = completedAverages.length 
    ? Math.round((completedAverages.reduce((a, b) => a + b, 0) / completedAverages.length) * 10) / 10 
    : 0;

  const passedCount = studentRows.filter(r => r.final_score >= 65).length;
  const passRate = studentRows.length ? Math.round((passedCount / studentRows.length) * 100) : 0;

  res.json({
    class: c,
    quizzes,
    students: studentRows,
    summary: {
      total_students: students.length,
      total_quizzes: quizzes.length,
      class_average: classAverage,
      pass_rate_percent: passRate,
      passed_count: passedCount
    }
  });
});

// Ekspor Rekap Nilai Akhir CSV
app.get('/api/classes/:id/export-csv', requireRole('creator', 'dosen'), (req, res) => {
  const c = db.prepare('SELECT id, name, course FROM classes WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).send('Kelas tidak ditemukan');

  const students = db.prepare('SELECT id, nama, npm FROM students WHERE class_id = ? ORDER BY nama').all(c.id);
  const quizzes = db.prepare('SELECT id, title, type FROM quizzes WHERE class_id = ? ORDER BY created_at ASC').all(c.id);
  const attempts = db.prepare(`SELECT a.student_id, a.quiz_id, a.score FROM attempts a 
    JOIN quizzes q ON q.id = a.quiz_id WHERE q.class_id = ?`).all(c.id);

  const attemptMap = {};
  attempts.forEach(a => {
    attemptMap[`${a.student_id}_${a.quiz_id}`] = a.score;
  });

  let csv = 'Nama Lengkap,ID/NPM,' + quizzes.map(q => `"${q.title} (${q.type})"`).join(',') + ',Rata-Rata Nilai Akhir,Nilai Mutu Huruf,Status Kelulusan\n';
  students.forEach(s => {
    let total = 0;
    const scores = quizzes.map(q => {
      const val = attemptMap[`${s.id}_${q.id}`];
      if (val !== undefined) {
        total += val;
        return val;
      }
      return 0;
    });
    const avg = quizzes.length > 0 ? Math.round((total / quizzes.length) * 10) / 10 : 0;
    const grade = getLetterGrade(avg);
    csv += `"${s.nama}","${s.npm}",` + scores.join(',') + `,${avg},"${grade.grade}","${grade.status}"\n`;
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Rekap_Nilai_Akhir_${c.name.replace(/[^a-zA-Z0-9]/g, '_')}.csv"`);
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
  const { answers, time_spent_sec, tab_switches } = req.body || {};
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
    db.prepare(`INSERT INTO attempts (quiz_id, student_id, score, correct_count, total_count, answers, time_spent_sec, tab_switches)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        quiz.id, req.student.id, score, correct, qs.length, JSON.stringify(answers || {}), Number(time_spent_sec) || 0, Number(tab_switches) || 0
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
