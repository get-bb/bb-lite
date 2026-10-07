use std::path::Path;

use bb_js::{JsRuntime, JsRuntimeOptions, NodeCompatOptions};
use serde_json::{Value, json};

async fn runtime(dir: &Path) -> JsRuntime {
    let rt = JsRuntime::new(JsRuntimeOptions::default()).unwrap();
    let options = NodeCompatOptions {
        cwd: dir.to_string_lossy().into_owned(),
        env: Default::default(),
        fs_root: Some(dir.join("data")),
    };
    bb_js::install_node_compat(&rt, options).await.unwrap();
    bb_js::register_database(&rt, "main", &dir.join("db.sqlite")).await.unwrap();
    rt
}

async fn run(rt: &JsRuntime, name: &str, body: &str) -> Value {
    let src = format!("__bb.handle({name:?}, async () => {{ {body} }});");
    rt.load_module(&format!("test:{name}"), &src).await.unwrap();
    rt.call(name, Value::Null).await.unwrap_or_else(|e| panic!("{name}: {e:?}"))
}

#[tokio::test]
async fn statements_and_values() {
    let dir = tempfile::tempdir().unwrap();
    let rt = runtime(dir.path()).await;
    let got = run(
        &rt,
        "values",
        r#"const db = __bb.openDatabase("main");
           const fk = db.pragma("foreign_keys = ON");
           const fkOn = db.pragma("foreign_keys", { simple: true });
           db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, n REAL, b BLOB, big INTEGER, flag INTEGER);
                    CREATE TABLE c (id INTEGER PRIMARY KEY, t_id INTEGER NOT NULL REFERENCES t(id));`);
           const ins = db.prepare("INSERT INTO t (name, n, b, big, flag) VALUES (?, ?, ?, ?, ?)");
           const r1 = ins.run("one", 1.5, new Uint8Array([1, 2]), 9007199254740993n, true);
           const r2 = db.prepare("INSERT INTO t (name, n, flag) VALUES (@name, :n, $flag)").run({ name: "two", n: null, flag: false });
           const r3 = db.prepare("INSERT INTO t (name) VALUES (?)").run(["three"]);
           const upd = db.prepare("UPDATE t SET n = 7 WHERE id > ?").run(1);
           const row = db.prepare("SELECT * FROM t WHERE id = ?").get(1);
           const none = db.prepare("SELECT * FROM t WHERE id = ?").get(99);
           const names = db.prepare("SELECT name FROM t ORDER BY id").pluck().all();
           const count = db.prepare("SELECT count(*) FROM t").pluck().get();
           const all = db.prepare("SELECT id, n, flag FROM t WHERE id >= :min ORDER BY id").all({ min: 2 });
           let fkErr; try { db.prepare("INSERT INTO c (t_id) VALUES (?)").run(42); } catch (e) { fkErr = [e.name, e.code]; }
           let syntax; try { db.prepare("SELEC nope"); } catch (e) { syntax = e.name; }
           let missing; try { __bb.openDatabase("other"); } catch (e) { missing = e.message; }
           return [fk, fkOn, r1, r2, r3, upd.changes, row.name, row.n, Buffer.isBuffer(row.b), [...row.b],
                   typeof row.big, String(row.big), row.flag, none, names, count, all, fkErr, syntax, missing];"#,
    )
    .await;
    assert_eq!(
        got,
        json!([
            [],
            1,
            {"changes": 1, "lastInsertRowid": 1},
            {"changes": 1, "lastInsertRowid": 2},
            {"changes": 1, "lastInsertRowid": 3},
            2,
            "one",
            1.5,
            true,
            [1, 2],
            "bigint",
            "9007199254740993",
            1,
            null,
            ["one", "two", "three"],
            3,
            [{"id": 2, "n": 7, "flag": 0}, {"id": 3, "n": 7, "flag": null}],
            ["SqliteError", "SQLITE_CONSTRAINT"],
            "SqliteError",
            "database \"other\" is not registered"
        ])
    );
}

#[tokio::test]
async fn transactions() {
    let dir = tempfile::tempdir().unwrap();
    let rt = runtime(dir.path()).await;
    let got = run(
        &rt,
        "tx",
        r#"const db = __bb.openDatabase("main");
           db.exec("CREATE TABLE t (v TEXT)");
           const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
           const names = () => db.prepare("SELECT v FROM t ORDER BY rowid").pluck().all();
           const commit = db.transaction((a, b) => { ins.run(a); ins.run(b); return db.inTransaction; });
           const inside = commit("a", "b");
           const fail = db.transaction(() => { ins.run("lost"); throw new Error("boom"); });
           let msg; try { fail(); } catch (e) { msg = e.message; }
           const inner = db.transaction((v) => { ins.run(v); if (v === "bad") throw new Error("inner"); });
           const outer = db.transaction(() => {
             inner("kept");
             try { inner("bad"); } catch {}
             ins.run("outer");
           });
           outer();
           const outerFail = db.transaction(() => { inner("gone"); throw new Error("outer"); });
           try { outerFail(); } catch {}
           return [inside, msg, names(), db.inTransaction];"#,
    )
    .await;
    assert_eq!(got, json!([true, "boom", ["a", "b", "kept", "outer"], false]));
}

#[tokio::test]
async fn plugin_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let rt = runtime(dir.path()).await;
    rt.load_module(
        "plugin",
        r#"import { join } from "node:path";
           import { mkdir, writeFile, readFile } from "node:fs/promises";
           import { createHash, randomUUID } from "node:crypto";
           const db = __bb.openDatabase("main");
           db.exec("CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT, digest TEXT)");
           const insert = db.prepare("INSERT INTO notes (id, body, digest) VALUES (?, ?, ?)");
           __bb.handle("save", async ({ body }) => {
             const id = randomUUID();
             const digest = createHash("sha256").update(body).digest("hex");
             const dir = join(process.cwd(), "data", "notes");
             await mkdir(dir, { recursive: true });
             await writeFile(join(dir, `${id}.txt`), body);
             insert.run(id, body, digest);
             const stored = await readFile(join(dir, `${id}.txt`), "utf8");
             const row = db.prepare("SELECT body, digest FROM notes WHERE id = ?").get(id);
             return { stored, row, count: db.prepare("SELECT count(*) FROM notes").pluck().get() };
           });"#,
    )
    .await
    .unwrap();
    let got = rt.call("save", json!({ "body": "abc" })).await.unwrap();
    let digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    assert_eq!(
        got,
        json!({ "stored": "abc", "row": { "body": "abc", "digest": digest }, "count": 1 })
    );
    let files = std::fs::read_dir(dir.path().join("data/notes")).unwrap().count();
    assert_eq!(files, 1);
}
