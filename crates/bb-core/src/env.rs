use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::OnceCell;

pub type EnvMap = IndexMap<String, String>;

/// Resolves the environment child processes start with. Called per spawn.
pub type ChildEnv = Arc<dyn Fn() -> BoxFuture<'static, EnvMap> + Send + Sync>;

const START: &str = "__BB_SHELL_ENV_START__";
const END: &str = "__BB_SHELL_ENV_END__";
const PROBE_TIMEOUT: Duration = Duration::from_millis(3_000);

pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        _ => "linux",
    }
}

pub fn process_env() -> EnvMap {
    std::env::vars_os()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
        .collect()
}

pub fn scrub_env(env: &EnvMap) -> EnvMap {
    env.iter()
        .filter(|(key, _)| key.as_str() != "NODE_ENV" && !key.starts_with("BB_"))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

pub fn parse_shell_path(stdout: &str) -> Option<String> {
    let lines: Vec<&str> = stdout.lines().map(str::trim).collect();
    let start = lines.iter().position(|line| *line == START)?;
    let end = start + 1 + lines[start + 1..].iter().position(|line| *line == END)?;
    let entry = lines[start + 1..end].iter().find(|line| line.starts_with("PATH="))?;
    let path = &entry["PATH=".len()..];
    (!path.is_empty()).then(|| path.to_owned())
}

async fn probe_shell(shell: &str, flag: &str, env: &EnvMap) -> Option<String> {
    let probe = format!("printf '%s\\n' {START}; env; printf '%s\\n' {END}");
    let mut command = Command::new(shell);
    command.arg(flag).arg(probe).env_clear().envs(env).kill_on_drop(true);
    command.stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output()).await.ok()?.ok()?;
    if !output.status.success() {
        return None;
    }
    parse_shell_path(&String::from_utf8_lossy(&output.stdout))
}

async fn resolve_login_shell_path() -> Option<String> {
    if node_platform() == "win32" {
        return None;
    }
    let fallback = if node_platform() == "darwin" { "/bin/zsh" } else { "/bin/sh" };
    let configured = std::env::var("SHELL").ok().map(|shell| shell.trim().to_owned());
    let shell = configured.filter(|shell| !shell.is_empty()).unwrap_or_else(|| fallback.to_owned());
    let name = Path::new(&shell).file_name().and_then(|name| name.to_str()).unwrap_or("");
    let flags: &[&str] = if matches!(name, "sh" | "dash") { &["-lc"] } else { &["-ilc", "-lc"] };
    let env = scrub_env(&process_env());
    for flag in flags {
        if let Some(path) = probe_shell(&shell, flag, &env).await {
            return Some(path);
        }
    }
    None
}

static LOGIN_PATH: OnceCell<Option<String>> = OnceCell::const_new();

pub async fn login_shell_path() -> Option<String> {
    LOGIN_PATH.get_or_init(resolve_login_shell_path).await.clone()
}

/// The scrubbed process environment with the login shell's `PATH`, `extra`
/// on top, and `bin` (when not empty) first on `PATH`.
pub fn login_shell_env(extra: EnvMap, bin: String) -> ChildEnv {
    Arc::new(move || {
        let extra = extra.clone();
        let bin = bin.clone();
        Box::pin(async move {
            let mut env = scrub_env(&process_env());
            let inherited = match login_shell_path().await {
                Some(path) => path,
                None => env.get("PATH").cloned().unwrap_or_default(),
            };
            env.extend(extra);
            let path = if bin.is_empty() { inherited } else { format!("{bin}:{inherited}") };
            env.insert("PATH".to_owned(), path);
            env
        })
    })
}

pub fn fixed_env(env: EnvMap) -> ChildEnv {
    Arc::new(move || {
        let env = env.clone();
        Box::pin(async move { env })
    })
}

fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    let first = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    first && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub struct AgentEnvArgs<'a> {
    pub login_path: Option<&'a str>,
    pub bb_cli_path: &'a str,
    pub server_url: &'a str,
    pub thread_storage_dir: &'a str,
    pub spec_env: &'a EnvMap,
    pub base_env: Option<&'a EnvMap>,
}

pub struct AgentEnv {
    /// What the agent session is told its environment is.
    pub agent: EnvMap,
    /// What the provider process starts with.
    pub process: EnvMap,
    /// The `provider.env-resolved` entries.
    pub entries: Vec<Value>,
}

pub fn build_agent_env(args: AgentEnvArgs<'_>) -> AgentEnv {
    let inherited_process = process_env();
    let base = scrub_env(args.base_env.unwrap_or(&inherited_process));
    let inherited = args.login_path.map(str::to_owned).or_else(|| base.get("PATH").cloned());
    let bb_dir = Path::new(args.bb_cli_path).parent().map(|dir| dir.to_string_lossy().into_owned());
    let bb_dir = bb_dir.filter(|dir| !dir.is_empty()).unwrap_or_else(|| ".".to_owned());
    let path = match inherited.filter(|path| !path.is_empty()) {
        Some(inherited) => format!("{bb_dir}:{inherited}"),
        None => bb_dir,
    };
    let mut own = EnvMap::new();
    own.insert("PATH".to_owned(), path.clone());
    own.insert("BB_CLI".to_owned(), args.bb_cli_path.to_owned());
    own.insert("BB_SERVER_URL".to_owned(), args.server_url.to_owned());
    own.insert("BB_THREAD_STORAGE".to_owned(), args.thread_storage_dir.to_owned());
    let mut agent = own.clone();
    for (name, value) in args.spec_env {
        if is_env_name(name) {
            agent.insert(name.clone(), value.clone());
        }
    }
    let entries = agent
        .iter()
        .map(|(name, value)| {
            if own.contains_key(name) || name.starts_with("BB_") {
                json!({"name": name, "source": "shell", "value": value})
            } else {
                json!({
                    "name": name,
                    "source": {"core": "machine-environment"},
                    "value": {"masked": true},
                })
            }
        })
        .collect();
    let mut process = base;
    process.insert("PATH".to_owned(), path);
    AgentEnv { agent, process, entries }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_path_between_markers() {
        let stdout = format!("noise\n{START}\nHOME=/h\nPATH=/a:/b\n{END}\n");
        assert_eq!(parse_shell_path(&stdout).as_deref(), Some("/a:/b"));
        assert_eq!(parse_shell_path("PATH=/a"), None);
    }

    #[test]
    fn agent_env_masks_contributed_values() {
        let mut spec_env = EnvMap::new();
        spec_env.insert("BB_THREAD_ID".into(), "thr_1".into());
        spec_env.insert("SECRET_TOKEN".into(), "s3cret".into());
        spec_env.insert("bad name".into(), "x".into());
        let mut base = EnvMap::new();
        base.insert("PATH".into(), "/usr/bin".into());
        base.insert("NODE_ENV".into(), "test".into());
        base.insert("BB_OLD".into(), "1".into());
        let built = build_agent_env(AgentEnvArgs {
            login_path: None,
            bb_cli_path: "/opt/bb/bin/bb",
            server_url: "http://127.0.0.1:1",
            thread_storage_dir: "/data/thread-storage/thr_1",
            spec_env: &spec_env,
            base_env: Some(&base),
        });
        assert_eq!(built.agent["PATH"], "/opt/bb/bin:/usr/bin");
        assert_eq!(built.process["PATH"], "/opt/bb/bin:/usr/bin");
        assert!(!built.process.contains_key("NODE_ENV"));
        assert!(!built.process.contains_key("BB_OLD"));
        assert!(!built.agent.contains_key("bad name"));
        let secret = built.entries.iter().find(|entry| entry["name"] == "SECRET_TOKEN").unwrap();
        assert_eq!(secret["value"], json!({"masked": true}));
        let thread = built.entries.iter().find(|entry| entry["name"] == "BB_THREAD_ID").unwrap();
        assert_eq!(thread["value"], "thr_1");
    }
}
