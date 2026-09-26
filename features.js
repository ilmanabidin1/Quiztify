// Fitur retensi & pertumbuhan Quiztify:
// rapor semester, 5 soal harian + streak, liga mingguan, dan duel 1 lawan 1.
const crypto = require('crypto');

const DIVISIONS = ['Perunggu', 'Perak', 'Emas', 'Berlian'];
const DAILY_SIZE = 5;
const REVIEW_GAPS = [1, 3, 7, 14]; // hari sampai soal yang pernah salah muncul lagi
const DUEL_SIZE = 5;
const DUEL_TIME_MS = 20000;

// Tanggal & minggu dihitung di WIB supaya "hari ini" sesuai jam mahasiswa
function wibDate(offsetDays = 0) {
  return new Date(Date.now() + 7 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function weekStart(dateStr = wibDate()) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // Senin = 0
  return addDays(dateStr, -dow);
}
const cleanName = (v) => String(v || '').trim().replace(/[<>"'`&]/g, '').slice(0, 24);
const cleanAvatar = (v) => (typeof v === 'string' && v && !/[<>"'`&]/.test(v)) ? v.slice(0, 8) : '🦊';

module.exports = function registerFeatures(app, { db, auth, requireRole, requireStudent, requirePaid, ngain }) {
  // ---------- Skema ----------
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      question_ids TEXT NOT NULL,
      answers TEXT DEFAULT '{}',
      correct INTEGER DEFAULT 0,
      xp INTEGER DEFAULT 0,
      done INTEGER DEFAULT 0,
      UNIQUE (student_id, date)
    );
    CREATE TABLE IF NOT EXISTS question_mistakes (
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      box INTEGER DEFAULT 0,
      next_due TEXT NOT NULL,
      PRIMARY KEY (student_id, question_id)
    );
    CREATE TABLE IF NOT EXISTS duels (
      code TEXT PRIMARY KEY,
      quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      question_ids TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS duel_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL REFERENCES duels(code) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      avatar TEXT DEFAULT '🦊',
      answers TEXT DEFAULT '[]',
      correct INTEGER DEFAULT 0,
      score INTEGER DEFAULT 0,
      time_ms INTEGER DEFAULT 0,
      finished INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const addCol = (table, def) => { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`); } catch (_) {} };
  addCol('students', 'streak_days INTEGER DEFAULT 0');
  addCol('students', 'best_streak INTEGER DEFAULT 0');
  addCol('students', 'last_daily_date TEXT');
  addCol('students', 'division INTEGER DEFAULT 0');
  addCol('classes', 'league_week TEXT');

  // ---------- Rapor semester (akreditasi) ----------
  app.get('/api/classes/:id/semester-report', requireRole('creator', 'dosen'), requirePaid('Rapor semester'), (req, res) => {
    const c = db.prepare(`SELECT c.*, d.nama AS dosen_nama, d.institution FROM classes c JOIN dosen d ON d.id = c.dosen_id
      WHERE c.id = ? AND c.dosen_id = ?`).get(req.params.id, req.auth.user_id);
    if (!c) return res.status(404).json({ error: 'Kelas tidak ditemukan' });

    const students = db.prepare('SELECT id, nama, npm FROM students WHERE class_id = ? ORDER BY nama').all(c.id);
    const quizzes = db.prepare(`SELECT q.id, q.title, q.type, q.pair_key, q.category, q.created_at,
        COUNT(a.id) AS n, ROUND(AVG(a.score), 1) AS avg_score, SUM(COALESCE(a.tab_switches, 0)) AS tab_switches
      FROM quizzes q LEFT JOIN attempts a ON a.quiz_id = q.id
      WHERE q.class_id = ? GROUP BY q.id ORDER BY q.created_at ASC`).all(c.id);
    const scores = db.prepare(`SELECT a.student_id, q.pair_key, q.type, a.score FROM attempts a JOIN quizzes q ON q.id = a.quiz_id
      WHERE q.class_id = ? AND q.pair_key IS NOT NULL`).all(c.id);

    // Per pasangan Pre/Post: rata-rata pre, post, dan N-Gain
    const byPair = {};
    for (const s of scores) {
      const p = (byPair[s.pair_key] = byPair[s.pair_key] || {});
      (p[s.student_id] = p[s.student_id] || {})[s.type] = s.score;
    }
    const category = (g) => g === null ? '-' : g >= 0.7 ? 'Tinggi' : g >= 0.3 ? 'Sedang' : 'Rendah';
    const avg = (arr) => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : null;
    const pairs = Object.entries(byPair).map(([key, per]) => {
      const rows = Object.values(per).filter(r => r.pre !== undefined && r.post !== undefined);
      const g = avg(rows.map(r => ngain(r.pre, r.post)));
      const title = (quizzes.find(q => q.pair_key === key && q.type === 'post') || quizzes.find(q => q.pair_key === key) || {}).title || key;
      return {
        key, title: title.replace(/^\s*(pre|post)[\s-]*test\s*[:\-]?\s*/i, '') || title, n: rows.length,
        avg_pre: avg(rows.map(r => r.pre)), avg_post: avg(rows.map(r => r.post)),
        avg_ngain: g, category: category(g)
      };
    });

    const perStudent = students.map(s => {
      const own = db.prepare(`SELECT a.score FROM attempts a JOIN quizzes q ON q.id = a.quiz_id WHERE q.class_id = ? AND a.student_id = ?`).all(c.id, s.id);
      const gains = Object.values(byPair).map(p => p[s.id]).filter(r => r && r.pre !== undefined && r.post !== undefined).map(r => ngain(r.pre, r.post));
      return { ...s, n_quizzes: own.length, avg_score: avg(own.map(o => o.score)), avg_ngain: avg(gains), category: category(avg(gains)) };
    });

    const allGains = pairs.filter(p => p.avg_ngain !== null).map(p => p.avg_ngain);
    res.json({
      class: { id: c.id, name: c.name, course: c.course, code: c.code, dosen: c.dosen_nama, institution: c.institution },
      generated_at: new Date().toISOString(),
      summary: {
        n_students: students.length,
        n_quizzes: quizzes.length,
        participation: students.length && quizzes.length
          ? Math.round((quizzes.reduce((a, q) => a + q.n, 0) / (students.length * quizzes.length)) * 100) : 0,
        avg_ngain: avg(allGains),
        category: category(avg(allGains)),
        tab_switches: quizzes.reduce((a, q) => a + (q.tab_switches || 0), 0)
      },
      pairs, quizzes, students: perStudent
    });
  });

  // ---------- Mahasiswa: daftar dengan kode kelas ----------
  app.get('/api/classes/by-code/:code', (req, res) => {
    const c = db.prepare('SELECT id, name, course, code FROM classes WHERE upper(code) = upper(?)').get(String(req.params.code || '').trim());
    if (!c) return res.status(404).json({ error: 'Kode kelas tidak ditemukan' });
    res.json(c);
  });

  // ---------- Liga mingguan ----------
  function weeklyXp(studentIds, week) {
    if (!studentIds.length) return {};
    const end = addDays(week, 7);
    const ph = studentIds.map(() => '?').join(',');
    const xp = Object.fromEntries(studentIds.map(id => [id, 0]));
    db.prepare(`SELECT student_id, SUM(xp) AS x FROM daily_sessions WHERE student_id IN (${ph}) AND date >= ? AND date < ? GROUP BY student_id`)
      .all(...studentIds, week, end).forEach(r => { xp[r.student_id] += r.x || 0; });
    db.prepare(`SELECT student_id, SUM(score / 2) AS x FROM attempts WHERE student_id IN (${ph})
        AND date(created_at, '+7 hours') >= ? AND date(created_at, '+7 hours') < ? GROUP BY student_id`)
      .all(...studentIds, week, end).forEach(r => { xp[r.student_id] += r.x || 0; });
    return xp;
  }

  // Promosi/degradasi dijalankan sekali per kelas saat minggu berganti
  function rolloverLeague(classId) {
    const c = db.prepare('SELECT league_week FROM classes WHERE id = ?').get(classId);
    const current = weekStart();
    if (!c || c.league_week === current) return;
    if (c.league_week) {
      const students = db.prepare('SELECT id, division FROM students WHERE class_id = ?').all(classId);
      const xp = weeklyXp(students.map(s => s.id), c.league_week);
      const upd = db.prepare('UPDATE students SET division = ? WHERE id = ?');
      for (let d = 0; d < DIVISIONS.length; d++) {
        const group = students.filter(s => (s.division || 0) === d).sort((a, b) => xp[b.id] - xp[a.id]);
        if (group.length < 2) continue;
        const zone = group.length >= 6 ? 3 : 1;
        if (d < DIVISIONS.length - 1) group.slice(0, zone).filter(s => xp[s.id] > 0).forEach(s => upd.run(d + 1, s.id));
        if (d > 0 && group.length >= 4) group.slice(-zone).forEach(s => upd.run(d - 1, s.id));
      }
    }
    db.prepare('UPDATE classes SET league_week = ? WHERE id = ?').run(current, classId);
  }

  function leagueFor(student) {
    if (!student.class_id) return null;
    rolloverLeague(student.class_id);
    const me = db.prepare('SELECT division FROM students WHERE id = ?').get(student.id);
    const division = me ? me.division || 0 : 0;
    const members = db.prepare('SELECT id, nama, avatar FROM students WHERE class_id = ? AND COALESCE(division, 0) = ?').all(student.class_id, division);
    const week = weekStart();
    const xp = weeklyXp(members.map(m => m.id), week);
    const ranked = members.map(m => ({ id: m.id, nama: m.nama, avatar: m.avatar, xp: xp[m.id] || 0, is_me: m.id === student.id }))
      .sort((a, b) => b.xp - a.xp || a.nama.localeCompare(b.nama))
      .map((m, i) => ({ ...m, rank: i + 1 }));
    const zone = ranked.length >= 6 ? 3 : 1;
    ranked.forEach(m => {
      m.zone = (division < DIVISIONS.length - 1 && m.rank <= zone && m.xp > 0) ? 'up'
        : (division > 0 && ranked.length >= 4 && m.rank > ranked.length - zone) ? 'down' : null;
    });
    const endsAt = new Date(addDays(week, 7) + 'T00:00:00+07:00').toISOString();
    return { division, division_name: DIVISIONS[division], week, ends_at: endsAt, members: ranked.map(({ id, ...m }) => m) };
  }

  app.get('/api/student/league', requireStudent, (req, res) => {
    const league = leagueFor(req.student);
    if (!league) return res.status(400).json({ error: 'Kamu belum tergabung di kelas' });
    res.json(league);
  });

  // ---------- 5 soal harian + spaced repetition ----------
  function syncMistakes(studentId) {
    const today = wibDate();
    const rows = db.prepare('SELECT quiz_id, answers FROM attempts WHERE student_id = ?').all(studentId);
    const ins = db.prepare('INSERT OR IGNORE INTO question_mistakes (student_id, question_id, box, next_due) VALUES (?, ?, 0, ?)');
    for (const r of rows) {
      const ans = JSON.parse(r.answers || '{}');
      for (const q of db.prepare('SELECT id, correct_idx FROM questions WHERE quiz_id = ?').all(r.quiz_id)) {
        if (ans[q.id] !== undefined && Number(ans[q.id]) !== q.correct_idx) ins.run(studentId, q.id, today);
      }
    }
  }

  function getOrCreateDaily(student) {
    const today = wibDate();
    let s = db.prepare('SELECT * FROM daily_sessions WHERE student_id = ? AND date = ?').get(student.id, today);
    if (s) return s;

    syncMistakes(student.id);
    // Hanya soal dari kuis yang sudah dikerjakan, supaya soal ujian tidak bocor sebelum waktunya
    const due = db.prepare(`SELECT m.question_id AS id FROM question_mistakes m JOIN questions q ON q.id = m.question_id
      WHERE m.student_id = ? AND m.next_due <= ? ORDER BY m.next_due ASC, RANDOM() LIMIT ?`).all(student.id, today, DAILY_SIZE).map(r => r.id);
    const fill = db.prepare(`SELECT q.id FROM questions q JOIN attempts a ON a.quiz_id = q.quiz_id
      WHERE a.student_id = ? ORDER BY RANDOM() LIMIT ?`).all(student.id, DAILY_SIZE * 3).map(r => r.id);
    const ids = [...new Set([...due, ...fill])].slice(0, DAILY_SIZE);
    if (!ids.length) return null;

    db.prepare('INSERT INTO daily_sessions (student_id, date, question_ids) VALUES (?, ?, ?)').run(student.id, today, JSON.stringify(ids));
    return db.prepare('SELECT * FROM daily_sessions WHERE student_id = ? AND date = ?').get(student.id, today);
  }

  function streakInfo(studentId) {
    const s = db.prepare('SELECT streak_days, best_streak, last_daily_date FROM students WHERE id = ?').get(studentId) || {};
    const today = wibDate(), yesterday = wibDate(-1);
    // Streak dianggap putus jika kemarin dan hari ini sama-sama tidak mengerjakan
    const alive = s.last_daily_date === today || s.last_daily_date === yesterday;
    return { streak: alive ? (s.streak_days || 0) : 0, best: s.best_streak || 0, done_today: s.last_daily_date === today };
  }

  function dailyPayload(session) {
    const ids = JSON.parse(session.question_ids);
    const answers = JSON.parse(session.answers || '{}');
    const qs = ids.map(id => db.prepare(`SELECT q.id, q.text, q.options, q.correct_idx, q.explanation, z.title AS quiz_title
      FROM questions q JOIN quizzes z ON z.id = q.quiz_id WHERE q.id = ?`).get(id)).filter(Boolean);
    const due = db.prepare('SELECT question_id FROM question_mistakes WHERE student_id = ?').all(session.student_id).map(r => r.question_id);
    return {
      date: session.date, done: Boolean(session.done), correct: session.correct, xp: session.xp,
      questions: qs.map(q => {
        const a = answers[q.id];
        return {
          id: q.id, text: q.text, options: JSON.parse(q.options || '[]'), quiz_title: q.quiz_title,
          is_review: due.includes(q.id),
          answered: a !== undefined,
          ...(a !== undefined ? { your_answer: a, correct_idx: q.correct_idx, explanation: q.explanation } : {})
        };
      })
    };
  }

  app.get('/api/student/daily', requireStudent, (req, res) => {
    const session = getOrCreateDaily(req.student);
    if (!session) return res.json({ empty: true, message: 'Kerjakan minimal satu kuis kelas dulu. Soal harian diambil dari kuis yang sudah kamu kerjakan.', streak: streakInfo(req.student.id) });
    res.json({ ...dailyPayload(session), streak: streakInfo(req.student.id) });
  });

  app.post('/api/student/daily/answer', requireStudent, (req, res) => {
    const today = wibDate();
    const session = db.prepare('SELECT * FROM daily_sessions WHERE student_id = ? AND date = ?').get(req.student.id, today);
    if (!session) return res.status(400).json({ error: 'Sesi harian belum dimulai' });
    const qid = Number(req.body && req.body.question_id);
    const choice = Number(req.body && req.body.answer_idx);
    const ids = JSON.parse(session.question_ids);
    if (!ids.includes(qid)) return res.status(400).json({ error: 'Soal ini bukan bagian dari sesi hari ini' });
    const answers = JSON.parse(session.answers || '{}');
    if (answers[qid] !== undefined) return res.status(409).json({ error: 'Soal ini sudah dijawab' });

    const q = db.prepare('SELECT correct_idx, explanation FROM questions WHERE id = ?').get(qid);
    const ok = choice === q.correct_idx;
    answers[qid] = choice;

    // Spaced repetition: benar = jeda makin panjang, salah = ulang besok
    const m = db.prepare('SELECT box FROM question_mistakes WHERE student_id = ? AND question_id = ?').get(req.student.id, qid);
    if (ok && m) {
      if (m.box + 1 >= REVIEW_GAPS.length) db.prepare('DELETE FROM question_mistakes WHERE student_id = ? AND question_id = ?').run(req.student.id, qid);
      else db.prepare('UPDATE question_mistakes SET box = ?, next_due = ? WHERE student_id = ? AND question_id = ?')
        .run(m.box + 1, addDays(today, REVIEW_GAPS[m.box + 1]), req.student.id, qid);
    } else if (!ok) {
      db.prepare(`INSERT INTO question_mistakes (student_id, question_id, box, next_due) VALUES (?, ?, 0, ?)
        ON CONFLICT(student_id, question_id) DO UPDATE SET box = 0, next_due = excluded.next_due`).run(req.student.id, qid, addDays(today, 1));
    }

    const correct = session.correct + (ok ? 1 : 0);
    const finished = Object.keys(answers).length >= ids.length;
    let xp = session.xp, streak = null;
    if (finished && !session.done) {
      xp = correct * 10 + 20;
      const st = db.prepare('SELECT streak_days, best_streak, last_daily_date FROM students WHERE id = ?').get(req.student.id);
      const next = st.last_daily_date === wibDate(-1) ? (st.streak_days || 0) + 1 : (st.last_daily_date === today ? st.streak_days : 1);
      db.prepare('UPDATE students SET streak_days = ?, best_streak = MAX(COALESCE(best_streak, 0), ?), last_daily_date = ?, points = points + ? WHERE id = ?')
        .run(next, next, today, xp, req.student.id);
      streak = next;
    }
    db.prepare('UPDATE daily_sessions SET answers = ?, correct = ?, xp = ?, done = ? WHERE id = ?')
      .run(JSON.stringify(answers), correct, xp, finished ? 1 : 0, session.id);

    res.json({ correct: ok, correct_idx: q.correct_idx, explanation: q.explanation, finished, total_correct: correct, xp, streak });
  });

  // Ringkasan beranda mahasiswa
  app.get('/api/student/home', requireStudent, (req, res) => {
    const s = req.student;
    const cls = s.class_id ? db.prepare('SELECT id, name, course, code FROM classes WHERE id = ?').get(s.class_id) : null;
    const pending = s.class_id ? db.prepare(`SELECT COUNT(*) AS n FROM quizzes q WHERE q.class_id = ? AND q.active = 1
      AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.quiz_id = q.id AND a.student_id = ?)`).get(s.class_id, s.id).n : 0;
    const league = leagueFor(s);
    const me = league ? league.members.find(m => m.is_me) : null;
    const reviewDue = db.prepare('SELECT COUNT(*) AS n FROM question_mistakes WHERE student_id = ? AND next_due <= ?').get(s.id, wibDate()).n;
    res.json({
      student: { id: s.id, nama: s.nama, npm: s.npm, avatar: s.avatar, points: s.points },
      class: cls, pending_quizzes: pending, streak: streakInfo(s.id), review_due: reviewDue,
      league: league ? { division_name: league.division_name, rank: me ? me.rank : null, size: league.members.length, xp: me ? me.xp : 0, ends_at: league.ends_at } : null
    });
  });

  // ---------- Duel 1 lawan 1 ----------
  function newDuelCode() {
    for (let i = 0; i < 20; i++) {
      const code = crypto.randomBytes(4).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase();
      if (code.length === 6 && !db.prepare('SELECT 1 FROM duels WHERE code = ?').get(code)) return code;
    }
    throw new Error('Gagal membuat kode duel');
  }

  app.post('/api/duels', (req, res) => {
    const { pin, player_token, quiz_id, name, avatar } = req.body || {};
    let quizId = null;
    if (pin && player_token) {
      const p = db.prepare('SELECT r.quiz_id FROM room_players rp JOIN game_rooms r ON r.pin = rp.pin WHERE rp.pin = ? AND rp.player_token = ?').get(String(pin), String(player_token));
      if (!p) return res.status(403).json({ error: 'Kamu bukan peserta kuis ini' });
      quizId = p.quiz_id;
    } else if (quiz_id) {
      // Mahasiswa hanya bisa menantang dari kuis yang sudah dikerjakan, supaya soal ujian tidak bocor
      const a = auth(req);
      const isStudent = a && (a.role === 'student' || a.role === 'mahasiswa');
      if (!isStudent || !db.prepare('SELECT 1 FROM attempts WHERE quiz_id = ? AND student_id = ?').get(Number(quiz_id), a.user_id)) {
        return res.status(403).json({ error: 'Duel hanya bisa dibuat dari kuis yang sudah kamu kerjakan' });
      }
      quizId = Number(quiz_id);
    } else {
      return res.status(400).json({ error: 'Pilih kuis untuk duel' });
    }
    const ids = db.prepare('SELECT id FROM questions WHERE quiz_id = ? ORDER BY RANDOM() LIMIT ?').all(quizId, DUEL_SIZE).map(r => r.id);
    if (ids.length < 2) return res.status(400).json({ error: 'Kuis ini terlalu sedikit soalnya untuk duel' });
    const code = newDuelCode();
    db.prepare('INSERT INTO duels (code, quiz_id, question_ids) VALUES (?, ?, ?)').run(code, quizId, JSON.stringify(ids));
    let token = null;
    const nm = cleanName(name);
    if (nm.length >= 2) {
      token = 'd_' + crypto.randomBytes(12).toString('hex');
      db.prepare('INSERT INTO duel_entries (code, token, name, avatar) VALUES (?, ?, ?, ?)').run(code, token, nm, cleanAvatar(avatar));
    }
    res.json({ code, token });
  });

  function duelView(code, token) {
    const d = db.prepare('SELECT d.*, q.title FROM duels d JOIN quizzes q ON q.id = d.quiz_id WHERE d.code = ?').get(String(code).toUpperCase());
    if (!d) return null;
    const ids = JSON.parse(d.question_ids);
    const questions = ids.map(id => db.prepare('SELECT id, text, options FROM questions WHERE id = ?').get(id)).filter(Boolean)
      .map(q => ({ text: q.text, options: JSON.parse(q.options || '[]') }));
    const entries = db.prepare('SELECT token, name, avatar, correct, score, time_ms, finished, answers FROM duel_entries WHERE code = ? ORDER BY score DESC, time_ms ASC').all(d.code)
      .map(e => ({ name: e.name, avatar: e.avatar, correct: e.correct, score: e.score, time_ms: e.time_ms, finished: Boolean(e.finished), progress: JSON.parse(e.answers || '[]').length, is_me: Boolean(token) && e.token === String(token) }));
    const mine = token ? db.prepare('SELECT name, avatar, answers FROM duel_entries WHERE code = ? AND token = ?').get(d.code, String(token)) : null;
    const me = mine ? { name: mine.name, avatar: mine.avatar, progress: JSON.parse(mine.answers || '[]').length } : null;
    return { code: d.code, quiz_title: d.title, questions, total: questions.length, time_limit_ms: DUEL_TIME_MS, entries, me };
  }

  app.get('/api/duels/:code', (req, res) => {
    const v = duelView(req.params.code, req.query.token);
    if (!v) return res.status(404).json({ error: 'Duel tidak ditemukan' });
    res.json(v);
  });

  app.post('/api/duels/:code/join', (req, res) => {
    const d = db.prepare('SELECT code FROM duels WHERE code = ?').get(String(req.params.code).toUpperCase());
    if (!d) return res.status(404).json({ error: 'Duel tidak ditemukan' });
    const nm = cleanName(req.body && req.body.name);
    if (nm.length < 2) return res.status(400).json({ error: 'Nama minimal 2 karakter' });
    const count = db.prepare('SELECT COUNT(*) AS n FROM duel_entries WHERE code = ?').get(d.code).n;
    if (count >= 10) return res.status(403).json({ error: 'Duel ini sudah penuh' });
    const token = 'd_' + crypto.randomBytes(12).toString('hex');
    db.prepare('INSERT INTO duel_entries (code, token, name, avatar) VALUES (?, ?, ?, ?)').run(d.code, token, nm, cleanAvatar(req.body.avatar));
    res.json({ token });
  });

  app.post('/api/duels/:code/answer', (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const { token, answer_idx, time_ms } = req.body || {};
    const e = db.prepare('SELECT * FROM duel_entries WHERE code = ? AND token = ?').get(code, String(token || ''));
    if (!e) return res.status(403).json({ error: 'Token duel tidak valid' });
    const d = db.prepare('SELECT question_ids FROM duels WHERE code = ?').get(code);
    const ids = JSON.parse(d.question_ids);
    const answers = JSON.parse(e.answers || '[]');
    if (answers.length >= ids.length) return res.status(409).json({ error: 'Duel sudah selesai' });

    const q = db.prepare('SELECT correct_idx, explanation FROM questions WHERE id = ?').get(ids[answers.length]);
    const t = Math.min(DUEL_TIME_MS, Math.max(0, Number(time_ms) || DUEL_TIME_MS));
    const ok = Number(answer_idx) === q.correct_idx;
    const pts = ok ? 100 + Math.round(50 * (1 - t / DUEL_TIME_MS)) : 0;
    answers.push(Number.isInteger(Number(answer_idx)) ? Number(answer_idx) : -1);
    const finished = answers.length >= ids.length;
    db.prepare('UPDATE duel_entries SET answers = ?, correct = correct + ?, score = score + ?, time_ms = time_ms + ?, finished = ? WHERE id = ?')
      .run(JSON.stringify(answers), ok ? 1 : 0, pts, t, finished ? 1 : 0, e.id);
    res.json({ correct: ok, correct_idx: q.correct_idx, explanation: q.explanation, points: pts, finished });
  });

  return { leagueFor, streakInfo };
};
