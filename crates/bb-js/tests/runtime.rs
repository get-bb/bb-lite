use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use bb_js::{JsRuntime, JsRuntimeOptions};
use parking_lot::Mutex;
use serde_json::{Value, json};

static NEXT: AtomicUsize = AtomicUsize::new(0);

fn runtime() -> JsRuntime {
    JsRuntime::new(JsRuntimeOptions::default()).unwrap()
}

async fn eval(rt: &JsRuntime, body: &str) -> Result<Value, bb_js::JsError> {
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let id = format!("eval{n}");
    let src = format!("__bb.handle({id:?}, async (arg) => {{ {body} }});");
    rt.load_module(&format!("test:{id}"), &src).await?;
    rt.call(&id, Value::Null).await
}

#[tokio::test]
async fn call_handlers_and_errors() {
    let rt = runtime();
    rt.load_module(
        "m",
        r#"
        __bb.handle("echo", (x) => ({ got: x }));
        __bb.handle("nothing", () => undefined);
        __bb.handle("throws", () => { throw new RangeError("bad range"); });
        __bb.handle("rejects", async () => { await null; throw new TypeError("later"); });
        __bb.handle("throwsString", () => { throw "plain"; });
        "#,
    )
    .await
    .unwrap();
    assert_eq!(rt.call("echo", json!([1, "a"])).await.unwrap(), json!({ "got": [1, "a"] }));
    assert_eq!(rt.call("nothing", json!(null)).await.unwrap(), Value::Null);
    let e = rt.call("throws", Value::Null).await.unwrap_err();
    assert_eq!((e.name.as_str(), e.message.as_str()), ("RangeError", "bad range"));
    assert!(e.stack.is_some());
    let e = rt.call("rejects", Value::Null).await.unwrap_err();
    assert_eq!((e.name.as_str(), e.message.as_str()), ("TypeError", "later"));
    assert_eq!(rt.call("throwsString", Value::Null).await.unwrap_err().message, "plain");
    let e = rt.call("missing", Value::Null).await.unwrap_err();
    assert!(e.message.contains("no handler registered"), "{e}");
    let e = rt.load_module("broken", "export const = ;").await.unwrap_err();
    assert_eq!(e.name, "SyntaxError");
}

#[tokio::test]
async fn modules_exports_and_builtins() {
    let rt = runtime();
    rt.register_module("node:fake", "export const double = (x) => x * 2;").await;
    rt.load_module(
        "plugin",
        r#"
        import { double } from "node:fake";
        await new Promise((r) => setTimeout(r, 5));
        export default function plugin(bb) { return { n: double(bb.n) }; }
        export const notFn = 1;
        "#,
    )
    .await
    .unwrap();
    assert_eq!(
        rt.call_export("plugin", "default", json!({ "n": 21 })).await.unwrap(),
        json!({ "n": 42 })
    );
    assert!(rt.call_export("plugin", "notFn", Value::Null).await.is_err());
    assert!(rt.call_export("nope", "default", Value::Null).await.is_err());
    let e = rt.load_module("bad-import", r#"import "node:missing";"#).await.unwrap_err();
    assert!(e.message.contains("node:missing"), "{e}");
}

#[tokio::test]
async fn sync_and_async_ops() {
    let rt = runtime();
    rt.register_sync_op(
        "add",
        Arc::new(|v| match (v[0].as_i64(), v[1].as_i64()) {
            (Some(a), Some(b)) => Ok(json!(a + b)),
            _ => Err("expected two numbers".into()),
        }),
    )
    .await;
    rt.register_async_op(
        "sleepEcho",
        Arc::new(|v| {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                if v == json!("fail") { Err("op failed".into()) } else { Ok(json!({ "echo": v })) }
            })
        }),
    )
    .await;
    let out = eval(
        &rt,
        r#"
        let err;
        try { __bb.op("add", ["x"]); } catch (e) { err = e instanceof Error && e.message; }
        let asyncErr;
        try { await __bb.opAsync("sleepEcho", "fail"); } catch (e) { asyncErr = e.message; }
        let unknown;
        try { __bb.op("nope", null); } catch (e) { unknown = e.message; }
        return { sum: __bb.op("add", [2, 3]), err, asyncOk: await __bb.opAsync("sleepEcho", { b: "aGk=" }), asyncErr, unknown };
        "#,
    )
    .await
    .unwrap();
    assert_eq!(
        out,
        json!({ "sum": 5, "err": "expected two numbers", "asyncOk": { "echo": { "b": "aGk=" } },
                "asyncErr": "op failed", "unknown": "unknown op \"nope\"" })
    );
}

#[tokio::test]
async fn overlapping_calls_do_not_block() {
    let rt = runtime();
    rt.load_module(
        "o",
        r#"
        __bb.handle("slow", async () => { await new Promise((r) => setTimeout(r, 50)); return "slow"; });
        __bb.handle("fast", () => "fast");
        "#,
    )
    .await
    .unwrap();
    let start = Instant::now();
    let slow = tokio::spawn({
        let rt = rt.clone();
        async move { rt.call("slow", Value::Null).await }
    });
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert_eq!(rt.call("fast", Value::Null).await.unwrap(), json!("fast"));
    assert!(!slow.is_finished());
    assert_eq!(slow.await.unwrap().unwrap(), json!("slow"));
    assert!(start.elapsed() >= Duration::from_millis(50));
}

#[tokio::test]
async fn timers_and_microtasks() {
    let rt = runtime();
    let out = eval(
        &rt,
        r#"
        const log = [];
        setTimeout(() => log.push("t20"), 20);
        setTimeout((a, b) => log.push(`t0:${a}${b}`), 0, "x", "y");
        const cancelled = setTimeout(() => log.push("never"), 10);
        clearTimeout(+cancelled);
        const unrefd = setTimeout(() => log.push("never2"), 10).unref();
        clearTimeout(unrefd);
        queueMicrotask(() => log.push("micro"));
        let n = 0;
        await new Promise((resolve) => {
          const iv = setInterval(() => { n++; if (n === 3) { clearInterval(iv); resolve(); } }, 5);
        });
        await new Promise((r) => setTimeout(r, 30));
        return { log, n };
        "#,
    )
    .await
    .unwrap();
    assert_eq!(out, json!({ "log": ["micro", "t0:xy", "t20"], "n": 3 }));
}

#[tokio::test]
async fn console_goes_to_callback() {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    let rt = JsRuntime::new(JsRuntimeOptions {
        console: Some(Arc::new(move |level, msg| sink.lock().push(format!("{level}|{msg}")))),
        ..Default::default()
    })
    .unwrap();
    eval(
        &rt,
        r#"console.log("a", 1, { b: [2] }); console.info("i"); console.warn("w");
           console.error(new Error("boom").message); console.debug(undefined, null);"#,
    )
    .await
    .unwrap();
    assert_eq!(
        *lines.lock(),
        vec!["log|a 1 {\"b\":[2]}", "info|i", "warn|w", "error|boom", "debug|undefined null"]
    );
}

#[tokio::test]
async fn url_and_search_params() {
    let rt = runtime();
    let out = eval(
        &rt,
        r#"
        const u = new URL("https://x.dev/p?a=1#h");
        const parts = [u.href, u.origin, u.protocol, u.host, u.hostname, u.port, u.pathname, u.search, u.hash, String(u)];
        const p = u.searchParams;
        p.append("b", "x y");
        p.append("b", "z&");
        const afterAppend = u.href;
        const read = [p.get("a"), p.getAll("b"), p.has("a"), p.has("zz"), p.get("zz")];
        p.set("a", "2");
        p.delete("b");
        const iter = [...p];
        u.search = "?q=1&q=2";
        const relative = new URL("../c?d=e", "http://h.io:8080/a/b/").href;
        let invalid;
        try { new URL("not a url"); } catch (e) { invalid = e instanceof TypeError; }
        const sp = new URLSearchParams({ k: "v", s: "a+b" });
        const fromStr = [...new URLSearchParams("?x=1&y=%20+2&x=3")];
        return { parts, afterAppend, read, iter, href: u.href, q: p.getAll("q"), relative, invalid,
                 sp: sp.toString(), fromStr, canParse: URL.canParse("nope") };
        "#,
    )
    .await
    .unwrap();
    assert_eq!(
        out,
        json!({
            "parts": ["https://x.dev/p?a=1#h", "https://x.dev", "https:", "x.dev", "x.dev", "", "/p", "?a=1", "#h", "https://x.dev/p?a=1#h"],
            "afterAppend": "https://x.dev/p?a=1&b=x+y&b=z%26#h",
            "read": ["1", ["x y", "z&"], true, false, null],
            "iter": [["a", "2"]],
            "href": "https://x.dev/p?q=1&q=2#h",
            "q": ["1", "2"],
            "relative": "http://h.io:8080/a/c?d=e",
            "invalid": true,
            "sp": "k=v&s=a%2Bb",
            "fromStr": [["x", "1"], ["y", "  2"], ["x", "3"]],
            "canParse": false,
        })
    );
}

#[tokio::test]
async fn text_codecs_and_base64() {
    let rt = runtime();
    let out = eval(
        &rt,
        r#"
        const bytes = new TextEncoder().encode("hé€😀");
        const decoded = new TextDecoder().decode(bytes);
        const lossy = new TextDecoder().decode(new Uint8Array([0x61, 0xff, 0x62]));
        let fatal;
        try { new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xc3])); } catch (e) { fatal = e.name; }
        let badAtob;
        try { atob("@@"); } catch (e) { badAtob = e.name; }
        return { bytes: [...bytes], decoded, lossy, fatal, b: btoa("hello"), a: atob("aGVsbG8="), badAtob,
                 bb: __bb.bytesToBase64(new Uint8Array([0, 255, 1])), back: [...__bb.base64ToBytes("AP8B")] };
        "#,
    )
    .await
    .unwrap();
    assert_eq!(
        out,
        json!({
            "bytes": [104, 195, 169, 226, 130, 172, 240, 159, 152, 128],
            "decoded": "hé€😀", "lossy": "a\u{fffd}b", "fatal": "TypeError",
            "b": "aGVsbG8=", "a": "hello", "badAtob": "InvalidCharacterError",
            "bb": "AP8B", "back": [0, 255, 1],
        })
    );
}

#[tokio::test]
async fn abort_controller_and_signal() {
    let rt = runtime();
    let out = eval(
        &rt,
        r#"
        const c = new AbortController();
        const seen = [];
        const removed = () => seen.push("removed");
        c.signal.addEventListener("abort", (e) => seen.push(`listener:${e.type}`));
        c.signal.addEventListener("abort", removed);
        c.signal.removeEventListener("abort", removed);
        c.signal.onabort = () => seen.push("onabort");
        const before = c.signal.aborted;
        c.abort("why");
        c.abort("again");
        let thrown;
        try { c.signal.throwIfAborted(); } catch (e) { thrown = e; }
        const pre = AbortSignal.abort();
        const t = AbortSignal.timeout(10);
        const any = AbortSignal.any([new AbortController().signal, t]);
        await new Promise((r) => setTimeout(r, 30));
        return { before, aborted: c.signal.aborted, reason: c.signal.reason, seen, thrown,
                 pre: [pre.aborted, pre.reason.name], timeout: [t.aborted, t.reason.name],
                 any: [any.aborted, any.reason.name] };
        "#,
    )
    .await
    .unwrap();
    assert_eq!(
        out,
        json!({
            "before": false, "aborted": true, "reason": "why", "seen": ["onabort", "listener:abort"],
            "thrown": "why", "pre": [true, "AbortError"], "timeout": [true, "TimeoutError"],
            "any": [true, "TimeoutError"],
        })
    );
}

#[tokio::test]
async fn crypto_and_structured_clone() {
    let rt = runtime();
    let out = eval(
        &rt,
        r#"
        const id = crypto.randomUUID();
        const a = crypto.getRandomValues(new Uint8Array(32));
        const src = { d: new Date(5), m: new Map([["k", new Set([1, 2])]]), t: new Uint16Array([1, 2, 3]), r: /x/g, arr: [1, { n: 2 }] };
        src.self = src;
        const c = structuredClone(src);
        let fnErr;
        try { structuredClone({ f() {} }); } catch (e) { fnErr = e.name; }
        return {
          uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
          distinct: id !== crypto.randomUUID(),
          randomFilled: a.some((x) => x !== 0),
          date: c.d instanceof Date && c.d !== src.d && c.d.getTime() === 5,
          map: c.m instanceof Map && c.m.get("k") instanceof Set && [...c.m.get("k")],
          typed: c.t instanceof Uint16Array && c.t.buffer !== src.t.buffer && [...c.t],
          regex: c.r instanceof RegExp && c.r.flags,
          arr: c.arr, cycle: c.self === c, fnErr,
        };
        "#,
    )
    .await
    .unwrap();
    assert_eq!(
        out,
        json!({
            "uuid": true, "distinct": true, "randomFilled": true, "date": true, "map": [1, 2],
            "typed": [1, 2, 3], "regex": "g", "arr": [1, { "n": 2 }], "cycle": true, "fnErr": "DataCloneError",
        })
    );
}

#[tokio::test]
async fn deadline_interrupts_infinite_loop() {
    let rt = JsRuntime::new(JsRuntimeOptions {
        deadline: Duration::from_millis(200),
        ..Default::default()
    })
    .unwrap();
    rt.load_module(
        "loop",
        r#"__bb.handle("spin", () => { for (;;) {} }); __bb.handle("ok", () => 1);"#,
    )
    .await
    .unwrap();
    let start = Instant::now();
    let e = rt.call("spin", Value::Null).await.unwrap_err();
    assert!(e.message.contains("interrupted"), "{e:?}");
    assert!(start.elapsed() < Duration::from_secs(3));
    assert_eq!(rt.call("ok", Value::Null).await.unwrap(), json!(1));
}

#[tokio::test]
async fn memory_limit_is_enforced() {
    let rt =
        JsRuntime::new(JsRuntimeOptions { memory_limit: Some(16 << 20), ..Default::default() })
            .unwrap();
    rt.load_module(
        "mem",
        r#"__bb.handle("hog", () => { const a = []; for (;;) a.push(new Array(10000).fill(a.length)); });
           __bb.handle("ok", () => 2);"#,
    )
    .await
    .unwrap();
    let e = rt.call("hog", Value::Null).await.unwrap_err();
    assert!(e.message.contains("out of memory") || e.name == "InternalError", "{e:?}");
    assert_eq!(rt.call("ok", Value::Null).await.unwrap(), json!(2));
}

#[tokio::test]
async fn shutdown_stops_the_runtime() {
    let rt = runtime();
    rt.load_module("s", r#"__bb.handle("x", () => 1);"#).await.unwrap();
    rt.shutdown().await;
    assert!(rt.call("x", Value::Null).await.is_err());
}

#[tokio::test]
async fn zod_bundle_validates() {
    let rt = runtime();
    rt.load_module("zod-validate", include_str!("fixtures/zod-validate.mjs")).await.unwrap();
    let valid = json!({
        "id": "t1", "email": "a@b.dev", "url": "https://example.com/x?y=1",
        "at": "2026-10-07T12:00:00Z", "tags": ["a", "b"],
    });
    assert_eq!(rt.call("validate", valid).await.unwrap(), json!({ "ok": true, "issues": [] }));
    let invalid =
        json!({ "id": "", "email": "nope", "url": "not a url", "at": "yesterday", "tags": ["c"] });
    let out = rt.call("validate", invalid).await.unwrap();
    assert_eq!(out["ok"], json!(false));
    assert_eq!(out["issues"].as_array().map(Vec::len), Some(5), "{out}");
    assert_eq!(
        rt.call_export("zod-validate", "default", Value::Null).await.unwrap(),
        json!("zod-fixture")
    );
}

#[tokio::test]
async fn deadline_rejects_async_handler_and_reports_timer_errors() {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    let rt = JsRuntime::new(JsRuntimeOptions {
        deadline: Duration::from_millis(200),
        console: Some(Arc::new(move |level, msg| sink.lock().push(format!("{level}|{msg}")))),
        ..Default::default()
    })
    .unwrap();
    rt.load_module(
        "aloop",
        r#"__bb.handle("spin", async () => { await new Promise((r) => setTimeout(r, 1)); for (;;) {} });
           __bb.handle("boom", () => { setTimeout(() => { throw new Error("in timer"); }, 1); Promise.reject(new Error("lost")); Promise.reject(1).catch(() => {}); return 1; });"#,
    )
    .await
    .unwrap();
    let e = rt.call("spin", Value::Null).await.unwrap_err();
    assert!(e.message.contains("interrupted"), "{e:?}");
    rt.call("boom", Value::Null).await.unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(
        lines.lock().iter().any(|l| l.starts_with("error|Uncaught Error: in timer")),
        "{lines:?}"
    );
    let unhandled: Vec<_> = lines
        .lock()
        .iter()
        .filter(|l| l.starts_with("error|Uncaught (in promise)"))
        .cloned()
        .collect();
    assert_eq!(unhandled.len(), 1, "{unhandled:?}");
    assert!(unhandled[0].contains("Error: lost"), "{unhandled:?}");
}

#[test]
fn handle_and_futures_are_send_sync() {
    fn send_sync<T: Send + Sync + Clone>() {}
    fn send<T: Send>(_: T) {}
    send_sync::<JsRuntime>();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let js = rt.block_on(async { runtime() });
    send(js.call("x", Value::Null));
    send(js.load_module("m", ""));
    send(js.call_export("m", "default", Value::Null));
    send(js.shutdown());
}
