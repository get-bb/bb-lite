use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::call::{Call, CliError, CliResult, Handler, Output, usage_error};

/// The long-running commands: the only ones that start an async runtime.
pub fn handlers() -> Vec<(&'static str, Handler)> {
    vec![("server", server), ("runnerJoin", runner_join), ("runnerRun", runner_run)]
}

fn runtime() -> CliResult<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| CliError::new(error.to_string()))
}

fn failed(error: anyhow::Error) -> CliError {
    CliError::new(format!("{error:#}"))
}

async fn termination() -> std::io::Result<()> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    tokio::select! {
        _ = interrupt.recv() => {}
        _ = terminate.recv() => {}
    }
    Ok(())
}

fn current_exe() -> CliResult<PathBuf> {
    std::env::current_exe().map_err(|error| CliError::new(error.to_string()))
}

fn server(_call: &mut Call) -> CliResult<Output> {
    let mut env = bb_server::config::process_env();
    env.insert("BB_CLI_PATH".into(), current_exe()?.display().to_string());
    let runtime = runtime()?;
    let result: anyhow::Result<()> = runtime.block_on(async move {
        let server = bb_server::start::start_server(bb_server::start::StartServerOptions {
            env,
            cli_dir: None,
        })
        .await?;
        let waited = termination().await;
        server.shutdown().await;
        Ok(waited?)
    });
    if let Err(error) = result {
        let legacy = error.chain().find_map(|cause| {
            use bb_server::db::{LegacyDataDirectoryError, OpenError};
            match cause.downcast_ref::<OpenError>() {
                Some(OpenError::Legacy(legacy)) => Some(legacy),
                _ => cause.downcast_ref::<LegacyDataDirectoryError>(),
            }
        });
        match legacy {
            Some(legacy) => eprintln!("{legacy}"),
            None => eprintln!("{error:?}"),
        }
        std::process::exit(1);
    }
    std::process::exit(0);
}

fn base64url_lenient(text: &str) -> Vec<u8> {
    let mut bits = 0u32;
    let mut count = 0u32;
    let mut out = Vec::new();
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(value);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    out
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn is_url(value: &str) -> bool {
    let Some((scheme, rest)) = value.split_once(':') else { return false };
    let mut chars = scheme.chars();
    let scheme_ok = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c));
    scheme_ok && !rest.is_empty() && !value.contains(char::is_whitespace)
}

/// The `{serverUrl}` a join blob carries, checked as `z.object({serverUrl: z.url()})`.
pub fn join_target(blob: &str) -> CliResult<String> {
    let decoded = String::from_utf8_lossy(&base64url_lenient(blob)).into_owned();
    let value = serde_json::from_str(&decoded).unwrap_or(Value::String(decoded));
    let invalid = |path: &str, message: String| {
        let where_ = if path.is_empty() { String::new() } else { format!(" ({path})") };
        usage_error(format!("Invalid join command{where_}: {message}"))
    };
    let Value::Object(object) = &value else {
        return Err(invalid(
            "",
            format!("Invalid input: expected object, received {}", kind(&value)),
        ));
    };
    match object.get("serverUrl") {
        Some(Value::String(url)) if is_url(url) => Ok(url.clone()),
        Some(Value::String(_)) => Err(invalid("serverUrl", "Invalid URL".into())),
        other => {
            let received = other.map_or("undefined", kind);
            Err(invalid(
                "serverUrl",
                format!("Invalid input: expected string, received {received}"),
            ))
        }
    }
}

fn runner_join(call: &mut Call) -> CliResult<Output> {
    let blob = call.arg("blob")?.to_owned();
    let target = join_target(&blob)?;
    let legacy_machine_config_path = if call.on("reuse-connect-credential")? {
        match call.flag("reuse-connect-credential")? {
            Some(path) => Some(PathBuf::from(path)),
            None => Some(
                bb_remote::daemon::default_legacy_machine_config_path(&target).map_err(failed)?,
            ),
        }
    } else {
        None
    };
    let options = bb_remote::daemon::JoinOptions {
        blob,
        data_dir: call.flag("data-dir")?.map(PathBuf::from),
        host_name: call.flag("name")?,
        headers: call.list("header")?,
        legacy_machine_config_path,
    };
    let (credentials, data_dir) =
        runtime()?.block_on(bb_remote::daemon::join_server(options)).map_err(failed)?;
    let shown = data_dir.display().to_string();
    let data = json!({
        "hostId": credentials.host_id,
        "serverUrl": credentials.server_url,
        "dataDir": shown,
    });
    let lines = [
        format!("Joined {} as {}.", credentials.server_url, credentials.host_id),
        format!("Start the runner with: bb runner run --data-dir {shown}"),
    ];
    Ok(Output::lines(data, &lines))
}

fn joined_dirs(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut names: Vec<String> =
        entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

fn runner_run(call: &mut Call) -> CliResult<Output> {
    let default = bb_remote::daemon::default_runner_data_dir("http://localhost").map_err(failed)?;
    let root = default.parent().map(Path::to_path_buf).unwrap_or_default();
    let joined = joined_dirs(&root);
    let data_dir = match (call.flag("data-dir")?, joined.as_slice()) {
        (Some(dir), _) => PathBuf::from(dir),
        (None, [only]) => root.join(only),
        (None, _) => {
            let found: Vec<String> =
                joined.iter().map(|name| root.join(name).display().to_string()).collect();
            let found = if found.is_empty() { "none".to_owned() } else { found.join(", ") };
            return Err(usage_error("This machine has not joined exactly one server.")
                .hint(format!("Pass --data-dir <dir>. Joined: {found}")));
        }
    };
    let credentials = data_dir.join("runner.json");
    if !credentials.exists() {
        let shown = credentials.display();
        return Err(CliError::new(format!("ENOENT: no such file or directory, open '{shown}'")));
    }
    let dev = std::env::var("BB_DEV_PROVIDERS").unwrap_or_default();
    let dev: Vec<&str> = dev.split(',').collect();
    let adapters = bb_runner::default_adapters()
        .into_iter()
        .filter(|adapter| adapter.id().as_str() != "echo" || dev.contains(&"echo"))
        .collect();
    let bb_cli_path = current_exe()?.display().to_string();
    let options = bb_remote::daemon::RunOptions {
        data_dir: data_dir.clone(),
        make_local: bb_runner::local_factory(bb_cli_path, adapters),
        log: None,
    };
    runtime()?.block_on(async move {
        let running = bb_remote::daemon::run_runner(options).await.map_err(failed)?;
        eprintln!("bb runner started (data in {})", data_dir.display());
        tokio::select! {
            () = running.stopped() => {}
            _ = termination() => running.stop().await,
        }
        Ok::<(), CliError>(())
    })?;
    Ok(Output::Done)
}
