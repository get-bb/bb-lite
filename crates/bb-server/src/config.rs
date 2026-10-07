//! Where the server keeps its data and how it listens, from the environment.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::db::{OpenError, new_id, refuse_legacy_database};
use crate::log::LogLevel;

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub data_dir: PathBuf,
    pub port: u16,
    pub bind_host: String,
    pub allowed_hosts: Vec<String>,
    /// The built web app (`apps/app/dist`).
    pub app_dir: PathBuf,
    /// The CLI package root: `<cli_dir>/skills` is offered to local sessions.
    pub cli_dir: PathBuf,
    /// The `bb` executable agents on this machine are given.
    pub bb_cli_path: PathBuf,
    pub version: String,
    pub host_id: String,
    pub log_level: LogLevel,
}

pub type ServerEnv = HashMap<String, String>;

const DEFAULT_PORT: u16 = 48886;
const DEFAULT_BIND_HOST: &str = "127.0.0.1";
const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Open(#[from] OpenError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub fn loopback_url(config: &ServerConfig) -> String {
    let host = if config.bind_host == "0.0.0.0" { "127.0.0.1" } else { &config.bind_host };
    format!("http://{host}:{}", config.port)
}

#[derive(Clone, Debug)]
pub struct DataPaths {
    pub database: PathBuf,
    pub attachments: PathBuf,
    pub thread_storage: PathBuf,
    pub worktrees: PathBuf,
    pub plugins: PathBuf,
    pub logs: PathBuf,
    pub agents_file: PathBuf,
    pub config_file: PathBuf,
    pub connect_file: PathBuf,
    pub host_id_file: PathBuf,
}

pub fn data_paths(data_dir: &Path) -> DataPaths {
    DataPaths {
        database: data_dir.join("bb.db"),
        attachments: data_dir.join("attachments"),
        thread_storage: data_dir.join("thread-storage"),
        worktrees: data_dir.join("worktrees"),
        plugins: data_dir.join("plugins"),
        logs: data_dir.join("logs"),
        agents_file: data_dir.join("AGENTS.md"),
        config_file: data_dir.join("config.json"),
        connect_file: data_dir.join("connect.json"),
        host_id_file: data_dir.join("host-id"),
    }
}

fn prepare_data_dir(data_dir: &Path) -> Result<String, ConfigError> {
    let paths = data_paths(data_dir);
    refuse_legacy_database(&paths.database)?;
    for directory in
        [&paths.attachments, &paths.thread_storage, &paths.worktrees, &paths.plugins, &paths.logs]
    {
        std::fs::create_dir_all(directory)?;
    }
    if !paths.host_id_file.exists() {
        let created =
            std::fs::OpenOptions::new().write(true).create_new(true).open(&paths.host_id_file);
        match created {
            Ok(mut file) => {
                use std::io::Write;
                writeln!(file, "{}", new_id("host"))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    let host_id = std::fs::read_to_string(&paths.host_id_file)?.trim().to_owned();
    if host_id.is_empty() {
        return Err(ConfigError::Invalid(format!("{} is empty", paths.host_id_file.display())));
    }
    Ok(host_id)
}

fn read_version() -> String {
    let manifest = std::fs::read_to_string(Path::new(REPO_ROOT).join("package.json")).ok();
    let parsed = manifest.and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let version = parsed.and_then(|json| json.get("version")?.as_str().map(str::to_owned));
    version.unwrap_or_else(|| "0.0.0".to_owned())
}

fn hostnames(list: &str) -> Vec<String> {
    list.split(',').map(|name| name.trim().to_lowercase()).filter(|name| !name.is_empty()).collect()
}

fn absolute(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    let joined = match std::env::current_dir() {
        Ok(cwd) if path.is_relative() => cwd.join(path),
        _ => path,
    };
    bb_core::exec::normalize(&joined)
}

fn non_empty<'a>(env: &'a ServerEnv, key: &str) -> Result<Option<&'a str>, ConfigError> {
    match env.get(key).map(String::as_str) {
        Some("") => Err(ConfigError::Invalid(format!("{key} must not be empty"))),
        other => Ok(other),
    }
}

pub fn process_env() -> ServerEnv {
    std::env::vars().collect()
}

pub fn load_config(env: &ServerEnv) -> Result<ServerConfig, ConfigError> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_owned());
    let data_dir = match non_empty(env, "BB_DATA_DIR")? {
        Some(dir) => absolute(dir),
        None => Path::new(&home).join(".bb-150k"),
    };
    let port = match env.get("BB_SERVER_PORT") {
        None => DEFAULT_PORT,
        Some(text) => text
            .trim()
            .parse::<u16>()
            .map_err(|_| ConfigError::Invalid("BB_SERVER_PORT must be a port number".to_owned()))?,
    };
    let log_level = match env.get("BB_LOG_LEVEL") {
        None => LogLevel::Info,
        Some(text) => LogLevel::parse(text).ok_or_else(|| {
            ConfigError::Invalid(
                "BB_LOG_LEVEL must be debug, info, warn, error or silent".to_owned(),
            )
        })?,
    };
    let app_dir = match non_empty(env, "BB_APP_DIR")? {
        Some(dir) => absolute(dir),
        None => bb_core::exec::normalize(&Path::new(REPO_ROOT).join("apps/app/dist")),
    };
    let cli_dir = bb_core::exec::normalize(&Path::new(REPO_ROOT).join("apps/cli"));
    let bb_cli_path = match non_empty(env, "BB_CLI_PATH")? {
        Some(path) => absolute(path),
        None => std::env::current_exe().unwrap_or_else(|_| cli_dir.join("bin/bb")),
    };
    let host_id = prepare_data_dir(&data_dir)?;
    Ok(ServerConfig {
        data_dir,
        port,
        bind_host: non_empty(env, "BB_SERVER_BIND_HOST")?.unwrap_or(DEFAULT_BIND_HOST).to_owned(),
        allowed_hosts: hostnames(env.get("BB_SERVER_ALLOWED_HOSTS").map_or("", String::as_str)),
        app_dir,
        cli_dir,
        bb_cli_path,
        version: read_version(),
        host_id,
        log_level,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_defaults_and_keeps_the_host_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = ServerEnv::new();
        env.insert("BB_DATA_DIR".into(), dir.path().display().to_string());
        env.insert("BB_SERVER_PORT".into(), "0".into());
        env.insert("BB_SERVER_ALLOWED_HOSTS".into(), " Bee.ts.net ,, box ".into());
        let first = load_config(&env).unwrap();
        assert_eq!(first.port, 0);
        assert_eq!(first.bind_host, "127.0.0.1");
        assert_eq!(first.allowed_hosts, ["bee.ts.net", "box"]);
        assert!(first.host_id.starts_with("host_"));
        assert!(dir.path().join("thread-storage").is_dir());
        assert_eq!(load_config(&env).unwrap().host_id, first.host_id);
        env.insert("BB_SERVER_PORT".into(), "70000".into());
        assert!(load_config(&env).is_err());
    }
}
