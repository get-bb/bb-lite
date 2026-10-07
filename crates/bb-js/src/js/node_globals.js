import { openDatabase } from "bb:node-database";

const config = __bb.op("node.config", null);
const hidden = (name, value) =>
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });

const withCode = (e) => {
  const m = /^(E[A-Z]+): .*?, (\w+) '(.*)'$/s.exec(e?.message ?? "");
  if (m) Object.assign(e, { code: m[1], syscall: m[2], path: m[3] });
  return e;
};
const fsSync = (arg) => {
  try {
    return __bb.op("node.fs", arg);
  } catch (e) {
    throw withCode(e);
  }
};
const fsAsync = (arg) => __bb.opAsync("node.fs", arg).catch((e) => Promise.reject(withCode(e)));

const normalizeString = (p, allowAbove) => {
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (allowAbove) out.push("..");
    } else out.push(seg);
  }
  return out.join("/");
};
const str = (p, name = "path") => {
  if (typeof p !== "string") {
    const e = new TypeError(`The "${name}" argument must be of type string. Received ${typeof p}`);
    e.code = "ERR_INVALID_ARG_TYPE";
    throw e;
  }
  return p;
};
const path = {
  sep: "/",
  delimiter: ":",
  isAbsolute: (p) => str(p).startsWith("/"),
  normalize(p) {
    str(p);
    if (p === "") return ".";
    const abs = p.startsWith("/");
    let r = normalizeString(p, !abs);
    if (r === "" && !abs) r = ".";
    if (r && p.endsWith("/")) r += "/";
    return abs ? "/" + r : r;
  },
  join(...parts) {
    const joined = parts.map((p) => str(p)).filter((p) => p !== "").join("/");
    return joined === "" ? "." : path.normalize(joined);
  },
  resolve(...parts) {
    let resolved = "";
    for (let i = parts.length - 1; i >= -1 && !resolved.startsWith("/"); i--) {
      const p = i >= 0 ? str(parts[i]) : process.cwd();
      if (p !== "") resolved = resolved ? `${p}/${resolved}` : p;
    }
    const r = normalizeString(resolved, false);
    return "/" + r;
  },
  relative(from, to) {
    from = path.resolve(from);
    to = path.resolve(to);
    if (from === to) return "";
    const a = from.split("/").filter(Boolean);
    const b = to.split("/").filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
  },
  dirname(p) {
    str(p);
    if (p === "") return ".";
    const trimmed = p.replace(/\/+$/, "");
    if (trimmed === "") return "/";
    const i = trimmed.lastIndexOf("/");
    if (i === -1) return ".";
    const d = trimmed.slice(0, i).replace(/\/+$/, "");
    return d === "" ? "/" : d;
  },
  basename(p, ext) {
    str(p);
    const trimmed = p.replace(/\/+$/, "");
    let b = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    if (ext !== undefined && b !== ext && b.endsWith(ext)) b = b.slice(0, -ext.length);
    return b;
  },
  extname(p) {
    const b = path.basename(p);
    const i = b.lastIndexOf(".");
    return i <= 0 ? "" : b.slice(i);
  },
  parse(p) {
    const root = str(p).startsWith("/") ? "/" : "";
    const base = path.basename(p);
    const ext = path.extname(p);
    let dir = path.dirname(p);
    if (dir === "." && !p.startsWith(".")) dir = "";
    return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
  },
  format: (o) => {
    const dir = o.dir || o.root || "";
    const base = o.base || `${o.name || ""}${o.ext || ""}`;
    return dir ? (dir === o.root ? dir + base : `${dir}/${base}`) : base;
  },
  toNamespacedPath: (p) => p,
};
path.posix = path;

const enc = new TextEncoder();
const dec = new TextDecoder();
const normEnc = (e) => {
  const v = String(e ?? "utf8").toLowerCase();
  if (v === "utf-8") return "utf8";
  if (v === "binary") return "latin1";
  if (v === "ucs2" || v === "ucs-2" || v === "utf-16le") return "utf16le";
  return v;
};
const encode = (s, e) => {
  switch (normEnc(e)) {
    case "utf8":
      return enc.encode(s);
    case "base64":
    case "base64url": {
      const fast = __bb.base64Native(s);
      if (fast != null) return fast;
      let b = s.replace(/[\s=]/g, "").replace(/-/g, "+").replace(/_/g, "/");
      while (b.length % 4) b += "=";
      return __bb.base64ToBytes(b);
    }
    case "hex": {
      const n = s.length >> 1;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
      return out;
    }
    case "latin1":
    case "ascii":
      return Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
    case "utf16le": {
      const out = new Uint8Array(s.length * 2);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out[i * 2] = c & 255;
        out[i * 2 + 1] = c >> 8;
      }
      return out;
    }
    default:
      throw new TypeError(`Unknown encoding: ${e}`);
  }
};
const decode = (bytes, e) => {
  switch (normEnc(e)) {
    case "utf8":
      return dec.decode(bytes);
    case "base64":
      return __bb.bytesToBase64(bytes);
    case "base64url":
      return __bb.bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    case "hex":
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    case "latin1":
    case "ascii": {
      let s = "";
      for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return s;
    }
    case "utf16le": {
      let s = "";
      for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
      return s;
    }
    default:
      throw new TypeError(`Unknown encoding: ${e}`);
  }
};
const copy = (b) => Uint8Array.prototype.slice.call(b);
const toBytes = (v) =>
  v instanceof Uint8Array
    ? v
    : ArrayBuffer.isView(v)
      ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
      : v instanceof ArrayBuffer
        ? new Uint8Array(v)
        : null;

class Buffer extends Uint8Array {
  static from(value, encOrOffset, length) {
    if (typeof value === "string") return Buffer.fromBytes(encode(value, encOrOffset));
    if (value instanceof ArrayBuffer) return new Buffer(value, encOrOffset ?? 0, length ?? value.byteLength - (encOrOffset ?? 0));
    const bytes = toBytes(value);
    if (bytes) return Buffer.fromBytes(new Uint8Array(bytes));
    if (Array.isArray(value)) return Buffer.fromBytes(Uint8Array.from(value));
    if (value && value.type === "Buffer" && Array.isArray(value.data)) return Buffer.fromBytes(Uint8Array.from(value.data));
    throw new TypeError("The first argument must be of type string, Buffer, ArrayBuffer or Array");
  }
  static fromBytes(bytes) {
    return new Buffer(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  static alloc(size, fill) {
    const b = new Buffer(size);
    if (fill !== undefined) b.fill(typeof fill === "string" ? fill.charCodeAt(0) : fill);
    return b;
  }
  static allocUnsafe(size) {
    return new Buffer(size);
  }
  static isBuffer(v) {
    return v instanceof Buffer;
  }
  static isEncoding(e) {
    return ["utf8", "base64", "base64url", "hex", "latin1", "ascii", "utf16le"].includes(normEnc(e));
  }
  static byteLength(v, e) {
    return typeof v === "string" ? encode(v, e).length : v.byteLength;
  }
  static concat(list, total) {
    total ??= list.reduce((n, b) => n + b.length, 0);
    const out = Buffer.alloc(total);
    let off = 0;
    for (const b of list) {
      if (off >= total) break;
      out.set(b.subarray(0, total - off), off);
      off += b.length;
    }
    return out;
  }
  static compare(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return Math.sign(a.length - b.length);
  }
  toString(e, start = 0, end = this.length) {
    return decode(this.subarray(start, end), e);
  }
  equals(other) {
    return Buffer.compare(this, other) === 0;
  }
  compare(other) {
    return Buffer.compare(this, other);
  }
  slice(start, end) {
    return this.subarray(start, end);
  }
  write(s, offset = 0, e = "utf8") {
    const bytes = encode(s, e).subarray(0, this.length - offset);
    this.set(bytes, offset);
    return bytes.length;
  }
  toJSON() {
    return { type: "Buffer", data: Array.from(this) };
  }
}

const now = () => globalThis.performance?.now() ?? Date.now();
const env = Object.assign(Object.create(null), config.env);
const process = {
  cwd: () => config.cwd,
  env,
  platform: config.platform,
  arch: config.arch,
  argv: [],
  version: "v22.0.0",
  versions: {},
  pid: 1,
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  exit() {
    throw new Error("process.exit is not available to plugins");
  },
  on: () => process,
  off: () => process,
  emitWarning: (w) => console.warn(String(w)),
  hrtime: Object.assign((prev) => {
    const ns = BigInt(Math.round(now() * 1e6));
    const s = [Number(ns / 1000000000n), Number(ns % 1000000000n)];
    return prev ? [s[0] - prev[0], s[1] - prev[1]] : s;
  }, { bigint: () => BigInt(Math.round(now() * 1e6)) }),
};

const pathArg = (p) => (p instanceof URL ? decodeURIComponent(p.pathname) : String(p));
const encOf = (o) => (typeof o === "string" ? o : o?.encoding);
const dataOf = (data, o) => __bb.bytesToBase64(typeof data === "string" ? encode(data, encOf(o)) : toBytes(data));
const readResult = (b64, o) => {
  const e = encOf(o);
  if (e && normEnc(e) === "base64") return b64;
  const bytes = Buffer.fromBytes(__bb.base64ToBytes(b64));
  return e ? bytes.toString(e) : bytes;
};
class Stats {
  constructor(s) {
    Object.assign(this, { size: s.size, mode: s.mode, mtimeMs: s.mtimeMs, mtime: new Date(s.mtimeMs) });
    this._s = s;
  }
  isFile() { return this._s.isFile; }
  isDirectory() { return this._s.isDirectory; }
  isSymbolicLink() { return this._s.isSymbolicLink; }
}
const dirents = (list, o) =>
  o?.withFileTypes ? list.map((d) => Object.assign(new Stats(d), { name: d.name })) : list.map((d) => d.name);
const makeFs = (call, wrap) => ({
  readFile: (p, o) => wrap(call({ op: "readFile", path: pathArg(p) }), (r) => readResult(r, o)),
  writeFile: (p, data, o) =>
    wrap(call({ op: "writeFile", path: pathArg(p), data: dataOf(data, o), mode: o?.mode, append: o?.flag === "a" })),
  appendFile: (p, data, o) => wrap(call({ op: "writeFile", path: pathArg(p), data: dataOf(data, o), mode: o?.mode, append: true })),
  mkdir: (p, o) => wrap(call({ op: "mkdir", path: pathArg(p), recursive: !!o?.recursive }), (r) => r ?? undefined),
  rm: (p, o) => wrap(call({ op: "rm", path: pathArg(p), recursive: !!o?.recursive, force: !!o?.force })),
  rmdir: (p, o) =>
    wrap(call(o?.recursive ? { op: "rm", path: pathArg(p), recursive: true } : { op: "rmdir", path: pathArg(p) })),
  unlink: (p) => wrap(call({ op: "unlink", path: pathArg(p) })),
  stat: (p) => wrap(call({ op: "stat", path: pathArg(p) }), (s) => new Stats(s)),
  lstat: (p) => wrap(call({ op: "lstat", path: pathArg(p) }), (s) => new Stats(s)),
  readdir: (p, o) => wrap(call({ op: "readdir", path: pathArg(p) }), (l) => dirents(l, o)),
  rename: (a, b) => wrap(call({ op: "rename", path: pathArg(a), to: pathArg(b) })),
  copyFile: (a, b) => wrap(call({ op: "copyFile", path: pathArg(a), to: pathArg(b) })),
  access: (p) => wrap(call({ op: "access", path: pathArg(p) })),
});
const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };
const fsp = { ...makeFs(fsAsync, (p, f = () => undefined) => p.then(f)), constants };
const syncFs = makeFs(fsSync, (v, f = () => undefined) => f(v));
const fs = { promises: fsp, constants, existsSync: (p) => fsSync({ op: "exists", path: pathArg(p) }) };
for (const [k, v] of Object.entries(syncFs)) fs[`${k}Sync`] = v;

class Hash {
  constructor(algorithm) {
    this.algorithm = algorithm;
    this.parts = [];
  }
  update(data, e) {
    this.parts.push(typeof data === "string" ? encode(data, e) : toBytes(data));
    return this;
  }
  digest(e) {
    const data = __bb.bytesToBase64(Buffer.concat(this.parts));
    const out = __bb.op("node.hash", { algorithm: this.algorithm, data });
    const bytes = Buffer.from(out, "base64");
    return e ? bytes.toString(e) : bytes;
  }
}
const crypto = {
  randomBytes: (n) => globalThis.crypto.getRandomValues(Buffer.alloc(n)),
  randomUUID: () => globalThis.crypto.randomUUID(),
  getRandomValues: (a) => globalThis.crypto.getRandomValues(a),
  createHash: (algorithm) => new Hash(algorithm),
  webcrypto: globalThis.crypto,
};

const os = {
  homedir: () => config.homedir,
  tmpdir: () => config.tmpdir,
  hostname: () => config.hostname,
  platform: () => config.platform,
  type: () => ({ darwin: "Darwin", win32: "Windows_NT" })[config.platform] ?? "Linux",
  arch: () => config.arch,
  EOL: "\n",
};
const abortError = (signal) =>
  signal.reason ?? Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
const timersPromises = {
  setTimeout: (ms, value, o) =>
    new Promise((resolve, reject) => {
      const signal = o?.signal;
      if (signal?.aborted) return reject(abortError(signal));
      const onAbort = () => {
        clearTimeout(id);
        reject(abortError(signal));
      };
      const id = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
  setImmediate: (value, o) => timersPromises.setTimeout(0, value, o),
};
const timers = {
  setTimeout, clearTimeout, setInterval, clearInterval,
  setImmediate: (fn, ...args) => setTimeout(fn, 0, ...args),
};
const inspect = (v) => {
  if (typeof v === "string") return `'${v}'`;
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "function") return `[Function: ${v.name || "(anonymous)"}]`;
  if (v instanceof Error) return v.stack || String(v);
  try {
    return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x)) ?? String(v);
  } catch {
    return String(v);
  }
};
const util = {
  promisify: (fn) => (...args) =>
    new Promise((resolve, reject) => fn(...args, (err, value) => (err ? reject(err) : resolve(value)))),
  inspect,
  format: (f, ...args) =>
    [String(f).replace(/%[sdifjo%]/g, (m) => (m === "%%" ? "%" : args.length ? (m === "%s" ? String(args.shift()) : m === "%d" || m === "%i" ? String(parseInt(args.shift())) : m === "%f" ? String(Number(args.shift())) : inspect(args.shift())) : m)), ...args.map((a) => (typeof a === "string" ? a : inspect(a)))].join(" "),
  types: {
    isUint8Array: (v) => v instanceof Uint8Array,
    isPromise: (v) => v instanceof Promise,
    isDate: (v) => v instanceof Date,
    isRegExp: (v) => v instanceof RegExp,
  },
  TextEncoder,
  TextDecoder,
};

const normName = (n) => {
  n = String(n).toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(n)) throw new TypeError(`Invalid header name: "${n}"`);
  return n;
};
class Headers {
  #map = new Map();
  constructor(init) {
    if (init == null) return;
    const pairs = init instanceof Headers || Array.isArray(init) || typeof init[Symbol.iterator] === "function" ? [...init] : Object.entries(init);
    for (const [k, v] of pairs) this.append(k, v);
  }
  append(k, v) {
    const n = normName(k);
    const prev = this.#map.get(n);
    this.#map.set(n, prev === undefined ? String(v).trim() : `${prev}, ${String(v).trim()}`);
  }
  set(k, v) { this.#map.set(normName(k), String(v).trim()); }
  get(k) { return this.#map.get(normName(k)) ?? null; }
  has(k) { return this.#map.has(normName(k)); }
  delete(k) { this.#map.delete(normName(k)); }
  forEach(fn, self) { for (const [k, v] of this) fn.call(self, v, k, this); }
  *entries() { yield* [...this.#map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)); }
  *keys() { for (const [k] of this.entries()) yield k; }
  *values() { for (const [, v] of this.entries()) yield v; }
  [Symbol.iterator]() { return this.entries(); }
}
const bodyBytes = (body, headers) => {
  if (body == null) return null;
  if (typeof body === "string") {
    if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
    return enc.encode(body);
  }
  if (body instanceof URLSearchParams) {
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    return enc.encode(String(body));
  }
  const bytes = toBytes(body);
  if (bytes) return copy(bytes);
  throw new TypeError("Unsupported body type: only strings and bytes are available");
};
class Body {
  #bytes;
  #used = false;
  initBody(body) { this.#bytes = bodyBytes(body, this.headers); }
  get bodyUsed() { return this.#used; }
  get body() { return this.#bytes; }
  async bytes() {
    if (this.#used) throw new TypeError("Body has already been consumed.");
    this.#used = true;
    return this.#bytes ? copy(this.#bytes) : new Uint8Array(0);
  }
  async arrayBuffer() { return (await this.bytes()).buffer; }
  async text() { return dec.decode(await this.bytes()); }
  async json() { return JSON.parse(await this.text()); }
  peekBytes() { return this.#bytes; }
}
class Request extends Body {
  constructor(input, init = {}) {
    super();
    const from = input instanceof Request ? input : null;
    this.url = from ? from.url : new URL(String(input)).href;
    this.method = String(init.method ?? from?.method ?? "GET").toUpperCase();
    this.headers = new Headers(init.headers ?? from?.headers);
    this.signal = init.signal ?? from?.signal ?? new AbortController().signal;
    if ((this.method === "GET" || this.method === "HEAD") && init.body != null) {
      throw new TypeError("Request with GET/HEAD method cannot have body.");
    }
    this.initBody(init.body !== undefined ? init.body : from?.peekBytes());
  }
  clone() { return new Request(this); }
}
class Response extends Body {
  constructor(body = null, init = {}) {
    super();
    this.status = init.status ?? 200;
    if (this.status < 200 || this.status > 599) throw new RangeError(`Invalid status code: ${this.status}`);
    this.statusText = init.statusText ?? "";
    this.headers = new Headers(init.headers);
    this.type = "default";
    this.url = "";
    this.redirected = false;
    this.initBody(body);
  }
  get ok() { return this.status >= 200 && this.status < 300; }
  clone() { return new Response(this.peekBytes(), this); }
  static json(value, init = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(JSON.stringify(value), { ...init, headers });
  }
  static redirect(url, status = 302) {
    return new Response(null, { status, headers: { location: new URL(url).href } });
  }
}
const requestFromJson = ({ method, url, headers, bodyBase64 }) =>
  new Request(url, {
    method,
    headers: headers ?? [],
    body: bodyBase64 == null || method === "GET" || method === "HEAD" ? null : __bb.base64ToBytes(bodyBase64),
  });
const responseToJson = async (response) => {
  if (!(response instanceof Response)) throw new TypeError("expected a Response");
  const bytes = await response.bytes();
  return {
    status: response.status,
    headers: [...response.headers],
    bodyBase64: response.peekBytes() == null ? null : __bb.bytesToBase64(bytes),
  };
};

__bb_internal.fetchImpl = null;
const fetch = (...args) =>
  __bb_internal.fetchImpl
    ? __bb_internal.fetchImpl(...args)
    : Promise.reject(new TypeError("fetch is not available to plugins yet"));
for (const [name, value] of Object.entries({ Buffer, process, Headers, Request, Response, fetch })) hidden(name, value);
const buffer = { Buffer };
hidden("__bb_node", { path, fsp, fs, crypto, os, timersPromises, timers, buffer, process, util });
Object.defineProperty(globalThis, "__bb_node", { enumerable: false });
hidden("__bb", Object.freeze({ ...__bb, requestFromJson, responseToJson, openDatabase }));
