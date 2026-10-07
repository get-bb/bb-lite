CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  password_hash TEXT,
  external_id TEXT,
  avatar_url TEXT,
  disabled_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX users_email_idx ON users (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_external_idx ON users (external_id)
  WHERE external_id IS NOT NULL;
INSERT INTO users (id, name, role, created_at, updated_at)
VALUES ('usr_owner', 'Owner', 'owner', unixepoch() * 1000, unixepoch() * 1000);

CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);

CREATE TABLE user_invites (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('invite', 'sign-in')),
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  name TEXT,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

ALTER TABLE hosts ADD COLUMN owner_user_id TEXT
  REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE hosts ADD COLUMN sharing TEXT NOT NULL DEFAULT 'private'
  CHECK (sharing IN ('private', 'shared'));
UPDATE hosts SET owner_user_id = 'usr_owner';

ALTER TABLE threads ADD COLUMN created_by_user_id TEXT
  REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE threads ADD COLUMN last_actor_user_id TEXT
  REFERENCES users (id) ON DELETE SET NULL;
UPDATE threads
SET created_by_user_id = 'usr_owner', last_actor_user_id = 'usr_owner';

ALTER TABLE queued_thread_messages ADD COLUMN requested_by_user_id TEXT;
ALTER TABLE prompt_history_entries
  ADD COLUMN user_id TEXT NOT NULL DEFAULT 'usr_owner';

CREATE TABLE thread_user_state (
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL DEFAULT 'usr_owner'
    REFERENCES users (id) ON DELETE CASCADE,
  last_read_at INTEGER,
  pinned_at INTEGER,
  pin_sort_key TEXT,
  section_id TEXT,
  PRIMARY KEY (thread_id, user_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX thread_user_state_user_idx
  ON thread_user_state (user_id, pinned_at);
CREATE INDEX thread_user_state_section_idx ON thread_user_state (section_id);
INSERT INTO thread_user_state
  (thread_id, user_id, last_read_at, pinned_at, pin_sort_key, section_id)
SELECT id, 'usr_owner', last_read_at, pinned_at, pin_sort_key, section_id
FROM threads;

CREATE TABLE thread_sections_next (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'usr_owner'
    REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
) STRICT;
INSERT INTO thread_sections_next (id, name, created_at, updated_at)
SELECT id, name, created_at, updated_at FROM thread_sections;
DROP INDEX threads_section_idx;
UPDATE threads SET pinned_at = NULL, pin_sort_key = NULL, section_id = NULL;
DROP TABLE thread_sections;
ALTER TABLE thread_sections_next RENAME TO thread_sections;

CREATE TABLE ui_preferences_next (
  user_id TEXT NOT NULL DEFAULT 'usr_owner'
    REFERENCES users (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
) STRICT;
INSERT INTO ui_preferences_next (key, value_json, revision, updated_at)
SELECT key, value_json, revision, updated_at FROM ui_preferences;
DROP TABLE ui_preferences;
ALTER TABLE ui_preferences_next RENAME TO ui_preferences;

CREATE TABLE thread_tabs_next (
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL DEFAULT 'usr_owner'
    REFERENCES users (id) ON DELETE CASCADE,
  tabs_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
) STRICT;
INSERT INTO thread_tabs_next (thread_id, tabs_json, revision, updated_at)
SELECT thread_id, tabs_json, revision, updated_at FROM thread_tabs;
DROP TABLE thread_tabs;
ALTER TABLE thread_tabs_next RENAME TO thread_tabs;
