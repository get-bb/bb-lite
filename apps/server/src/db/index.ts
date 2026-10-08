import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { GENERATED_ID_ALPHABET, GENERATED_ID_SUFFIX_LENGTH } from "@bb/domain";
import Database from "better-sqlite3";
import type { ZodType } from "zod";

export type SqlValue = string | number | bigint | Buffer | null;
export type RowValues = Record<string, SqlValue | undefined>;
export type SqlParams = SqlValue[] | [RowValues];

export interface Db {
  now(): number;
  get<Row>(sql: string, ...params: SqlParams): Row | undefined;
  all<Row>(sql: string, ...params: SqlParams): Row[];
  run(sql: string, ...params: SqlParams): { changes: number };
  transaction<T>(work: () => T): T;
  close(): void;
}

export interface RevisionWrite {
  outcome: "updated" | "conflict";
  revision: number;
}

type EntityIdPrefix =
  | "host"
  | "proj"
  | "src"
  | "env"
  | "thr"
  | "sec"
  | "term"
  | "usr";
type RecordIdPrefix =
  | "evt"
  | "phist"
  | "qmsg"
  | "pint"
  | "creq"
  | "tpv"
  | "att"
  | "uses"
  | "uinv";

export class LegacyDataDirectoryError extends Error {
  constructor(path: string) {
    super(
      `${path} belongs to an original bb install (it has a ` +
        "__drizzle_migrations table). This build never opens that data in " +
        "place: point BB_DATA_DIR at another directory and copy what you " +
        "need across with `bb import-legacy`.",
    );
    this.name = "LegacyDataDirectoryError";
  }
}

const BUSY_TIMEOUT_MS = 5_000;
const SCHEMA_STEPS = [
  "./schema.sql",
  "./schema-users.sql",
  "./schema-audit.sql",
  "./schema-provider-settings.sql",
];

export function refuseLegacyDatabase(path: string): void {
  if (!existsSync(path)) return;
  const sqlite = new Database(path, { readonly: true });
  const legacy = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("__drizzle_migrations");
  sqlite.close();
  if (legacy !== undefined) throw new LegacyDataDirectoryError(path);
}

function migrate(sqlite: Database.Database) {
  const steps = SCHEMA_STEPS.map((file) =>
    readFileSync(new URL(file, import.meta.url), "utf8"),
  );
  const current = Number(sqlite.pragma("user_version", { simple: true }));
  steps.slice(current).forEach((step, offset) => {
    sqlite
      .transaction(() => {
        sqlite.exec(step);
        sqlite.pragma(`user_version = ${current + offset + 1}`);
      })
      .immediate();
  });
}

function camelCase(column: string) {
  return column.replace(/_([a-z0-9])/gu, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

interface PreparedStatement {
  statement: Database.Statement;
  keys: string[];
}

function prepareStatement(
  sqlite: Database.Database,
  sql: string,
): PreparedStatement {
  const statement = sqlite.prepare(sql);
  if (!statement.reader) return { statement, keys: [] };
  statement.raw(true);
  return {
    statement,
    keys: statement.columns().map((column) => camelCase(column.name)),
  };
}

function toRow<Row>(keys: string[], values: unknown) {
  const cells = values as unknown[];
  const row: Record<string, unknown> = {};
  keys.forEach((key, index) => (row[key] = cells[index]));
  return row as Row;
}

export function openDatabase(options: {
  path: string;
  now?: () => number;
}): Db {
  refuseLegacyDatabase(options.path);
  const sqlite = new Database(options.path);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    migrate(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }
  const cache = new Map<string, PreparedStatement>();
  const prepared = (sql: string): PreparedStatement => {
    const cached = cache.get(sql) ?? prepareStatement(sqlite, sql);
    cache.set(sql, cached);
    return cached;
  };
  return {
    now: options.now ?? Date.now,
    get<Row>(sql: string, ...params: SqlParams) {
      const { statement, keys } = prepared(sql);
      const values = statement.get(...params);
      return values === undefined ? undefined : toRow<Row>(keys, values);
    },
    all<Row>(sql: string, ...params: SqlParams) {
      const { statement, keys } = prepared(sql);
      return statement.all(...params).map((values) => toRow<Row>(keys, values));
    },
    run(sql, ...params) {
      return { changes: prepared(sql).statement.run(...params).changes };
    },
    transaction<T>(work: () => T): T {
      return sqlite
        .transaction(() => {
          const result = work();
          if (result instanceof Promise) {
            throw new Error("Database transactions must be synchronous");
          }
          return result;
        })
        .immediate();
    },
    close() {
      sqlite.close();
    },
  };
}

export function newId(prefix: EntityIdPrefix | RecordIdPrefix): string {
  let suffix = "";
  for (const byte of randomBytes(GENERATED_ID_SUFFIX_LENGTH)) {
    suffix += GENERATED_ID_ALPHABET[byte % GENERATED_ID_ALPHABET.length];
  }
  return `${prefix}_${suffix}`;
}

function snakeCase(key: string) {
  return key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

function definedKeys(values: RowValues) {
  return Object.keys(values).filter((key) => values[key] !== undefined);
}

export function insertRow(
  db: Db,
  table: string,
  values: RowValues,
  onConflict: "fail" | "ignore" | readonly string[] = "fail",
): void {
  const keys = definedKeys(values);
  const columns = keys.map(snakeCase);
  const marks = keys.map((key) => `@${key}`).join(", ");
  let resolution = onConflict === "ignore" ? "ON CONFLICT DO NOTHING" : "";
  if (typeof onConflict !== "string") {
    const identity = [...onConflict, "created_at"];
    const sets = columns
      .filter((column) => !identity.includes(column))
      .map((column) => `${column} = excluded.${column}`);
    const target = onConflict.join(", ");
    resolution = `ON CONFLICT (${target}) DO UPDATE SET ${sets.join(", ")}`;
  }
  const into = `${table} (${columns.join(", ")})`;
  db.run(`INSERT INTO ${into} VALUES (${marks}) ${resolution}`, values);
}

export function updateRow(
  db: Db,
  table: string,
  id: string,
  patch: RowValues,
  touch = true,
): boolean {
  const sets = [...definedKeys(patch), ...(touch ? ["updatedAt"] : [])]
    .map((key) => `${snakeCase(key)} = @${key}`)
    .join(", ");
  const values = { ...patch, updatedAt: db.now(), id };
  return (
    db.run(`UPDATE ${table} SET ${sets} WHERE id = @id`, values).changes > 0
  );
}

export function writeRevision(
  db: Db,
  table: string,
  key: Record<string, string>,
  values: RowValues,
  expectedRevision: number | null,
): RevisionWrite {
  return db.transaction((): RevisionWrite => {
    const columns = Object.keys(key).map(snakeCase);
    const where = columns.map((column) => `${column} = ?`).join(" AND ");
    const sql = `SELECT revision FROM ${table} WHERE ${where}`;
    const stored = db.get<{ revision: number }>(sql, ...Object.values(key));
    const current = stored?.revision ?? 0;
    if (expectedRevision !== null && expectedRevision !== current) {
      return { outcome: "conflict", revision: current };
    }
    const revision = current + 1;
    const next = { ...key, ...values, revision, updatedAt: db.now() };
    insertRow(db, table, next, columns);
    return { outcome: "updated", revision };
  });
}

export function decodeJson<T>(schema: ZodType<T>, text: string): T {
  return schema.parse(JSON.parse(text));
}
