use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use bb_js::{JsError, JsRuntime, JsRuntimeOptions, NodeCompatOptions};
use indexmap::IndexMap;
use serde_json::{Value, json};

static NEXT: AtomicUsize = AtomicUsize::new(0);

async fn runtime(cwd: &Path, fs_root: Option<&Path>) -> JsRuntime {
    let rt = JsRuntime::new(JsRuntimeOptions::default()).unwrap();
    let env = IndexMap::from([("PLUGIN_MODE".to_owned(), "test".to_owned())]);
    let options = NodeCompatOptions {
        cwd: cwd.to_string_lossy().into_owned(),
        env,
        fs_root: fs_root.map(Path::to_path_buf),
    };
    bb_js::install_node_compat(&rt, options).await.unwrap();
    rt
}

async fn eval(rt: &JsRuntime, body: &str) -> Result<Value, JsError> {
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let id = format!("eval{n}");
    let src = format!(
        "import path from \"node:path\";\nimport fs from \"node:fs/promises\";\n\
         import * as fsSync from \"node:fs\";\nimport crypto from \"node:crypto\";\n\
         __bb.handle({id:?}, async (arg) => {{ {body} }});"
    );
    rt.load_module(&format!("test:{id}"), &src).await?;
    rt.call(&id, Value::Null).await
}

async fn ok(rt: &JsRuntime, body: &str) -> Value {
    eval(rt, body).await.unwrap_or_else(|e| panic!("{body}: {e:?}"))
}

#[tokio::test]
async fn path_functions() {
    let rt = runtime(Path::new("/work/dir"), None).await;
    let got = ok(
        &rt,
        r#"return [
            path.join("a", "b/../c", "./d"), path.join(""), path.join("/a/", "b/"),
            path.dirname("/a/b/c.txt"), path.dirname("a"), path.dirname("/a"),
            path.resolve("x", "../y"), path.resolve("/abs", "z"), path.sep,
            path.isAbsolute("/a"), path.isAbsolute("a"), path.basename("/a/b.txt"),
            path.basename("/a/b.txt", ".txt"), path.extname("a/b.tar.gz"), path.extname(".bashrc"),
            path.relative("/a/b/c", "/a/d"), path.normalize("/a//b/../c/."), path.normalize("../x/.."),
        ];"#,
    )
    .await;
    assert_eq!(
        got,
        json!([
            "a/c/d",
            ".",
            "/a/b/",
            "/a/b",
            ".",
            "/",
            "/work/dir/y",
            "/abs/z",
            "/",
            true,
            false,
            "b.txt",
            "b",
            ".gz",
            "",
            "../../d",
            "/a/c",
            ".."
        ])
    );
    let mods = ok(
        &rt,
        r#"const p = await import("path"); const n = await import("node:path");
           return [p.join === n.join, typeof n.default.join, n.sep];"#,
    )
    .await;
    assert_eq!(mods, json!([true, "function", "/"]));
}

#[tokio::test]
async fn buffer_round_trips() {
    let rt = runtime(Path::new("/"), None).await;
    let got = ok(
        &rt,
        r#"const b = Buffer.from("héllo", "utf8");
           const { Buffer: B } = await import("node:buffer");
           return [
             b.toString("base64"), Buffer.from(b.toString("base64"), "base64").toString("utf8"),
             b.toString("hex"), Buffer.from("68c3a9", "hex").toString(), b.length,
             Buffer.byteLength("héllo"), Buffer.isBuffer(b), Buffer.isBuffer(new Uint8Array(1)),
             b instanceof Uint8Array, Buffer.concat([Buffer.from("ab"), Buffer.from([99])]).toString(),
             Buffer.from(new Uint8Array([1, 2])).toString("hex"), B === Buffer,
             Buffer.from("aGk", "base64").toString(), Buffer.from("x").equals(Buffer.from("x")),
             Buffer.from(new TextEncoder().encode("ok")).subarray(1).toString(),
           ];"#,
    )
    .await;
    assert_eq!(
        got,
        json!([
            "aMOpbGxv",
            "héllo",
            "68c3a96c6c6f",
            "hé",
            6,
            6,
            true,
            false,
            true,
            "abc",
            "0102",
            true,
            "hi",
            true,
            "k"
        ])
    );
}

#[tokio::test]
async fn fs_operations_and_error_codes() {
    let dir = tempfile::tempdir().unwrap();
    let rt = runtime(dir.path(), Some(dir.path())).await;
    let got = ok(
        &rt,
        r#"const first = await fs.mkdir("a/b/c", { recursive: true });
           await fs.mkdir("a/b/c", { recursive: true });
           await fs.writeFile("a/b/c/x.txt", "hello", { mode: 0o600 });
           await fs.writeFile("a/bin", new Uint8Array([0, 255, 1]));
           await fs.appendFile("a/b/c/x.txt", "!");
           const text = await fs.readFile("a/b/c/x.txt", "utf8");
           const b64 = await fs.readFile("a/bin", { encoding: "base64" });
           const raw = await fs.readFile("a/bin");
           const st = await fs.stat("a/b/c/x.txt");
           const codes = [];
           for (const f of [
             () => fs.readFile("missing.txt"), () => fs.mkdir("a"), () => fs.readFile("a"),
             () => fs.readFile("a/bin/x"), () => fs.rm("a"),
           ]) { try { await f(); codes.push(null); } catch (e) { codes.push(e.code); } }
           await fs.rm("nothing", { force: true });
           const list = await fs.readdir("a");
           await fs.rm("a", { recursive: true, force: true });
           const gone = fsSync.existsSync("a");
           fsSync.mkdirSync("s", { recursive: true });
           fsSync.writeFileSync("s/f", "sync");
           let syncCode; try { fsSync.readFileSync("nope"); } catch (e) { syncCode = e.code; }
           return [first.endsWith("/a"), text, b64, Buffer.isBuffer(raw), raw.length, st.isFile(),
                   st.size, (st.mode & 0o777).toString(8), codes, list, gone,
                   fsSync.readFileSync("s/f", "utf8"), syncCode];"#,
    )
    .await;
    assert_eq!(
        got,
        json!([
            true,
            "hello!",
            "AP8B",
            true,
            3,
            true,
            6,
            "600",
            ["ENOENT", "EEXIST", "EISDIR", "ENOTDIR", "EISDIR"],
            ["b", "bin"],
            false,
            "sync",
            "ENOENT"
        ])
    );
    let err = eval(&rt, r#"try { await fs.readFile("missing"); } catch (e) { throw e; }"#)
        .await
        .unwrap_err();
    assert!(err.message.starts_with("ENOENT: no such file or directory, readFile '"), "{err:?}");
}

#[tokio::test]
async fn fs_confined_to_root() {
    let base = tempfile::tempdir().unwrap();
    let root = base.path().join("root");
    let outside = base.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret"), "s").unwrap();
    let rt = runtime(&root, Some(&root)).await;
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
    let outside_abs = outside.join("secret").to_string_lossy().into_owned();
    let got = ok(
        &rt,
        &format!(
            r#"const codes = [];
               for (const f of [
                 () => fs.readFile("../outside/secret"), () => fs.readFile({outside_abs:?}),
                 () => fs.writeFile("../escape.txt", "x"), () => fs.readFile("link/secret"),
                 () => fs.writeFile("link/new.txt", "x"), () => fs.mkdir("/tmp/bb-js-nope", {{ recursive: true }}),
               ]) {{ try {{ await f(); codes.push(null); }} catch (e) {{ codes.push(e.code); }} }}
               await fs.writeFile("inside.txt", "ok");
               await fs.writeFile("sub/../inside2.txt", "ok");
               await fs.rm("link");
               return [codes, await fs.readFile("inside.txt", "utf8")];"#
        ),
    )
    .await;
    assert_eq!(got, json!([["EACCES", "EACCES", "EACCES", "EACCES", "EACCES", "EACCES"], "ok"]));
    assert!(!base.path().join("escape.txt").exists());
    assert!(!outside.join("new.txt").exists());
    assert!(outside.join("secret").exists());
}

#[tokio::test]
async fn crypto_os_process_timers_util() {
    let rt = runtime(Path::new("/cwd"), None).await;
    let got = ok(
        &rt,
        r#"const os = await import("node:os");
           const tp = await import("node:timers/promises");
           const util = await import("node:util");
           const proc = await import("node:process");
           const ac = new AbortController();
           const pending = tp.setTimeout(10_000, "late", { signal: ac.signal });
           ac.abort();
           let aborted; try { await pending; } catch (e) { aborted = e.name; }
           let ticked = false; process.nextTick(() => { ticked = true; }); await null; await null;
           const cb = (x, done) => done(null, x * 2);
           return [
             crypto.createHash("sha256").update("abc").digest("hex"),
             crypto.createHash("sha256").update("a").update(Buffer.from("bc")).digest("base64"),
             crypto.randomBytes(16).length, Buffer.isBuffer(crypto.randomBytes(2)),
             /^[0-9a-f-]{36}$/.test(crypto.randomUUID()),
             typeof os.homedir(), typeof os.tmpdir(), typeof os.hostname(), os.platform(),
             await tp.setTimeout(1, "v"), aborted, ticked, await util.promisify(cb)(21),
             util.inspect({ a: 1 }), process.cwd(), process.env.PLUGIN_MODE, proc.cwd(),
             proc.default.env === process.env, typeof process.platform,
           ];"#,
    )
    .await;
    assert_eq!(
        got,
        json!([
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
            16,
            true,
            true,
            "string",
            "string",
            "string",
            std::env::consts::OS.replace("macos", "darwin"),
            "v",
            "AbortError",
            true,
            42,
            "{\"a\":1}",
            "/cwd",
            "test",
            "/cwd",
            true,
            "string"
        ])
    );
    let err = eval(&rt, "await fetch('https://example.com');").await.unwrap_err();
    assert_eq!(err.message, "fetch is not available to plugins yet");
}

#[tokio::test]
async fn request_response_bridge() {
    let rt = runtime(Path::new("/"), None).await;
    rt.load_module(
        "http",
        r#"__bb.handle("http", async (req) => {
             const request = __bb.requestFromJson(req);
             const body = await request.json();
             if (request.method !== "POST") return __bb.responseToJson(new Response(null, { status: 405 }));
             const response = Response.json(
               { url: request.url, method: request.method, auth: request.headers.get("Authorization"), body },
               { status: 201, headers: { "x-extra": "1" } },
             );
             return __bb.responseToJson(response);
           });
           __bb.handle("bytes", async () => {
             const r = new Response(new Uint8Array([1, 2, 3]), { headers: [["X-A", "a"], ["x-a", "b"]] });
             const h = new Headers({ B: "2" }); h.append("a", "1");
             const req = new Request("http://h/p?q=1", { method: "PUT", body: "hey" });
             return [await __bb.responseToJson(r), [...h], await req.text(), r.ok,
                     (await __bb.responseToJson(new Response("text"))).headers];
           });"#,
    )
    .await
    .unwrap();
    let body = "eyJrIjoidiJ9";
    let got = rt
        .call(
            "http",
            json!({
                "method": "POST",
                "url": "http://localhost/api/x?y=1",
                "headers": [["authorization", "Bearer t"], ["content-type", "application/json"]],
                "bodyBase64": body,
            }),
        )
        .await
        .unwrap();
    assert_eq!(got["status"], 201);
    assert_eq!(got["headers"], json!([["content-type", "application/json"], ["x-extra", "1"]]));
    let decoded = rt
        .call(
            "http",
            json!({"method": "POST", "url": "http://l/", "headers": [], "bodyBase64": "e30="}),
        )
        .await;
    assert_eq!(decoded.unwrap()["status"], 201);
    let echoed = eval(&rt, &format!("return atob({:?});", got["bodyBase64"].as_str().unwrap()))
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(echoed.as_str().unwrap()).unwrap(),
        json!({"url": "http://localhost/api/x?y=1", "method": "POST", "auth": "Bearer t", "body": {"k": "v"}})
    );
    let got = rt.call("bytes", Value::Null).await.unwrap();
    assert_eq!(
        got,
        json!([
            {"status": 200, "headers": [["x-a", "a, b"]], "bodyBase64": "AQID"},
            [["a", "1"], ["b", "2"]],
            "hey",
            true,
            [["content-type", "text/plain;charset=UTF-8"]]
        ])
    );
}
