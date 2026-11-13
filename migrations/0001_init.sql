PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS programs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_monday TEXT NOT NULL,
  end_monday TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (start_monday <= end_monday)
);
CREATE INDEX IF NOT EXISTS programs_user_dates ON programs(user_id, start_monday, end_monday);

CREATE TABLE IF NOT EXISTS weekly_entries (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_monday TEXT NOT NULL,
  category TEXT NOT NULL,
  target_count INTEGER NOT NULL DEFAULT 0 CHECK(target_count >= 0),
  done_count INTEGER NOT NULL DEFAULT 0 CHECK(done_count >= 0),
  planned_comment TEXT NOT NULL DEFAULT '',
  actual_comment TEXT NOT NULL DEFAULT '',
  UNIQUE(program_id, week_monday, category)
);
CREATE INDEX IF NOT EXISTS weekly_entries_user_week ON weekly_entries(user_id, week_monday);
