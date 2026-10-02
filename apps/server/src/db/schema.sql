CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'persistent',
  phase TEXT NOT NULL DEFAULT 'active'
    CHECK (phase IN ('creating', 'active', 'removing', 'destroyed')),
  status_message TEXT,
  max_permission_mode TEXT NOT NULL DEFAULT 'full',
  launch_key TEXT,
  token_hash TEXT,
  join_token_hash TEXT,
  join_expires_at INTEGER,
  connect_machine_id TEXT,
  last_instance_id TEXT,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  last_rejected_protocol_version INTEGER,
  platform TEXT,
  thread_storage_root TEXT,
  destroyed_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX hosts_token_idx ON hosts (token_hash)
  WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX hosts_join_token_idx ON hosts (join_token_hash)
  WHERE join_token_hash IS NOT NULL;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'standard',
  name TEXT NOT NULL,
  git_remote_url TEXT,
  sort_key TEXT NOT NULL DEFAULT 'V',
  execution_defaults TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX projects_personal_idx ON projects (kind)
  WHERE kind = 'personal';

CREATE TABLE project_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  owns_path INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (project_id, host_id)
) STRICT;

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  name TEXT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  path TEXT,
  is_git_repo INTEGER NOT NULL DEFAULT 0,
  is_worktree INTEGER NOT NULL DEFAULT 0,
  branch_name TEXT,
  base_branch TEXT,
  default_branch TEXT,
  merge_base_branch TEXT,
  environment_provider_id TEXT,
  environment_provider_selection TEXT,
  environment_provider_instance_key TEXT,
  provider_owns_path INTEGER NOT NULL DEFAULT 0,
  resource TEXT,
  owner_thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'provisioning' CHECK (
    status IN ('creating', 'provisioning', 'ready', 'error', 'destroyed')
  ),
  status_message TEXT,
  retire_at INTEGER,
  teardown_status TEXT,
  teardown_attempt INTEGER NOT NULL DEFAULT 0,
  teardown_message TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (project_id, host_id, path)
) STRICT;
CREATE UNIQUE INDEX environments_owner_thread_idx
  ON environments (owner_thread_id) WHERE owner_thread_id IS NOT NULL;

CREATE TABLE thread_sections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES environments (id) ON DELETE SET NULL,
  provider_id TEXT NOT NULL,
  provider_thread_id TEXT,
  active_turn_id TEXT,
  model TEXT,
  reasoning_level TEXT,
  permission_mode TEXT,
  service_tier TEXT,
  model_override TEXT,
  reasoning_level_override TEXT,
  title TEXT,
  title_fallback TEXT,
  section_id TEXT REFERENCES thread_sections (id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'starting' CHECK (
    status IN ('pending', 'idle', 'starting', 'active', 'stopping', 'error')
  ),
  startup_context TEXT,
  parent_thread_id TEXT REFERENCES threads (id) ON DELETE SET NULL,
  lifecycle_owner_thread_id TEXT REFERENCES threads (id) ON DELETE CASCADE,
  source_thread_id TEXT REFERENCES threads (id) ON DELETE SET NULL,
  origin_kind TEXT CHECK (origin_kind IN ('fork')),
  origin_plugin_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'visible',
  archived_at INTEGER,
  pinned_at INTEGER,
  pin_sort_key TEXT,
  deleted_at INTEGER,
  storage_deleted_at INTEGER,
  last_read_at INTEGER,
  latest_attention_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX threads_project_idx
  ON threads (project_id, archived_at, deleted_at, id);
CREATE INDEX threads_environment_idx ON threads (environment_id);
CREATE INDEX threads_section_idx ON threads (section_id);
CREATE INDEX threads_parent_idx ON threads (parent_thread_id);
CREATE INDEX threads_lifecycle_owner_idx ON threads (lifecycle_owner_thread_id);
CREATE INDEX threads_source_idx ON threads (source_thread_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  environment_id TEXT,
  scope_kind TEXT NOT NULL,
  turn_id TEXT,
  provider_thread_id TEXT,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  item_id TEXT,
  item_kind TEXT,
  parent_tool_call_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (thread_id, sequence),
  CHECK (
    (scope_kind = 'turn' AND turn_id IS NOT NULL)
    OR (scope_kind = 'thread' AND turn_id IS NULL)
  )
) STRICT;
CREATE INDEX events_type_idx ON events (thread_id, type, sequence);
CREATE INDEX events_turn_type_item_idx
  ON events (thread_id, turn_id, type, item_id, sequence);
CREATE INDEX events_item_lifecycle_idx ON events (thread_id, item_id, sequence)
  WHERE type IN (
    'item/started', 'item/completed', 'item/backgroundTask/completed'
  );
CREATE INDEX events_provider_identity_idx
  ON events (provider_thread_id, created_at) WHERE type = 'thread/identity';
CREATE INDEX events_parent_tool_call_idx
  ON events (thread_id, parent_tool_call_id, sequence)
  WHERE parent_tool_call_id IS NOT NULL;
CREATE INDEX events_background_task_idx
  ON events (thread_id, item_id, type, sequence)
  WHERE item_kind = 'backgroundTask';

CREATE TABLE queued_thread_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  sender_thread_id TEXT,
  origin TEXT CHECK (origin IN ('app', 'cli', 'sdk', 'plugin')),
  origin_plugin_id TEXT,
  requested_by_initiator TEXT,
  requested_by_thread_id TEXT,
  system_notice TEXT,
  model TEXT NOT NULL,
  reasoning_level TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  service_tier TEXT NOT NULL,
  group_with_next INTEGER NOT NULL DEFAULT 0,
  send_at INTEGER,
  waiting_on TEXT,
  failure_reason TEXT,
  claimed_at INTEGER,
  claim_token TEXT,
  sort_key TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE pending_interactions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  origin_kind TEXT NOT NULL DEFAULT 'provider',
  turn_id TEXT,
  provider_id TEXT,
  provider_thread_id TEXT,
  provider_request_id TEXT,
  plugin_id TEXT,
  renderer_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'resolving', 'resolved', 'interrupted')),
  status_reason TEXT,
  payload TEXT NOT NULL,
  resolution TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  resolved_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (provider_id, provider_thread_id, provider_request_id)
) STRICT;
CREATE INDEX pending_interactions_thread_idx
  ON pending_interactions (thread_id, status, created_at);

CREATE TABLE thread_tabs (
  thread_id TEXT PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
  tabs_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE prompt_history_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'thread')),
  request_sequence INTEGER NOT NULL,
  input TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (thread_id, request_sequence)
) STRICT;
CREATE INDEX prompt_history_entries_project_idx
  ON prompt_history_entries (project_id, scope, created_at, request_sequence);

CREATE TABLE thread_search_segments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_seq INTEGER,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (thread_id, source_kind, source_key)
) STRICT;
CREATE INDEX thread_search_segments_seq_idx
  ON thread_search_segments (thread_id, source_seq);
CREATE VIRTUAL TABLE thread_search_segments_fts
  USING fts5(text, tokenize = 'unicode61', prefix = '2 3');
CREATE TRIGGER thread_search_segments_after_insert
AFTER INSERT ON thread_search_segments
BEGIN
  INSERT INTO thread_search_segments_fts (rowid, text)
  VALUES (new.rowid, new.text);
END;
CREATE TRIGGER thread_search_segments_after_delete
AFTER DELETE ON thread_search_segments
BEGIN
  DELETE FROM thread_search_segments_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER thread_search_segments_after_text_update
AFTER UPDATE OF id, text ON thread_search_segments
BEGIN
  DELETE FROM thread_search_segments_fts WHERE rowid = old.rowid;
  INSERT INTO thread_search_segments_fts (rowid, text)
  VALUES (new.rowid, new.text);
END;

CREATE TABLE project_attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  stored_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, stored_path)
) STRICT;

CREATE TABLE terminal_sessions (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES threads (id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES environments (id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  runner_instance_id TEXT,
  title TEXT NOT NULL,
  initial_cwd TEXT NOT NULL,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  close_reason TEXT,
  last_user_input_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX terminal_sessions_thread_idx
  ON terminal_sessions (thread_id, status);
CREATE INDEX terminal_sessions_environment_idx
  ON terminal_sessions (environment_id, status);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE ui_preferences (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE environment_variables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  encryption_version INTEGER NOT NULL,
  note TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX environment_variables_global_idx
  ON environment_variables (name) WHERE project_id IS NULL;
CREATE UNIQUE INDEX environment_variables_project_idx
  ON environment_variables (project_id, name) WHERE project_id IS NOT NULL;

CREATE TABLE plugins (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE plugin_kv (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, key)
) STRICT;

CREATE TABLE plugin_settings (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, key)
) STRICT;
