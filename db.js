// Quiztify.id - Database & Schema Management
// node:sqlite (bawaan Node >= 22.5) - ultra-fast persistent SQLite tanpa native build
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH
  || (fs.existsSync('/data') ? '/data/quiztify.db' : (fs.existsSync('quiz.db') ? 'quiz.db' : 'quiztify.db'));

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA_VERSION = 3;
const current = db.prepare('PRAGMA user_version').get().user_version;

// Inisialisasi tabel dasar jika belum ada
db.exec(`
CREATE TABLE IF NOT EXISTS dosen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  plan TEXT DEFAULT 'pro',
  institution TEXT DEFAULT 'Quiztify Academy',
  manual_pw INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dosen_id INTEGER NOT NULL REFERENCES dosen(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  course TEXT DEFAULT '',
  code TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  nama TEXT NOT NULL,
  npm TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  points INTEGER DEFAULT 0,
  avatar TEXT DEFAULT '🦊',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  creator_id INTEGER REFERENCES dosen(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT DEFAULT 'Umum',
  type TEXT NOT NULL CHECK (type IN ('standard', 'pre', 'post')) DEFAULT 'standard',
  cover_emoji TEXT DEFAULT '⚡',
  duration_min INTEGER,
  time_per_q INTEGER DEFAULT 30,
  points_per_q INTEGER DEFAULT 1000,
  deadline TEXT,
  pair_key TEXT,
  is_public INTEGER DEFAULT 1,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  options TEXT NOT NULL,
  correct_idx INTEGER NOT NULL,
  time_limit INTEGER DEFAULT 30,
  points INTEGER DEFAULT 1000,
  explanation TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  correct_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  answers TEXT,
  time_spent_sec INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (quiz_id, student_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('dosen', 'creator', 'mahasiswa', 'student')),
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_rooms (
  pin TEXT PRIMARY KEY,
  quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  host_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('lobby', 'question', 'leaderboard', 'finished')) DEFAULT 'lobby',
  current_q_idx INTEGER DEFAULT 0,
  q_started_at INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS room_players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pin TEXT NOT NULL REFERENCES game_rooms(pin) ON DELETE CASCADE,
  player_token TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '🦊',
  score INTEGER DEFAULT 0,
  streak INTEGER DEFAULT 0,
  last_correct INTEGER DEFAULT 0,
  last_points INTEGER DEFAULT 0,
  answers_json TEXT DEFAULT '{}',
  updated_at INTEGER DEFAULT 0,
  UNIQUE (pin, player_token)
);

CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_class ON quizzes(class_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_creator ON quizzes(creator_id);
CREATE INDEX IF NOT EXISTS idx_attempts_student ON attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_attempts_quiz ON attempts(quiz_id);
CREATE INDEX IF NOT EXISTS idx_room_players_pin ON room_players(pin);
`);

// Migrasi kolom jika upgrade dari skema lama
function safeAddColumn(table, colDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
  } catch (e) {
    // kolom sudah ada
  }
}

safeAddColumn('dosen', 'plan TEXT DEFAULT "pro"');
safeAddColumn('dosen', 'institution TEXT DEFAULT "Quiztify Academy"');
safeAddColumn('dosen', 'manual_pw INTEGER DEFAULT 0');

safeAddColumn('quizzes', 'creator_id INTEGER');
safeAddColumn('quizzes', 'description TEXT DEFAULT ""');
safeAddColumn('quizzes', 'category TEXT DEFAULT "Umum"');
safeAddColumn('quizzes', 'cover_emoji TEXT DEFAULT "⚡"');
safeAddColumn('quizzes', 'time_per_q INTEGER DEFAULT 30');
safeAddColumn('quizzes', 'points_per_q INTEGER DEFAULT 1000');
safeAddColumn('quizzes', 'is_public INTEGER DEFAULT 1');

safeAddColumn('questions', 'time_limit INTEGER DEFAULT 30');
safeAddColumn('questions', 'points INTEGER DEFAULT 1000');
safeAddColumn('questions', 'explanation TEXT DEFAULT ""');

safeAddColumn('students', 'points INTEGER DEFAULT 0');
safeAddColumn('students', 'avatar TEXT DEFAULT "🦊"');

safeAddColumn('game_rooms', 'game_mode TEXT DEFAULT "self_paced"');
safeAddColumn('room_players', 'current_q_idx INTEGER DEFAULT 0');
safeAddColumn('room_players', 'finished INTEGER DEFAULT 0');
safeAddColumn('room_players', 'tab_switches INTEGER DEFAULT 0');

safeAddColumn('attempts', 'tab_switches INTEGER DEFAULT 0');

safeAddColumn('quizzes', 'exam_mode INTEGER DEFAULT 0');
safeAddColumn('quizzes', 'homework_mode INTEGER DEFAULT 0');
safeAddColumn('quizzes', 'is_remedial_for INTEGER DEFAULT 0');
safeAddColumn('quizzes', 'break_time_sec INTEGER DEFAULT 5');
safeAddColumn('quizzes', 'theme TEXT DEFAULT "cyberpunk"');
safeAddColumn('quizzes', 'settings_json TEXT DEFAULT "{}"');

safeAddColumn('dosen', 'plan_expires_at TEXT');
safeAddColumn('dosen', 'quota_ai_gen INTEGER DEFAULT 50');
safeAddColumn('dosen', 'ai_used_month TEXT');
safeAddColumn('game_rooms', 'team_count INTEGER DEFAULT 0');
safeAddColumn('room_players', 'team INTEGER');
safeAddColumn('dosen', 'ai_used_count INTEGER DEFAULT 0');

db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

module.exports = db;
