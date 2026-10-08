INSERT OR IGNORE INTO plugin_settings (plugin_id, key, value, updated_at)
SELECT
  'provider-' || substr(settings.key, length('providerSettings:') + 1),
  toggle.key,
  CASE toggle.type WHEN 'true' THEN 'true' ELSE 'false' END,
  settings.updated_at
FROM settings, json_each(settings.value) AS toggle
WHERE settings.key LIKE 'providerSettings:%'
  AND toggle.type IN ('true', 'false');

DELETE FROM settings WHERE key LIKE 'providerSettings:%';
