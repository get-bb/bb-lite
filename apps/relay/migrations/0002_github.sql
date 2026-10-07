DROP TABLE users;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT,
  can_host INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
