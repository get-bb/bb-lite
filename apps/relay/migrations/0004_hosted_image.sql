ALTER TABLE servers ADD COLUMN hosted_image TEXT;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
