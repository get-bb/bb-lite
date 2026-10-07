class SqliteError extends Error {
  constructor(message) {
    super(message);
    this.name = "SqliteError";
    const m = /^(\w+)/.exec(message);
    this.code = /constraint/i.test(message) ? "SQLITE_CONSTRAINT" : m && /^SQLITE_/.test(m[1]) ? m[1] : "SQLITE_ERROR";
  }
}

const encodeValue = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "bigint") return { $bigint: String(v) };
  if (v instanceof Uint8Array || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return { $blob: __bb.bytesToBase64(bytes) };
  }
  if (v instanceof Date) return v.getTime();
  throw new TypeError(`SQLite3 can only bind numbers, strings, bigints, buffers, and null`);
};
const decodeValue = (v) => {
  if (v === null || typeof v !== "object") return v;
  if ("$bigint" in v) return BigInt(v.$bigint);
  if ("$blob" in v) {
    const bytes = __bb.base64ToBytes(v.$blob);
    return globalThis.Buffer ? globalThis.Buffer.fromBytes(bytes) : bytes;
  }
  return v;
};
const isNamed = (v) =>
  v !== null && typeof v === "object" && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer) && !Array.isArray(v) && !(v instanceof Date);
const encodeParams = (args) => {
  const named = {};
  const positional = [];
  let hasNamed = false;
  for (const a of args.flat()) {
    if (isNamed(a)) {
      hasNamed = true;
      for (const [k, v] of Object.entries(a)) named[k] = encodeValue(v);
    } else positional.push(encodeValue(a));
  }
  return { positional, named: hasNamed ? named : null };
};

class Statement {
  #db;
  #pluck = false;
  #raw = false;
  constructor(db, sql, reader) {
    this.#db = db;
    this.source = sql;
    this.reader = reader;
  }
  pluck(on = true) {
    this.#pluck = !!on;
    if (on) this.#raw = false;
    return this;
  }
  raw(on = true) {
    this.#raw = !!on;
    if (on) this.#pluck = false;
    return this;
  }
  #query(mode, args) {
    return this.#db.op({ kind: "query", sql: this.source, mode, params: encodeParams(args) });
  }
  #shape(columns, row) {
    const values = row.map(decodeValue);
    if (this.#pluck) return values[0];
    if (this.#raw) return values;
    const out = {};
    columns.forEach((c, i) => (out[c] = values[i]));
    return out;
  }
  all(...args) {
    const { columns, rows } = this.#query("all", args);
    return rows.map((r) => this.#shape(columns, r));
  }
  get(...args) {
    const { columns, rows } = this.#query("get", args);
    return rows.length ? this.#shape(columns, rows[0]) : undefined;
  }
  *iterate(...args) {
    yield* this.all(...args);
  }
  run(...args) {
    return this.#query("run", args);
  }
}

class Database {
  #op;
  #depth = 0;
  constructor(name) {
    this.name = name;
    this.#op = `db:${name}`;
    this.open = true;
    try {
      this.op({ kind: "state" });
    } catch (e) {
      throw new TypeError(`database "${name}" is not registered`);
    }
  }
  op(arg) {
    if (!this.open) throw new TypeError("The database connection is not open");
    try {
      return __bb.op(this.#op, arg);
    } catch (e) {
      throw new SqliteError(e.message);
    }
  }
  get inTransaction() {
    return this.op({ kind: "state" }).inTransaction;
  }
  prepare(sql) {
    const { reader } = this.op({ kind: "prepare", sql: String(sql) });
    return new Statement(this, String(sql), reader);
  }
  exec(sql) {
    this.op({ kind: "exec", sql: String(sql) });
    return this;
  }
  pragma(text, options = {}) {
    const stmt = this.prepare(`PRAGMA ${text}`);
    return options.simple ? stmt.pluck().get() : stmt.all();
  }
  close() {
    this.open = false;
    return this;
  }
  transaction(fn) {
    if (typeof fn !== "function") throw new TypeError("Expected first argument to be a function");
    const db = this;
    const make = (begin) =>
      function (...args) {
        const depth = db.#depth;
        const nested = depth > 0;
        const sp = `bb_sp_${depth}`;
        db.exec(nested ? `SAVEPOINT ${sp}` : begin);
        db.#depth = depth + 1;
        try {
          const result = fn.apply(this, args);
          if (result && typeof result.then === "function") {
            throw new TypeError("Transaction function cannot return a promise");
          }
          db.#depth = depth;
          db.exec(nested ? `RELEASE ${sp}` : "COMMIT");
          return result;
        } catch (e) {
          db.#depth = depth;
          if (nested) db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
          else if (db.inTransaction) db.exec("ROLLBACK");
          throw e;
        }
      };
    const tx = make("BEGIN");
    tx.deferred = tx;
    tx.immediate = make("BEGIN IMMEDIATE");
    tx.exclusive = make("BEGIN EXCLUSIVE");
    return tx;
  }
}

export const openDatabase = (name) => new Database(String(name));
