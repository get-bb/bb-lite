use bb_core::{SERVER_URL_PLACEHOLDER, SessionSpec};
use indexmap::IndexMap;
use std::path::Path;

use crate::config::data_paths;
use crate::context::Ctx;
use crate::db::Db;
use crate::db::threads::ThreadRow;
use crate::environments::manager::workspace_instructions;
use crate::error::ApiResult;
use crate::machine_environment::resolve_contributed_environment;
use crate::plugins::api::{EnvValue, ThreadContext};
use crate::providers::catalog::find_provider_definition;
use crate::threads::execution::require_provider_id;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionEnvironment {
    pub id: String,
    pub host_id: String,
    pub path: String,
}

const BB_INTRODUCTION: &str = "You are working inside bb, an agentic IDE for managing coding agents in projects, threads, and environments. The `bb` CLI is available when you need BB context or orchestration.

- Prefer bare `bb` on PATH. When `BB_CLI` is set, official `bb` entrypoints re-exec to that absolute binary; you can also invoke `\"$BB_CLI\"` directly.
- Run `bb status` to see the current project, thread, and environment.
- Run `bb guide` for BB concepts and `bb guide <chapter>` for command details.
- Use `bb thread ...` to inspect or wait for other BB threads. Do not spawn new threads or message other threads unless the user has explicitly asked you to do so.
- Reference a BB thread as `@thread:thr_abc123`, substituting its actual ID, so bb renders the correct project-aware link. Do not construct thread URLs manually.
- Use Markdown links for files, artifacts, and URLs you want the user to open; bb is a visual IDE and renders them as clickable links.";

async fn read_user_instructions(data_dir: &Path) -> Option<String> {
    let text = tokio::fs::read_to_string(data_paths(data_dir).agents_file).await.ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

pub fn plugin_context(db: &Db, thread: &ThreadRow, host_id: Option<&str>) -> ThreadContext {
    let provider = find_provider_definition(db, &thread.provider_id);
    ThreadContext {
        thread_id: thread.id.clone(),
        project_id: thread.project_id.clone(),
        host_id: host_id.map(str::to_string),
        provider_id: thread.provider_id.clone(),
        provider_capabilities: provider.map(|provider| provider.info.capabilities),
    }
}

pub async fn build_session_spec(
    ctx: &Ctx,
    thread: &ThreadRow,
    environment: &SessionEnvironment,
) -> ApiResult<SessionSpec> {
    let host_id = environment.host_id.as_str();
    let scope = plugin_context(&ctx.db, thread, Some(host_id));
    let provider_id = require_provider_id(&thread.provider_id)?;
    let (plugins, plugin_env, machine_env, user, workspace) = tokio::join!(
        ctx.plugins.instructions_for(&scope),
        ctx.plugins.contributed_env(provider_id.as_str(), &scope),
        resolve_contributed_environment(ctx, Some(&thread.project_id)),
        read_user_instructions(&ctx.config.data_dir),
        workspace_instructions(ctx, &environment.id),
    );
    let mut sections = vec![BB_INTRODUCTION.to_string()];
    if !plugins.is_empty() {
        sections.push("The following instructions come from BB plugins:".to_string());
        sections.push(plugins);
    }
    if let Some(user) = user {
        let origin = "<dataDir>/AGENTS.md";
        sections.push(format!("The following user instructions come from {origin}:"));
        sections.push(user);
    }
    if let Some(workspace) = workspace {
        let origin = ".bb/AGENTS.md";
        sections.push(format!("The following workspace instructions come from {origin}:"));
        sections.push(workspace);
    }
    let mut env: IndexMap<String, String> = machine_env?.into_iter().collect();
    for entry in plugin_env {
        let value = match entry.value {
            EnvValue::Literal(value) => value,
            EnvValue::ServerPath { server_path } => {
                format!("{SERVER_URL_PLACEHOLDER}{server_path}")
            }
        };
        env.insert(entry.name, value);
    }
    env.insert("BB_THREAD_ID".to_string(), thread.id.clone());
    env.insert("BB_PROJECT_ID".to_string(), thread.project_id.clone());
    env.insert("BB_ENVIRONMENT_ID".to_string(), environment.id.clone());
    let skill_dirs = if host_id == ctx.config.host_id {
        let bundled = ctx.config.cli_dir.join("skills").to_string_lossy().into_owned();
        std::iter::once(bundled).chain(ctx.plugins.skill_dirs()).collect()
    } else {
        Vec::new()
    };
    Ok(SessionSpec {
        thread_id: thread.id.clone(),
        provider_id,
        cwd: environment.path.clone(),
        provider_thread_id: thread.provider_thread_id.clone(),
        instructions: sections.join("\n\n"),
        dynamic_tools: ctx.plugins.tools_for(&scope).await,
        env,
        skill_dirs,
    })
}
