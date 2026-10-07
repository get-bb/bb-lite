CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  can_host INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label TEXT NOT NULL UNIQUE,
  credential_hash TEXT UNIQUE,
  client_name TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX servers_user_idx ON servers (user_id);

CREATE TABLE link_codes (
  device_code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  server_id TEXT,
  credential TEXT,
  polled_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  credential_hash TEXT UNIQUE,
  code TEXT UNIQUE,
  code_expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX machines_server_idx ON machines (server_id);
