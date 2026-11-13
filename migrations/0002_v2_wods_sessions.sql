-- CFPlanner V2: reusable WOD templates and dated training sessions.
-- Existing V1 tables are intentionally preserved for rollback and historical reference.

CREATE TABLE IF NOT EXISTS program_wods (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  planned_comment TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(program_id, name)
);

CREATE INDEX IF NOT EXISTS program_wods_user_program
  ON program_wods(user_id, program_id, sort_order);

CREATE TABLE IF NOT EXISTS training_sessions (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  wod_id TEXT NOT NULL REFERENCES program_wods(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  actual_comment TEXT NOT NULL DEFAULT '',
  -- Legacy V1 entries may represent several sessions without individual dates.
  session_count INTEGER NOT NULL DEFAULT 1 CHECK(session_count >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS training_sessions_user_date
  ON training_sessions(user_id, session_date DESC);
CREATE INDEX IF NOT EXISTS training_sessions_wod_date
  ON training_sessions(wod_id, session_date DESC);

-- Convert each distinct V1 category into one reusable WOD per programme.
-- Keep weekly_entries untouched; no historical data is deleted.
INSERT OR IGNORE INTO program_wods (id, program_id, user_id, name, planned_comment, sort_order)
SELECT
  MIN(id),
  program_id,
  user_id,
  category,
  COALESCE(MAX(planned_comment), ''),
  ROW_NUMBER() OVER (PARTITION BY program_id ORDER BY MIN(category))
FROM weekly_entries
GROUP BY program_id, user_id, category;

-- Preserve V1 completed-session totals as legacy summary records.
-- The original week is used as an approximate date because V1 did not store
-- individual session dates. session_count retains the exact aggregate count.
INSERT INTO training_sessions
  (id, program_id, wod_id, user_id, session_date, actual_comment, session_count)
SELECT
  'legacy-' || e.id,
  e.program_id,
  w.id,
  e.user_id,
  e.week_monday,
  e.actual_comment,
  CASE WHEN e.done_count > 0 THEN e.done_count ELSE 1 END
FROM weekly_entries e
JOIN program_wods w
  ON w.program_id = e.program_id
 AND w.user_id = e.user_id
 AND w.name = e.category
WHERE e.done_count > 0;
