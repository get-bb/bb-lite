import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { GENERATED_ID_ALPHABET, GENERATED_ID_SUFFIX_LENGTH } from "@bb/domain";
import Database from "better-sqlite3";
import type { ZodType } from "zod";

export type SqlValue = string | number | bigint | Buffer | null;
export type SqlParams = SqlValue[] | [Record<string, SqlValue>];

export interface Db {
  now(): number;
  get<Row>(sql: string, ...params: SqlParams): Row | undefined;
  all<Row>(sql: string, ...params: SqlParams): Row[];
  run(sql: string, ...params: SqlParams): { changes: number };
  transaction<T>(work: () => T): T;
  close(): void;
}

export interface OpenDatabaseOptions {
  path: string;
  now?: () => number;
}

type EntityIdPrefix = "host" | "proj" | "src" | "env" | "thr" | "sec" | "term";
type RecordIdPrefix = "evt" | "phist" | "qmsg" | "qclaim" | "pint" | "creq";
export type IdPrefix = EntityIdPrefix | RecordIdPrefix | "att";

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

function migrationSteps(): string[] {
  return [readFileSync(new URL("./schema.sql", import.meta.url), "utf8")];
}

export function refuseLegacyDatabase(path: string): void {
  if (!existsSync(path)) return;
  const sqlite = new Database(path, { readonly: true });
  const legacy = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("__drizzle_migrations");
  sqlite.close();
  if (legacy !== undefined) throw new LegacyDataDirectoryError(path);
}

function migrate(sqlite: Database.Database): void {
  const steps = migrationSteps();
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

function camelCase(column: string): string {
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

function toRow<Row>(keys: string[], values: unknown): Row {
  const cells = values as unknown[];
  return Object.fromEntries(
    keys.map((key, index) => [key, cells[index]]),
  ) as Row;
}

export function openDatabase(options: OpenDatabaseOptions): Db {
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

export function newId(prefix: IdPrefix): string {
  let suffix = "";
  for (const byte of randomBytes(GENERATED_ID_SUFFIX_LENGTH)) {
    suffix += GENERATED_ID_ALPHABET[byte % GENERATED_ID_ALPHABET.length];
  }
  return `${prefix}_${suffix}`;
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function decodeJson<T>(schema: ZodType<T>, text: string): T {
  return schema.parse(JSON.parse(text));
}
