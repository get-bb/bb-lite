import { createHash } from "node:crypto";
import type { PluginTables, PluginVerbs } from "@bb/plugin";
import type { Db } from "@bb/server-kit/db/index";

const MIGRATIONS = `CREATE TABLE IF NOT EXISTS plugin_table_migrations (
  plugin_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  statement_hash TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, id)
) STRICT`;
const NAME = '["`]?([A-Za-z_][A-Za-z0-9_]*)';
const DEFINES = new RegExp(
  "^\\s*(?:CREATE\\s+(?:UNIQUE\\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)" +
    "(?:\\s+IF\\s+NOT\\s+EXISTS)?|ALTER\\s+TABLE|" +
    `DROP\\s+(?:TABLE|INDEX|VIEW|TRIGGER)(?:\\s+IF\\s+EXISTS)?)\\s+${NAME}`,
  "iu",
);
const WRITES = new RegExp(
  "^\\s*(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|" +
    `UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM)\\s+${NAME}`,
  "iu",
);
const READS = /^\s*(?:SELECT|WITH)\b/iu;
const CHANGES = /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu;
const LOCAL = /^[a-z][a-z0-9_]*$/u;

export function tablePrefix(pluginId: string): string {
  return `p_${pluginId.replaceAll("-", "_")}_`;
}

export function createPluginTables(
  db: Db,
  pluginId: string,
  verbs: Pick<PluginVerbs, "add" | "use">,
): PluginTables {
  const prefix = tablePrefix(pluginId);
  const own = (pattern: RegExp, sql: string): boolean =>
    pattern.exec(sql)?.[1]?.toLowerCase().startsWith(prefix) === true;
  const refuse = (what: string): never => {
    throw new Error(`${what}. A plugin's shared tables start with ${prefix}`);
  };
  const name = (local: string): string => {
    if (!LOCAL.test(local)) refuse(`"${local}" is not a table name`);
    return prefix + local;
  };
  const reading = (sql: string): string => {
    const changes = sql.trimStart().toUpperCase().startsWith("WITH");
    if (!READS.test(sql) || (changes && CHANGES.test(sql))) {
      refuse("all() and get() take a SELECT");
    }
    return sql;
  };
  return {
    name,
    migrate(statements) {
      db.transaction(() => {
        db.run(MIGRATIONS);
        const applied = db.all<{ hash: string }>(
          "SELECT statement_hash AS hash FROM plugin_table_migrations " +
            "WHERE plugin_id = ? ORDER BY id",
          pluginId,
        );
        statements.forEach((statement, index) => {
          const hash = createHash("sha256").update(statement).digest("hex");
          const recorded = applied[index];
          if (recorded !== undefined) {
            if (recorded.hash === hash) return;
            const message = `Table migration ${index} changed after it was applied`;
            throw new Error(`${message}; append a new one`);
          }
          if (!own(DEFINES, statement) && !own(WRITES, statement)) {
            refuse(
              `Table migration ${index} touches a table that is not its own`,
            );
          }
          db.run(statement);
          db.run(
            "INSERT INTO plugin_table_migrations VALUES (?, ?, ?, ?)",
            pluginId,
            index,
            hash,
            db.now(),
          );
        });
      });
    },
    publish(table, local) {
      verbs.add(table, { name: name(local) });
    },
    of: (table) => verbs.use(table).name,
    all: (sql, ...params) => db.all(reading(sql), ...params),
    get: (sql, ...params) => db.get(reading(sql), ...params),
    run(sql, ...params) {
      if (!own(WRITES, sql))
        refuse("run() writes only to the plugin's own tables");
      return db.run(sql, ...params);
    },
  };
}
