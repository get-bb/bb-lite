use std::path::{Path, PathBuf};
use std::process::Stdio;

use bb_core::exec::{Ctx, require_absolute};
use bb_core::{RunnerErrorCode, RunnerResult, fail};
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::is_executable;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpenTargetKind {
    Editor,
    FileManager,
    Terminal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTargetCapabilities {
    pub open_directory: bool,
    pub open_file: bool,
    pub open_file_at_line: bool,
    pub open_file_at_column: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenTarget {
    pub id: String,
    pub label: String,
    pub kind: OpenTargetKind,
    pub capabilities: OpenTargetCapabilities,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenTargets {
    pub targets: Vec<OpenTarget>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInTargetArgs {
    pub target_id: String,
    pub path: String,
    pub line: Option<u64>,
    pub column: Option<u64>,
}

enum Launch {
    Args(Vec<String>),
    Cwd(String),
}

#[derive(Clone, Copy)]
enum Style {
    Goto,
    Zed,
    FileManager,
    Terminal,
}

struct Target {
    id: &'static str,
    label: &'static str,
    kind: OpenTargetKind,
    executables: &'static [&'static str],
    style: Style,
}

const MAC: bool = cfg!(target_os = "macos");

const TARGETS: [Target; 5] = [
    Target {
        id: "vscode",
        label: "VS Code",
        kind: OpenTargetKind::Editor,
        executables: &["code"],
        style: Style::Goto,
    },
    Target {
        id: "cursor",
        label: "Cursor",
        kind: OpenTargetKind::Editor,
        executables: &["cursor"],
        style: Style::Goto,
    },
    Target {
        id: "zed",
        label: "Zed",
        kind: OpenTargetKind::Editor,
        executables: &["zed"],
        style: Style::Zed,
    },
    Target {
        id: "file-manager",
        label: if MAC { "Finder" } else { "File Manager" },
        kind: OpenTargetKind::FileManager,
        executables: if MAC { &["open"] } else { &["xdg-open"] },
        style: Style::FileManager,
    },
    Target {
        id: "terminal",
        label: "Terminal",
        kind: OpenTargetKind::Terminal,
        executables: if MAC {
            &["open"]
        } else {
            &["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]
        },
        style: Style::Terminal,
    },
];

fn position(request: &OpenInTargetArgs) -> String {
    let suffix = request.column.map(|column| format!(":{column}")).unwrap_or_default();
    match request.line {
        None => request.path.clone(),
        Some(line) => format!("{}:{line}{suffix}", request.path),
    }
}

fn launch(style: Style, request: &OpenInTargetArgs, directory: &str) -> Launch {
    match style {
        Style::Goto if request.line.is_none() => Launch::Args(vec![request.path.clone()]),
        Style::Goto => Launch::Args(vec!["-g".into(), position(request)]),
        Style::Zed => Launch::Args(vec![position(request)]),
        Style::FileManager => Launch::Args(vec![directory.to_owned()]),
        Style::Terminal if MAC => {
            Launch::Args(vec!["-a".into(), "Terminal".into(), directory.to_owned()])
        }
        Style::Terminal => Launch::Cwd(directory.to_owned()),
    }
}

fn find_executable(names: &[&str], search_path: &str) -> Option<PathBuf> {
    let directories: Vec<&str> = search_path.split(':').filter(|dir| !dir.is_empty()).collect();
    names.iter().find_map(|name| {
        directories.iter().map(|dir| Path::new(dir).join(name)).find(|path| is_executable(path))
    })
}

pub async fn list_open_targets(ctx: &Ctx) -> RunnerResult<OpenTargets> {
    let search_path = (ctx.env)().await.get("PATH").cloned().unwrap_or_default();
    let targets = TARGETS
        .iter()
        .filter(|target| find_executable(target.executables, &search_path).is_some())
        .map(|target| {
            let editor = target.kind == OpenTargetKind::Editor;
            OpenTarget {
                id: target.id.to_owned(),
                label: target.label.to_owned(),
                kind: target.kind,
                capabilities: OpenTargetCapabilities {
                    open_directory: true,
                    open_file: target.kind != OpenTargetKind::Terminal,
                    open_file_at_line: editor,
                    open_file_at_column: editor,
                },
            }
        })
        .collect();
    Ok(OpenTargets { targets })
}

pub async fn open_in_target(ctx: &Ctx, request: OpenInTargetArgs) -> RunnerResult<()> {
    let env = (ctx.env)().await;
    let target = TARGETS.iter().find(|target| target.id == request.target_id);
    let search_path = env.get("PATH").map(String::as_str).unwrap_or_default();
    let found = target.and_then(|target| {
        find_executable(target.executables, search_path).map(|file| (target, file))
    });
    let Some((target, file)) = found else {
        let message = format!("Open target is unavailable: {}", request.target_id);
        return fail(RunnerErrorCode::Unavailable, message);
    };
    let stat = tokio::fs::metadata(require_absolute(&request.path, "Path")?).await?;
    let directory = if stat.is_dir() {
        request.path.clone()
    } else {
        Path::new(&request.path)
            .parent()
            .map_or_else(|| request.path.clone(), |parent| parent.display().to_string())
    };
    let mut command = Command::new(file);
    match launch(target.style, &request, &directory) {
        Launch::Args(args) => command.args(args),
        Launch::Cwd(cwd) => command.current_dir(cwd),
    };
    command
        .process_group(0)
        .env_clear()
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}
