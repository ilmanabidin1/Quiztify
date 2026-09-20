// node:sqlite (bawaan Node >= 22.5) - tanpa dependency native
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DB_PATH || 'quiz.db');
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  course TEXT DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('pre','post')),
  class_name TEXT DEFAULT '',
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
  nama TEXT NOT NULL,
  npm TEXT NOT NULL,
  score INTEGER NOT NULL,
  correct_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  answers TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (quiz_id, npm)
);
CREATE INDEX IF NOT EXISTS idx_attempts_npm ON attempts(npm);
CREATE INDEX IF NOT EXISTS idx_attempts_quiz ON attempts(quiz_id);
`);

module.exports = db;
