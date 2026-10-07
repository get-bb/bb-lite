//! Bundles an external plugin's app and server entries with the `esbuild` binary.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use sha2::{Digest, Sha256};

use super::api::{PluginError, PluginResult};

pub const PLUGIN_RUNTIME_GLOBAL: &str = "__bbPluginRuntime";

pub const PLUGIN_SHARED_MODULES: [&str; 15] = [
    "react",
    "react-dom",
    "react-dom/client",
    "react/jsx-runtime",
    "@bb/plugin/app",
    "sonner",
    "clsx",
    "tailwind-merge",
    "class-variance-authority",
    "@base-ui/react/context-menu",
    "@base-ui/react/dialog",
    "@base-ui/react/menu",
    "@base-ui/react/popover",
    "@base-ui/react/select",
    "@base-ui/react/tooltip",
];

const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

#[derive(Clone, Debug, PartialEq)]
pub struct AppBundle {
    pub js: String,
    pub css: Option<String>,
    pub hash: String,
}

fn repo_root() -> PathBuf {
    PathBuf::from(REPO_ROOT)
}

/// `BB_ESBUILD_PATH`, else the repository's `node_modules/.bin/esbuild`.
pub fn esbuild_path() -> PathBuf {
    match std::env::var_os("BB_ESBUILD_PATH") {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => repo_root().join("node_modules/.bin/esbuild"),
    }
}

pub fn content_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    hex::encode(digest)[..16].to_owned()
}

pub fn shared_module_source(specifier: &str) -> String {
    let key = serde_json::to_string(specifier).unwrap_or_default();
    [
        format!("const shared = globalThis.{PLUGIN_RUNTIME_GLOBAL}[{key}];"),
        "const main = shared.default;".to_owned(),
        "const base = typeof main === \"function\" ? (...args) => main(...args) : {};".to_owned(),
        "module.exports = main == null ? shared : Object.assign(base, main, shared);".to_owned(),
    ]
    .join("\n")
}

fn io_error(context: &str, error: std::io::Error) -> PluginError {
    PluginError::new(format!("{context}: {error}"))
}

fn common_args(entry: &Path) -> Vec<String> {
    let plugin_package = repo_root().join("packages/plugin/src/index.ts");
    vec![
        entry.to_string_lossy().into_owned(),
        "--bundle".to_owned(),
        "--log-level=error".to_owned(),
        format!("--alias:@bb/plugin={}", plugin_package.display()),
    ]
}

async fn run_esbuild(args: Vec<String>) -> PluginResult<String> {
    let binary = esbuild_path();
    if !binary.exists() {
        return Err(PluginError::new(format!(
            "esbuild was not found at {}; set BB_ESBUILD_PATH to bundle external plugins",
            binary.display()
        )));
    }
    let root = repo_root();
    let node_path =
        std::env::join_paths([root.join("apps/server/node_modules"), root.join("node_modules")])
            .map_err(|error| PluginError::new(error.to_string()))?;
    let output = tokio::process::Command::new(&binary)
        .args(&args)
        .env("NODE_PATH", node_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|error| io_error("esbuild could not start", error))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(PluginError::new(format!("Build failed: {stderr}")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Bundles a server entry to one ES module, writes it to `<cache_dir>/server.<hash>.mjs` and
/// returns the source.
pub async fn bundle_server_entry(entry: &Path, cache_dir: &Path) -> PluginResult<String> {
    let mut args = common_args(entry);
    args.extend([
        "--platform=node".to_owned(),
        "--format=esm".to_owned(),
        "--target=es2022".to_owned(),
        "--external:better-sqlite3".to_owned(),
    ]);
    let code = run_esbuild(args).await?;
    let file = cache_dir.join(format!("server.{}.mjs", content_hash(&code)));
    tokio::fs::create_dir_all(cache_dir)
        .await
        .map_err(|error| io_error("Cannot create the plugin cache", error))?;
    tokio::fs::write(&file, &code)
        .await
        .map_err(|error| io_error("Cannot write the plugin bundle", error))?;
    Ok(code)
}

fn shim_file_name(specifier: &str) -> String {
    let safe: String = specifier
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    format!("{safe}.cjs")
}

/// Bundles an app entry; the shared modules resolve to shims over `globalThis.__bbPluginRuntime`.
pub async fn bundle_app(entry: &Path, cache_dir: &Path) -> PluginResult<AppBundle> {
    let nonce: u64 = rand::random();
    let work = cache_dir.join(format!(".app-build-{nonce:016x}"));
    let shims = work.join("shared");
    let out = work.join("out");
    tokio::fs::create_dir_all(&shims)
        .await
        .map_err(|error| io_error("Cannot create the plugin cache", error))?;
    let result = async {
        let mut args = common_args(entry);
        for specifier in PLUGIN_SHARED_MODULES {
            let shim = shims.join(shim_file_name(specifier));
            tokio::fs::write(&shim, shared_module_source(specifier))
                .await
                .map_err(|error| io_error("Cannot write a shared module shim", error))?;
            args.push(format!("--alias:{specifier}={}", shim.display()));
        }
        args.extend([
            format!("--outdir={}", out.display()),
            "--entry-names=app".to_owned(),
            "--platform=browser".to_owned(),
            "--format=esm".to_owned(),
            "--target=es2022".to_owned(),
            "--jsx=automatic".to_owned(),
            "--define:process.env.NODE_ENV=\"production\"".to_owned(),
        ]);
        run_esbuild(args).await?;
        let js = tokio::fs::read_to_string(out.join("app.js")).await.unwrap_or_default();
        let css = tokio::fs::read_to_string(out.join("app.css")).await.ok();
        let hash = content_hash(&format!("{js}{}", css.as_deref().unwrap_or("")));
        Ok(AppBundle { js, css, hash })
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&work).await;
    result
}
