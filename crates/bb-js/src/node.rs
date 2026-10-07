use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use indexmap::IndexMap;
use parking_lot::Mutex;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, Statement};
use serde_json::{Map, Value, json};
use sha2::Digest;

use crate::{JsError, JsRuntime};

const GLOBALS_JS: &str = include_str!("js/node_globals.js");
const DATABASE_JS: &str = include_str!("js/node_database.js");

const MODULES: &[(&str, &str, &str)] = &[
    (
        "path",
        "path",
        "join dirname resolve sep delimiter isAbsolute basename extname relative normalize \
         parse format toNamespacedPath posix",
    ),
    (
        "fs/promises",
        "fsp",
        "readFile writeFile appendFile mkdir rm rmdir unlink stat lstat readdir rename \
         access copyFile constants",
    ),
    (
        "fs",
        "fs",
        "promises existsSync readFileSync writeFileSync appendFileSync mkdirSync rmSync \
         statSync readdirSync unlinkSync renameSync constants",
    ),
    ("crypto", "crypto", "randomBytes randomUUID createHash getRandomValues webcrypto"),
    ("os", "os", "homedir tmpdir hostname platform type arch EOL"),
    ("timers/promises", "timersPromises", "setTimeout setImmediate"),
    ("timers", "timers", "setTimeout clearTimeout setInterval clearInterval setImmediate"),
    ("buffer", "buffer", "Buffer"),
    ("process", "process", "cwd env platform nextTick argv"),
    ("util", "util", "promisify inspect types format TextEncoder TextDecoder"),
];

/// Settings for `install_node_compat`.
#[derive(Debug, Clone, Default)]
pub struct NodeCompatOptions {
    /// What `process.cwd()` returns and where relative filesystem paths resolve.
    pub cwd: String,
    /// The contents of `process.env`.
    pub env: IndexMap<String, String>,
    /// When set, every filesystem path must resolve inside this directory (created if missing).
    pub fs_root: Option<PathBuf>,
}

/// Registers the `node:*` modules, the Node and fetch globals and `__bb.openDatabase`.
pub async fn install_node_compat(
    runtime: &JsRuntime,
    options: NodeCompatOptions,
) -> Result<(), JsError> {
    let root = match &options.fs_root {
        Some(root) => std::fs::create_dir_all(root)
            .and_then(|_| root.canonicalize())
            .map(Some)
            .map_err(|e| JsError::new("Error", format!("cannot use {}: {e}", root.display())))?,
        None => None,
    };
    let fs = Arc::new(Fs { cwd: PathBuf::from(&options.cwd), root });
    let config = json!({
        "cwd": options.cwd,
        "env": options.env,
        "platform": platform(),
        "arch": std::env::consts::ARCH,
        "homedir": std::env::var("HOME").unwrap_or_else(|_| "/".into()),
        "tmpdir": std::env::temp_dir().to_string_lossy(),
        "hostname": hostname(),
    });
    runtime.register_sync_op("node.config", Arc::new(move |_| Ok(config.clone()))).await;
    let sync_fs = fs.clone();
    runtime.register_sync_op("node.fs", Arc::new(move |arg| sync_fs.call(&arg))).await;
    runtime
        .register_async_op(
            "node.fs",
            Arc::new(move |arg| {
                let fs = fs.clone();
                Box::pin(async move {
                    tokio::task::spawn_blocking(move || fs.call(&arg))
                        .await
                        .map_err(|e| e.to_string())?
                })
            }),
        )
        .await;
    runtime.register_sync_op("node.hash", Arc::new(hash)).await;
    runtime.register_module("bb:node-database", DATABASE_JS).await;
    runtime.load_module("bb:node-globals", GLOBALS_JS).await?;
    for (name, key, exports) in MODULES {
        let mut src = format!("const m = globalThis.__bb_node.{key};\nexport default m;\n");
        for export in exports.split_whitespace() {
            src.push_str(&format!("export const {export} = m.{export};\n"));
        }
        runtime.register_module(&format!("node:{name}"), &src).await;
        runtime.register_module(name, &src).await;
    }
    Ok(())
}

/// Opens the SQLite database at `path` for `__bb.openDatabase(name)`.
pub async fn register_database(
    runtime: &JsRuntime,
    name: &str,
    path: &Path,
) -> Result<(), JsError> {
    let conn = Connection::open(path).map_err(|e| JsError::new("SqliteError", e.to_string()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| JsError::new("SqliteError", e.to_string()))?;
    let conn = Arc::new(Mutex::new(conn));
    runtime
        .register_sync_op(
            &format!("db:{name}"),
            Arc::new(move |arg| db_call(&conn.lock(), &arg).map_err(|e| e.to_string())),
        )
        .await;
    Ok(())
}

fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        os => os,
    }
}

fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .or_else(|_| std::fs::read_to_string("/etc/hostname"))
        .map(|s| s.trim().to_owned())
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "localhost".into())
}

fn hash(arg: Value) -> Result<Value, String> {
    let data = B64.decode(arg["data"].as_str().unwrap_or("")).map_err(|e| e.to_string())?;
    let out = match arg["algorithm"].as_str().unwrap_or("").to_ascii_lowercase().as_str() {
        "sha256" => sha2::Sha256::digest(&data).to_vec(),
        "sha224" => sha2::Sha224::digest(&data).to_vec(),
        "sha384" => sha2::Sha384::digest(&data).to_vec(),
        "sha512" => sha2::Sha512::digest(&data).to_vec(),
        other => return Err(format!("Digest method not supported: {other}")),
    };
    Ok(Value::String(B64.encode(out)))
}

struct Fs {
    cwd: PathBuf,
    root: Option<PathBuf>,
}

fn io_code(e: &io::Error) -> (&'static str, &'static str) {
    match e.kind() {
        io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        io::ErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
        io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        io::ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        io::ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        io::ErrorKind::DirectoryNotEmpty => ("ENOTEMPTY", "directory not empty"),
        _ => ("EIO", "i/o error"),
    }
}

fn fs_error(code: &str, message: &str, syscall: &str, path: &Path) -> String {
    format!("{code}: {message}, {syscall} '{}'", path.display())
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn meta_json(m: &std::fs::Metadata) -> Value {
    let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
    #[cfg(unix)]
    let mode = std::os::unix::fs::PermissionsExt::mode(&m.permissions());
    #[cfg(not(unix))]
    let mode = 0;
    json!({
        "size": m.len(),
        "mode": mode,
        "mtimeMs": mtime.map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0),
        "isFile": m.is_file(),
        "isDirectory": m.is_dir(),
        "isSymbolicLink": m.file_type().is_symlink(),
    })
}

impl Fs {
    fn resolve(&self, raw: &str, syscall: &str) -> Result<PathBuf, String> {
        let path = normalize(&self.cwd.join(raw));
        let Some(root) = &self.root else { return Ok(path) };
        let no_follow = matches!(syscall, "rm" | "unlink" | "lstat" | "rename");
        let mut probe = match path.parent() {
            Some(parent) if no_follow => parent,
            _ => path.as_path(),
        };
        loop {
            if let Ok(real) = probe.canonicalize() {
                if real.starts_with(root) {
                    return Ok(path);
                }
                break;
            }
            match probe.parent() {
                Some(parent) => probe = parent,
                None => break,
            }
        }
        Err(fs_error("EACCES", "permission denied", syscall, &path))
    }

    fn call(&self, arg: &Value) -> Result<Value, String> {
        let op = arg["op"].as_str().unwrap_or("");
        let path = self.resolve(arg["path"].as_str().unwrap_or(""), op)?;
        let flag = |name: &str| arg[name].as_bool().unwrap_or(false);
        let err = |e: io::Error| {
            let (code, message) = io_code(&e);
            fs_error(code, message, op, &path)
        };
        match op {
            "readFile" => {
                if path.is_dir() {
                    return Err(fs_error(
                        "EISDIR",
                        "illegal operation on a directory",
                        "read",
                        &path,
                    ));
                }
                std::fs::read(&path).map(|b| Value::String(B64.encode(b))).map_err(err)
            }
            "writeFile" => {
                let data =
                    B64.decode(arg["data"].as_str().unwrap_or("")).map_err(|e| e.to_string())?;
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create(true);
                if flag("append") {
                    options.append(true);
                } else {
                    options.truncate(true);
                }
                #[cfg(unix)]
                if let Some(mode) = arg["mode"].as_u64() {
                    std::os::unix::fs::OpenOptionsExt::mode(&mut options, mode as u32);
                }
                let mut file = options.open(&path).map_err(err)?;
                io::Write::write_all(&mut file, &data).map(|_| Value::Null).map_err(err)
            }
            "mkdir" => {
                if flag("recursive") {
                    if path.is_dir() {
                        return Ok(Value::Null);
                    }
                    let mut first = path.as_path();
                    while let Some(parent) = first.parent().filter(|p| !p.exists()) {
                        first = parent;
                    }
                    let first = first.to_string_lossy().into_owned();
                    std::fs::create_dir_all(&path).map(|_| Value::String(first)).map_err(err)
                } else {
                    std::fs::create_dir(&path).map(|_| Value::Null).map_err(err)
                }
            }
            "rm" => match std::fs::symlink_metadata(&path) {
                Err(e) if e.kind() == io::ErrorKind::NotFound && flag("force") => Ok(Value::Null),
                Err(e) => Err(err(e)),
                Ok(m) if m.is_dir() => {
                    if flag("recursive") {
                        std::fs::remove_dir_all(&path).map(|_| Value::Null).map_err(err)
                    } else {
                        Err(fs_error("EISDIR", "is a directory", op, &path))
                    }
                }
                Ok(_) => std::fs::remove_file(&path).map(|_| Value::Null).map_err(err),
            },
            "rmdir" => std::fs::remove_dir(&path).map(|_| Value::Null).map_err(err),
            "unlink" => std::fs::remove_file(&path).map(|_| Value::Null).map_err(err),
            "stat" => std::fs::metadata(&path).map(|m| meta_json(&m)).map_err(err),
            "lstat" => std::fs::symlink_metadata(&path).map(|m| meta_json(&m)).map_err(err),
            "access" => std::fs::metadata(&path).map(|_| Value::Null).map_err(err),
            "exists" => Ok(Value::Bool(path.exists())),
            "readdir" => {
                let mut out = Vec::new();
                for entry in std::fs::read_dir(&path).map_err(err)? {
                    let entry = entry.map_err(err)?;
                    let kind = entry.file_type().map_err(err)?;
                    out.push(json!({
                        "name": entry.file_name().to_string_lossy(),
                        "isFile": kind.is_file(),
                        "isDirectory": kind.is_dir(),
                        "isSymbolicLink": kind.is_symlink(),
                    }));
                }
                out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
                Ok(Value::Array(out))
            }
            "rename" | "copyFile" => {
                let to = self.resolve(arg["to"].as_str().unwrap_or(""), op)?;
                if op == "rename" {
                    std::fs::rename(&path, &to).map(|_| Value::Null).map_err(err)
                } else {
                    std::fs::copy(&path, &to).map(|_| Value::Null).map_err(err)
                }
            }
            _ => Err(format!("unknown fs operation \"{op}\"")),
        }
    }
}

fn db_call(conn: &Connection, arg: &Value) -> rusqlite::Result<Value> {
    let sql = arg["sql"].as_str().unwrap_or("");
    match arg["kind"].as_str().unwrap_or("") {
        "exec" => conn.execute_batch(sql).map(|_| Value::Null),
        "prepare" => {
            let stmt = conn.prepare_cached(sql)?;
            Ok(json!({ "reader": stmt.column_count() > 0 }))
        }
        "state" => Ok(json!({ "inTransaction": !conn.is_autocommit() })),
        _ => {
            let mut stmt = conn.prepare_cached(sql)?;
            bind(&mut stmt, &arg["params"])?;
            let mode = arg["mode"].as_str().unwrap_or("all");
            if mode == "run" && stmt.column_count() == 0 {
                let changes = stmt.raw_execute()?;
                return Ok(
                    json!({ "changes": changes, "lastInsertRowid": conn.last_insert_rowid() }),
                );
            }
            let columns: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
            let width = columns.len();
            let mut rows = stmt.raw_query();
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                let mut values = Vec::with_capacity(width);
                for i in 0..width {
                    values.push(to_json(row.get_ref(i)?));
                }
                out.push(Value::Array(values));
                if mode == "get" {
                    break;
                }
            }
            drop(rows);
            if mode == "run" {
                return Ok(
                    json!({ "changes": conn.changes(), "lastInsertRowid": conn.last_insert_rowid() }),
                );
            }
            Ok(json!({ "columns": columns, "rows": out }))
        }
    }
}

fn bind(stmt: &mut Statement<'_>, params: &Value) -> rusqlite::Result<()> {
    let empty = Vec::new();
    let positional = params["positional"].as_array().unwrap_or(&empty);
    let named = params["named"].as_object();
    let mut next = 0;
    for i in 1..=stmt.parameter_count() {
        let value = match stmt.parameter_name(i) {
            Some(name) if !name.starts_with('?') => {
                let key = &name[1..];
                named.and_then(|m| m.get(key)).ok_or_else(|| {
                    rusqlite::Error::InvalidParameterName(format!(
                        "Missing named parameter \"{key}\""
                    ))
                })?
            }
            _ => {
                next += 1;
                positional.get(next - 1).ok_or(rusqlite::Error::InvalidParameterCount(
                    positional.len(),
                    stmt.parameter_count(),
                ))?
            }
        };
        stmt.raw_bind_parameter(i, to_sql(value)?)?;
    }
    if next < positional.len() {
        return Err(rusqlite::Error::InvalidParameterCount(positional.len(), next));
    }
    Ok(())
}

fn to_sql(value: &Value) -> rusqlite::Result<SqlValue> {
    let bad = || rusqlite::Error::ToSqlConversionFailure("unsupported parameter value".into());
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().ok_or_else(bad)?),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Object(o) => {
            if let Some(b) = o.get("$bigint").and_then(Value::as_str) {
                SqlValue::Integer(b.parse().map_err(|_| bad())?)
            } else if let Some(b) = o.get("$blob").and_then(Value::as_str) {
                SqlValue::Blob(B64.decode(b).map_err(|_| bad())?)
            } else {
                return Err(bad());
            }
        }
        Value::Array(_) => return Err(bad()),
    })
}

fn to_json(value: ValueRef<'_>) -> Value {
    const SAFE: i64 = (1 << 53) - 1;
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) if (-SAFE..=SAFE).contains(&i) => json!(i),
        ValueRef::Integer(i) => {
            Value::Object(Map::from_iter([("$bigint".into(), json!(i.to_string()))]))
        }
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => json!({ "$blob": B64.encode(b) }),
    }
}
