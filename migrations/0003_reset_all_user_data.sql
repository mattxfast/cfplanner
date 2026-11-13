-- Explicit reset requested for CFPlanner V2.
-- This removes every account and all user-owned data. Foreign keys cascade
-- through sessions, programmes, legacy weekly entries, WOD templates and sessions.
DELETE FROM users;
