ALTER TABLE servers ADD COLUMN hosted_state TEXT;
ALTER TABLE servers ADD COLUMN hosted_app TEXT;
ALTER TABLE servers ADD COLUMN hosted_machine TEXT;
ALTER TABLE servers ADD COLUMN hosted_error TEXT;
ALTER TABLE servers ADD COLUMN active_at INTEGER;
ALTER TABLE servers ADD COLUMN stopped_at INTEGER;
ALTER TABLE servers ADD COLUMN wake_at INTEGER;

CREATE INDEX servers_hosted_idx ON servers (hosted_state)
  WHERE hosted_state IS NOT NULL;
