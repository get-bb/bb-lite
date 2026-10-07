(() => {
  "use strict";
  const native = globalThis.__bb_native;
  delete globalThis.__bb_native;
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });

  const formatValue = (v) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack ? `${v.name}: ${v.message}\n${v.stack}` : `${v.name}: ${v.message}`;
    if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
    if (v === undefined || typeof v === "symbol" || typeof v === "bigint") return String(v);
    try {
      return JSON.stringify(v) ?? String(v);
    } catch {
      return String(v);
    }
  };
  const log = (level) => (...args) => native.log(level, args.map(formatValue).join(" "));
  define("console", {
    log: log("log"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    debug: log("debug"),
    trace: log("debug"),
  });
  const reportError = (e) => native.log("error", `Uncaught ${formatValue(e)}`);

  const toJson = (v) => JSON.stringify(v === undefined ? null : v) ?? "null";
  const errorJson = (e) => {
    if (e === null) return JSON.stringify({ name: "InternalError", message: "out of memory", stack: null });
    if (e !== null && typeof e === "object" && "message" in e) {
      return JSON.stringify({
        name: String(e.name ?? "Error"),
        message: String(e.message),
        stack: e.stack == null ? null : String(e.stack),
      });
    }
    let message;
    try {
      message = String(e);
    } catch {
      message = "unknown error";
    }
    return JSON.stringify({ name: "Error", message, stack: null });
  };
  const settleWith = (callId, fn) => {
    let result;
    try {
      result = fn();
    } catch (e) {
      native.settle(callId, false, errorJson(e));
      return;
    }
    Promise.resolve(result).then(
      (v) => {
        let json;
        try {
          json = toJson(v);
        } catch (e) {
          native.settle(callId, false, errorJson(e));
          return;
        }
        native.settle(callId, true, json);
      },
      (e) => native.settle(callId, false, errorJson(e)),
    );
  };

  const handlers = new Map();
  const modules = new Map();
  const timers = new Map();
  const pendingOps = new Map();
  let nextTimer = 1;
  let nextOp = 1;

  const unhandled = new Map();
  globalThis.__bb_internal = {
    track(promise, reason, handled) {
      if (handled) unhandled.delete(promise);
      else unhandled.set(promise, reason);
    },
    flushUnhandled() {
      for (const reason of unhandled.values()) native.log("error", `Uncaught (in promise) ${formatValue(reason)}`);
      unhandled.clear();
    },
    invoke(callId, id, argJson) {
      settleWith(callId, () => {
        const fn = handlers.get(id);
        if (!fn) throw new Error(`no handler registered for "${id}"`);
        return fn(JSON.parse(argJson));
      });
    },
    load(callId, name) {
      settleWith(callId, () =>
        import(name).then((ns) => {
          modules.set(name, ns);
        }),
      );
    },
    callExport(callId, name, exportName, argJson) {
      settleWith(callId, () => {
        const ns = modules.get(name);
        if (!ns) throw new Error(`module "${name}" is not loaded`);
        const fn = ns[exportName];
        if (typeof fn !== "function") {
          throw new TypeError(`export "${exportName}" of "${name}" is not a function`);
        }
        return fn(JSON.parse(argJson));
      });
    },
    fireTimer(id) {
      const t = timers.get(id);
      if (!t) return;
      if (t.repeat) native.setTimer(id, t.ms);
      else timers.delete(id);
      try {
        t.fn(...t.args);
      } catch (e) {
        reportError(e);
      }
    },
    opDone(id, ok, json) {
      const p = pendingOps.get(id);
      if (!p) return;
      pendingOps.delete(id);
      if (ok) p.resolve(JSON.parse(json));
      else p.reject(new Error(json));
    },
  };
  Object.defineProperty(globalThis, "__bb_internal", { enumerable: false });

  const addTimer = (fn, ms, args, repeat) => {
    if (typeof fn !== "function") throw new TypeError("The callback must be a function");
    const id = nextTimer++;
    const n = Number(ms);
    const delay = n >= 1 && n <= 2147483647 ? n : 1;
    timers.set(id, { fn, ms: delay, args, repeat });
    native.setTimer(id, delay);
    return new Timeout(id);
  };
  class Timeout {
    #id;
    constructor(id) {
      this.#id = id;
    }
    ref() {
      return this;
    }
    unref() {
      return this;
    }
    hasRef() {
      return true;
    }
    refresh() {
      const t = timers.get(this.#id);
      if (t) native.setTimer(this.#id, t.ms);
      return this;
    }
    [Symbol.toPrimitive]() {
      return this.#id;
    }
  }
  const clearTimer = (timer) => {
    const id = Number(timer);
    if (timers.delete(id)) native.clearTimer(id);
  };
  define("setTimeout", (fn, ms, ...args) => addTimer(fn, ms, args, false));
  define("setInterval", (fn, ms, ...args) => addTimer(fn, ms, args, true));
  define("clearTimeout", clearTimer);
  define("clearInterval", clearTimer);
  define("queueMicrotask", (fn) => {
    if (typeof fn !== "function") throw new TypeError("The callback must be a function");
    Promise.resolve().then(() => {
      try {
        fn();
      } catch (e) {
        reportError(e);
      }
    });
  });

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));
  const bytesToBase64 = (bytes) => {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
      out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
      out += i + 2 < bytes.length ? B64[n & 63] : "=";
    }
    return out;
  };
  const base64ToBytes = (input) => {
    let s = String(input).replace(/[\t\n\f\r ]/g, "");
    if (s.length % 4 === 0) s = s.replace(/==?$/, "");
    if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) {
      throw new DOMException("The string to be decoded is not correctly encoded.", "InvalidCharacterError");
    }
    const out = new Uint8Array(Math.floor((s.length * 3) / 4));
    let bits = 0;
    let acc = 0;
    let j = 0;
    for (const c of s) {
      acc = (acc << 6) | B64_INDEX.get(c);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[j++] = (acc >> bits) & 255;
      }
    }
    return out;
  };

  define(
    "__bb",
    Object.freeze({
      handle(id, fn) {
        if (typeof fn !== "function") throw new TypeError("handler must be a function");
        handlers.set(String(id), fn);
      },
      op(name, arg) {
        const r = JSON.parse(native.op(String(name), toJson(arg)));
        if ("err" in r) throw new Error(r.err);
        return r.ok;
      },
      opAsync(name, arg) {
        return new Promise((resolve, reject) => {
          const id = nextOp++;
          pendingOps.set(id, { resolve, reject });
          native.opAsync(id, String(name), toJson(arg));
        });
      },
      bytesToBase64: (bytes) => bytesToBase64(new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength)),
      base64ToBytes,
    }),
  );

  class DOMException extends Error {
    constructor(message = "", name = "Error") {
      super(message);
      Object.defineProperty(this, "name", { value: name, configurable: true, writable: true });
    }
  }
  define("DOMException", DOMException);

  define("btoa", (input) => {
    const s = String(input);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > 255) throw new DOMException("Invalid character", "InvalidCharacterError");
      bytes[i] = c;
    }
    return bytesToBase64(bytes);
  });
  define("atob", (input) => {
    let out = "";
    for (const b of base64ToBytes(input)) out += String.fromCharCode(b);
    return out;
  });

  class TextEncoder {
    get encoding() {
      return "utf-8";
    }
    encode(input = "") {
      const out = [];
      for (const ch of String(input)) {
        let cp = ch.codePointAt(0);
        if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
        if (cp < 0x80) out.push(cp);
        else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
        else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        else {
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        }
      }
      return new Uint8Array(out);
    }
  }
  class TextDecoder {
    #fatal;
    #ignoreBOM;
    constructor(label = "utf-8", options = {}) {
      if (!/^\s*(utf-?8|unicode-1-1-utf-8)\s*$/i.test(String(label))) {
        throw new RangeError(`The "${label}" encoding is not supported`);
      }
      this.#fatal = !!options.fatal;
      this.#ignoreBOM = !!options.ignoreBOM;
    }
    get encoding() {
      return "utf-8";
    }
    get fatal() {
      return this.#fatal;
    }
    get ignoreBOM() {
      return this.#ignoreBOM;
    }
    decode(input) {
      if (input === undefined) return "";
      const b = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      let out = "";
      let i = 0;
      const bad = () => {
        if (this.#fatal) throw new TypeError("The encoded data was not valid for encoding utf-8");
        out += "�";
      };
      if (!this.#ignoreBOM && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
      while (i < b.length) {
        const c = b[i];
        let need = 0;
        let cp = 0;
        let lo = 0x80;
        let hi = 0xbf;
        if (c < 0x80) {
          out += String.fromCharCode(c);
          i++;
          continue;
        } else if (c >= 0xc2 && c <= 0xdf) [need, cp] = [1, c & 0x1f];
        else if (c >= 0xe0 && c <= 0xef) {
          [need, cp] = [2, c & 0xf];
          if (c === 0xe0) lo = 0xa0;
          if (c === 0xed) hi = 0x9f;
        } else if (c >= 0xf0 && c <= 0xf4) {
          [need, cp] = [3, c & 0x7];
          if (c === 0xf0) lo = 0x90;
          if (c === 0xf4) hi = 0x8f;
        } else {
          bad();
          i++;
          continue;
        }
        let j = 1;
        for (; j <= need; j++) {
          const n = b[i + j];
          if (n === undefined || n < lo || n > hi) break;
          cp = (cp << 6) | (n & 0x3f);
          lo = 0x80;
          hi = 0xbf;
        }
        if (j <= need) {
          bad();
          i += j;
          continue;
        }
        out += String.fromCodePoint(cp);
        i += need + 1;
      }
      return out;
    }
  }
  define("TextEncoder", TextEncoder);
  define("TextDecoder", TextDecoder);

  const kList = Symbol("list");
  const kUrl = Symbol("url");
  const kParts = Symbol("parts");
  const kParams = Symbol("params");
  const encodeForm = (s) =>
    encodeURIComponent(s)
      .replace(/%20/g, "+")
      .replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const decodeForm = (s) => {
    const t = s.replace(/\+/g, " ");
    try {
      return decodeURIComponent(t);
    } catch {
      return t;
    }
  };
  const parseQuery = (query) => {
    const list = [];
    for (const part of query.replace(/^\?/, "").split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const [k, v] = eq < 0 ? [part, ""] : [part.slice(0, eq), part.slice(eq + 1)];
      list.push([decodeForm(k), decodeForm(v)]);
    }
    return list;
  };

  class URLSearchParams {
    constructor(init) {
      this[kList] = [];
      this[kUrl] = null;
      if (init == null) return;
      if (typeof init === "object" && typeof init[Symbol.iterator] === "function") {
        for (const pair of init) {
          const p = [...pair];
          if (p.length !== 2) throw new TypeError("Each query pair must be a [name, value] tuple");
          this[kList].push([String(p[0]), String(p[1])]);
        }
      } else if (typeof init === "object") {
        for (const k of Object.keys(init)) this[kList].push([k, String(init[k])]);
      } else {
        this[kList] = parseQuery(String(init));
      }
    }
    #update() {
      const url = this[kUrl];
      if (url) url[kParts] = JSON.parse(native.urlSet(url[kParts].href, "search", this.toString()));
    }
    get size() {
      return this[kList].length;
    }
    append(name, value) {
      this[kList].push([String(name), String(value)]);
      this.#update();
    }
    delete(name, value) {
      const n = String(name);
      this[kList] = this[kList].filter(([k, v]) => k !== n || (value !== undefined && v !== String(value)));
      this.#update();
    }
    get(name) {
      const e = this[kList].find(([k]) => k === String(name));
      return e ? e[1] : null;
    }
    getAll(name) {
      return this[kList].filter(([k]) => k === String(name)).map(([, v]) => v);
    }
    has(name, value) {
      return this[kList].some(([k, v]) => k === String(name) && (value === undefined || v === String(value)));
    }
    set(name, value) {
      const n = String(name);
      const i = this[kList].findIndex(([k]) => k === n);
      if (i < 0) this[kList].push([n, String(value)]);
      else this[kList] = this[kList].filter(([k], j) => j <= i || k !== n).map((e, j) => (j === i ? [n, String(value)] : e));
      this.#update();
    }
    sort() {
      this[kList] = this[kList]
        .map((e, i) => [e, i])
        .sort(([a, i], [b, j]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : i - j))
        .map(([e]) => e);
      this.#update();
    }
    forEach(fn, thisArg) {
      for (const [k, v] of this[kList]) fn.call(thisArg, v, k, this);
    }
    *entries() {
      for (const [k, v] of this[kList]) yield [k, v];
    }
    *keys() {
      for (const [k] of this[kList]) yield k;
    }
    *values() {
      for (const [, v] of this[kList]) yield v;
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    toString() {
      return this[kList].map(([k, v]) => `${encodeForm(k)}=${encodeForm(v)}`).join("&");
    }
  }

  const parseUrl = (input, base) => {
    const r = JSON.parse(native.urlParse(String(input), base === undefined ? null : String(base)));
    if (r.error) throw new TypeError(`Invalid URL: ${input}`);
    return r;
  };
  class URL {
    constructor(input, base) {
      this[kParts] = parseUrl(input, base);
      this[kParams] = null;
    }
    get origin() {
      return this[kParts].origin;
    }
    get href() {
      return this[kParts].href;
    }
    set href(v) {
      this[kParts] = parseUrl(v);
      if (this[kParams]) this[kParams][kList] = parseQuery(this[kParts].search);
    }
    get searchParams() {
      if (!this[kParams]) {
        const p = new URLSearchParams(this[kParts].search);
        p[kUrl] = this;
        this[kParams] = p;
      }
      return this[kParams];
    }
    toString() {
      return this.href;
    }
    toJSON() {
      return this.href;
    }
    static canParse(input, base) {
      try {
        parseUrl(input, base);
        return true;
      } catch {
        return false;
      }
    }
    static parse(input, base) {
      try {
        return new URL(input, base);
      } catch {
        return null;
      }
    }
  }
  for (const prop of ["protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"]) {
    Object.defineProperty(URL.prototype, prop, {
      get() {
        return this[kParts][prop];
      },
      set(v) {
        this[kParts] = JSON.parse(native.urlSet(this[kParts].href, prop, String(v)));
        if (prop === "search" && this[kParams]) this[kParams][kList] = parseQuery(this[kParts].search);
      },
      configurable: true,
    });
  }
  define("URL", URL);
  define("URLSearchParams", URLSearchParams);

  class Event {
    constructor(type) {
      this.type = String(type);
      this.target = null;
      this.currentTarget = null;
      this.defaultPrevented = false;
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
  }
  class EventTarget {
    #listeners = new Map();
    addEventListener(type, fn, options) {
      if (!fn) return;
      const list = this.#listeners.get(type) ?? [];
      this.#listeners.set(type, list);
      if (list.some((e) => e.fn === fn)) return;
      list.push({ fn, once: typeof options === "object" && !!options?.once });
      options?.signal?.addEventListener?.("abort", () => this.removeEventListener(type, fn));
    }
    removeEventListener(type, fn) {
      const list = this.#listeners.get(type);
      const i = list ? list.findIndex((e) => e.fn === fn) : -1;
      if (i >= 0) list.splice(i, 1);
    }
    dispatchEvent(event) {
      event.target = this;
      event.currentTarget = this;
      const call = (fn) => {
        try {
          if (typeof fn === "function") fn.call(this, event);
          else fn?.handleEvent?.(event);
        } catch (e) {
          reportError(e);
        }
      };
      const handler = this[`on${event.type}`];
      if (typeof handler === "function") call(handler);
      for (const e of [...(this.#listeners.get(event.type) ?? [])]) {
        if (e.once) this.removeEventListener(event.type, e.fn);
        call(e.fn);
      }
      return !event.defaultPrevented;
    }
  }
  define("Event", Event);
  define("EventTarget", EventTarget);

  const kCreate = Symbol("create");
  const kAbort = Symbol("abort");
  const kState = Symbol("state");
  class AbortSignal extends EventTarget {
    constructor(key) {
      if (key !== kCreate) throw new TypeError("Illegal constructor");
      super();
      this[kState] = { aborted: false, reason: undefined };
      this.onabort = null;
    }
    get aborted() {
      return this[kState].aborted;
    }
    get reason() {
      return this[kState].reason;
    }
    throwIfAborted() {
      if (this.aborted) throw this.reason;
    }
    [kAbort](reason) {
      if (this[kState].aborted) return;
      this[kState] = {
        aborted: true,
        reason: reason === undefined ? new DOMException("This operation was aborted", "AbortError") : reason,
      };
      this.dispatchEvent(new Event("abort"));
    }
    static abort(reason) {
      const s = new AbortSignal(kCreate);
      s[kAbort](reason);
      return s;
    }
    static timeout(ms) {
      const s = new AbortSignal(kCreate);
      setTimeout(() => s[kAbort](new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);
      return s;
    }
    static any(signals) {
      const s = new AbortSignal(kCreate);
      const list = [...signals];
      const done = list.find((x) => x.aborted);
      if (done) s[kAbort](done.reason);
      else for (const x of list) x.addEventListener("abort", () => s[kAbort](x.reason), { once: true });
      return s;
    }
  }
  class AbortController {
    #signal = new AbortSignal(kCreate);
    get signal() {
      return this.#signal;
    }
    abort(reason) {
      this.#signal[kAbort](reason);
    }
  }
  define("AbortSignal", AbortSignal);
  define("AbortController", AbortController);

  const getRandomValues = (array) => {
    if (!ArrayBuffer.isView(array) || array instanceof DataView || array instanceof Float32Array || array instanceof Float64Array) {
      throw new DOMException("The data argument must be an integer-type TypedArray", "TypeMismatchError");
    }
    if (array.byteLength > 65536) {
      throw new DOMException("The requested length exceeds 65,536 bytes", "QuotaExceededError");
    }
    const hex = native.randomHex(array.byteLength);
    const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < view.length; i++) view[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return array;
  };
  define("crypto", {
    getRandomValues,
    randomUUID() {
      const b = getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  });

  define("structuredClone", (value) => {
    const memo = new Map();
    const clone = (v) => {
      if (typeof v === "function" || typeof v === "symbol") {
        throw new DOMException(`${String(v)} could not be cloned.`, "DataCloneError");
      }
      if (v === null || typeof v !== "object") return v;
      if (memo.has(v)) return memo.get(v);
      let out;
      if (v instanceof Date) out = new Date(v.getTime());
      else if (v instanceof RegExp) out = new RegExp(v.source, v.flags);
      else if (v instanceof ArrayBuffer) out = v.slice(0);
      else if (ArrayBuffer.isView(v)) {
        const buf = clone(v.buffer);
        out = v instanceof DataView ? new DataView(buf, v.byteOffset, v.byteLength) : new v.constructor(buf, v.byteOffset, v.length);
      } else if (v instanceof Error) {
        const Ctor = typeof globalThis[v.name] === "function" ? globalThis[v.name] : Error;
        out = new Ctor(v.message);
        if (v.stack) out.stack = v.stack;
      } else if (v instanceof Boolean || v instanceof Number || v instanceof String) out = Object(v.valueOf());
      if (out !== undefined) {
        memo.set(v, out);
        return out;
      }
      if (v instanceof Map) {
        out = new Map();
        memo.set(v, out);
        for (const [k, x] of v) out.set(clone(k), clone(x));
      } else if (v instanceof Set) {
        out = new Set();
        memo.set(v, out);
        for (const x of v) out.add(clone(x));
      } else {
        out = Array.isArray(v) ? new Array(v.length) : {};
        memo.set(v, out);
        for (const k of Object.keys(v)) out[k] = clone(v[k]);
      }
      return out;
    };
    return clone(value);
  });
})();
