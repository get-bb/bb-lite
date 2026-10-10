CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  op TEXT NOT NULL,
  kind TEXT NOT NULL,
  user_id TEXT,
  role TEXT NOT NULL,
  door TEXT NOT NULL,
  thread_id TEXT,
  via TEXT NOT NULL,
  hooks TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT,
  duration_ms INTEGER NOT NULL,
  input TEXT
);

CREATE INDEX audit_log_user_idx ON audit_log (user_id, id);
CREATE INDEX audit_log_op_idx ON audit_log (op, id);
