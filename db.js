// node:sqlite (bawaan Node >= 22.5) - tanpa dependency native
// Skema v2: akun (dosen & mahasiswa), kelas, quiz per kelas, attempts
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DB_PATH || 'quiz.db');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA_VERSION = 2;
const current = db.prepare('PRAGMA user_version').get().user_version;

// migrasi dari skema v1 (MVP tanpa akun/kelas): data lama cuma sample, di-reset
if (current < 2) {
  db.exec(`
    DROP TABLE IF EXISTS attempts;
    DROP TABLE IF EXISTS questions;
    DROP TABLE IF EXISTS quizzes;
  `);
}

db.exec(`
CREATE TABLE IF NOT EXISTS dosen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dosen_id INTEGER NOT NULL REFERENCES dosen(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  course TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  nama TEXT NOT NULL,
  npm TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('pre','post')),
  duration_min INTEGER,
  deadline TEXT,
  pair_key TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  options TEXT NOT NULL,
  correct_idx INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  correct_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  answers TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (quiz_id, student_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('dosen','mahasiswa')),
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_class ON quizzes(class_id);
CREATE INDEX IF NOT EXISTS idx_attempts_student ON attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_attempts_quiz ON attempts(quiz_id);
`);

db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

module.exports = db;
