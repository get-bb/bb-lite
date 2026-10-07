use serde_json::{Value, json};

use crate::context::Ctx;
use crate::db::projects::{require_project, with_sources};
use crate::domain::environment::EnvironmentStatus;
use crate::environments::workspace::require_environment;
use crate::error::{ApiError, ApiResult};
use crate::runners::hosts::require_host;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProjectWorkspaceSelector {
    pub host_id: Option<String>,
    pub environment_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectWorkspace {
    pub host_id: String,
    pub path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequiredProjectWorkspace {
    pub host_id: String,
    pub path: String,
}

/// The machine's `PathInspection` for `path`, or `None` when the machine is offline or the
/// inspection fails.
pub async fn inspect_project_path(ctx: &Ctx, host_id: &str, path: &str) -> Option<Value> {
    if !ctx.runners.is_connected(host_id) {
        return None;
    }
    let runner = ctx.runners.get(host_id).ok()?;
    runner.call("inspectPath", json!({ "path": path })).await.ok()
}

pub fn find_project_workspace(
    ctx: &Ctx,
    project_id: &str,
    selector: &ProjectWorkspaceSelector,
) -> ApiResult<ProjectWorkspace> {
    let project = require_project(&ctx.db, project_id)?;
    let sources = with_sources(&ctx.db, vec![project])?
        .into_iter()
        .next()
        .map(|response| response.sources)
        .unwrap_or_default();
    let source_on = |host_id: &str| sources.iter().find(|source| source.host_id == host_id);
    if let Some(environment_id) = &selector.environment_id {
        let environment = require_environment(ctx, environment_id)?;
        if environment.project_id != project_id {
            return Err(ApiError::new(404, "environment_not_found", "Environment not found"));
        }
        let host_id = environment.host_id;
        let workspace =
            if environment.status == EnvironmentStatus::Ready { environment.path } else { None };
        let path = workspace.or_else(|| source_on(&host_id).map(|source| source.path.clone()));
        return Ok(ProjectWorkspace { host_id, path });
    }
    if let Some(host_id) = &selector.host_id {
        let host_id = require_host(ctx, host_id)?.id;
        let path = source_on(&host_id).map(|source| source.path.clone());
        return Ok(ProjectWorkspace { host_id, path });
    }
    let local = &ctx.config.host_id;
    let source = source_on(local).or_else(|| sources.iter().find(|source| source.is_default));
    Ok(ProjectWorkspace {
        host_id: source.map_or_else(|| local.clone(), |source| source.host_id.clone()),
        path: source.map(|source| source.path.clone()),
    })
}

pub fn require_project_workspace(
    ctx: &Ctx,
    project_id: &str,
    selector: &ProjectWorkspaceSelector,
) -> ApiResult<RequiredProjectWorkspace> {
    let ProjectWorkspace { host_id, path } = find_project_workspace(ctx, project_id, selector)?;
    match path {
        Some(path) => Ok(RequiredProjectWorkspace { host_id, path }),
        None => {
            let status = if selector.host_id.is_none() { 409 } else { 404 };
            let message = "Project has no checkout on this machine";
            Err(ApiError::new(status, "invalid_request", message))
        }
    }
}
