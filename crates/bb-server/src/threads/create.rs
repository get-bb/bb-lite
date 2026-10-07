//! `POST /threads`. Skeleton of `apps/server/src/threads/create.ts`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::dispatch::{DispatchArgs, OutboundMessage, SendMode, dispatch_message};
use super::engine;
use super::execution::{CreateExecutionArgs, ExecutionRequest, resolve_create_execution};
use super::mutations::double_option;
use super::provisioning::{StartupContext, derive_title_fallback};
use super::thread_display::ThreadResponse;
use crate::context::Ctx;
use crate::db::Db;
use crate::db::environments::get_environment;
use crate::db::projects::{require_project, set_project_execution_defaults};
use crate::db::thread_sections::require_thread_section;
use crate::db::threads::{self as store, MAX_THREAD_HIERARCHY_DEPTH, NewThread, ThreadRow};
use crate::domain::changes::{ProjectChangeKind, ThreadChangeKind, ThreadChangeMetadata};
use crate::domain::environment::{Environment, EnvironmentStatus};
use crate::domain::project::{Project, ProjectExecutionDefaults, ProjectKind};
use crate::domain::thread::ThreadVisibility;
use crate::environments::types::{ENVIRONMENT_PROVIDER_IDS, EnvironmentIntent};
use crate::error::{ApiError, ApiResult, invalid_request};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSubmission {
    pub plugin_id: String,
    pub data: Value,
}

/// `createThreadRequestSchema`; the `superRefine` checks are `validate`'s job.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadRequest {
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// `ThreadCreateOrigin`.
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_plugin_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_metadata: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle_owner_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility: Option<ThreadVisibility>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// `PromptInput[]`.
    pub input: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_input_sources: Option<Value>,
    /// `CreateThreadEnvironmentArgs`.
    pub environment: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub section_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    /// `StartedOnBehalfOf | null`, defaulting to null.
    #[serde(default)]
    pub started_on_behalf_of: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_submission: Option<PluginSubmission>,
}

pub(crate) fn is_plugin_id(value: &str) -> bool {
    let mut chars = value.chars();
    let valid = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    chars.next().is_some_and(valid) && chars.all(|c| valid(c) || c == '-')
}

/// Builds an `ExecutionRequest` from a request's string fields, rejecting values outside the
/// contract's enums; `permissionModeInputSchema` maps `workspace-write` to `accept-edits`.
pub(crate) fn execution_request(mut fields: Value) -> ApiResult<ExecutionRequest> {
    if fields["permissionMode"] == "workspace-write" {
        fields["permissionMode"] = json!("accept-edits");
    }
    serde_json::from_value(fields).map_err(|error| invalid_request(error.to_string()))
}

impl CreateThreadRequest {
    /// The `superRefine` checks of `createThreadRequestSchema`.
    pub fn validate(&self) -> ApiResult<()> {
        let plugin = self.origin == "plugin";
        if plugin && self.origin_plugin_id.is_none() {
            return Err(invalid_request("originPluginId is required when origin is \"plugin\""));
        }
        if !plugin && self.origin_plugin_id.is_some() {
            return Err(invalid_request("originPluginId requires origin \"plugin\""));
        }
        if self.plugin_metadata.is_some() && !plugin {
            return Err(invalid_request("pluginMetadata requires origin \"plugin\""));
        }
        if self.plugin_metadata.is_some()
            && self.origin_plugin_id.as_deref().is_some_and(|id| !is_plugin_id(id))
        {
            let message = "pluginMetadata requires originPluginId to be a valid plugin id";
            return Err(invalid_request(message));
        }
        if self.input.is_empty() {
            return Err(invalid_request("input must contain at least one entry"));
        }
        Ok(())
    }

    fn execution(&self) -> ApiResult<ExecutionRequest> {
        execution_request(json!({
            "providerId": self.provider_id,
            "model": self.model,
            "reasoningLevel": self.reasoning_level,
            "permissionMode": self.permission_mode,
            "serviceTier": self.service_tier,
            "executionInputSources": self.execution_input_sources,
        }))
    }
}

fn invalid_parent(reason: &str) -> ApiError {
    let details = json!({ "reason": reason, "subject": "parent" });
    ApiError::new(400, "parent_thread_invalid", "Parent thread is invalid").details(details)
}

pub fn require_valid_parent(
    db: &Db,
    parent_thread_id: &str,
    child: Option<&ThreadRow>,
) -> ApiResult<ThreadRow> {
    let Some(parent) = store::get_thread(db, parent_thread_id)? else {
        return Err(invalid_parent("not_found"));
    };
    if parent.archived_at.is_some() {
        return Err(invalid_parent("archived"));
    }
    if parent.deleted_at.is_some() {
        return Err(invalid_parent("deleted"));
    }
    let ancestors = store::ancestry(db, &parent)?;
    if let Some(child) = child {
        if parent.id == child.id {
            return Err(invalid_parent("self"));
        }
        if ancestors.contains(&child.id) {
            return Err(invalid_parent("cycle"));
        }
    }
    let below = match child {
        Some(child) => store::subtree_depth(db, child)?,
        None => 1,
    };
    if ancestors.len() + below > MAX_THREAD_HIERARCHY_DEPTH {
        return Err(invalid_parent("too_deep"));
    }
    Ok(parent)
}

fn default_branch() -> Option<Value> {
    Some(json!({ "branch": { "kind": "default" } }))
}

fn resolve_intent(
    ctx: &Ctx,
    args: &Value,
    project: &Project,
    shared: Option<&Environment>,
) -> ApiResult<EnvironmentIntent> {
    let primary = ctx.config.host_id.clone();
    let personal = project.kind == ProjectKind::Personal;
    let provided = |provider_id: &str, host_id: String, inputs: Option<Value>| {
        if let Some(shared) = shared.filter(|_| provider_id == "personal-workspace" && personal) {
            return EnvironmentIntent::Reuse { environment_id: shared.id.clone() };
        }
        let environment_provider_id = provider_id.to_owned();
        EnvironmentIntent::Provider { environment_provider_id, host_id, inputs }
    };
    let text = |value: &Value| value.as_str().map(str::to_owned);
    match args["type"].as_str() {
        Some("reuse") => {
            let id = args["environmentId"].as_str().unwrap_or_default();
            let environment = get_environment(&ctx.db, id)?
                .filter(|environment| environment.status != EnvironmentStatus::Destroyed);
            let Some(environment) = environment else {
                return Err(ApiError::new(404, "environment_not_found", "Environment not found"));
            };
            if environment.project_id != project.id {
                return Err(invalid_request("Environment belongs to another project."));
            }
            Ok(EnvironmentIntent::Reuse { environment_id: environment.id })
        }
        Some("provider") => {
            let provider = args["environmentProviderId"].as_str().unwrap_or_default();
            let machine = &args["machine"];
            if !ENVIRONMENT_PROVIDER_IDS.contains(&provider) || machine["type"] == "new" {
                return Err(invalid_request("unknown environment provider"));
            }
            let host_id = text(&machine["hostId"]).unwrap_or(primary);
            let inputs = args.get("inputs").cloned().filter(|inputs| !inputs.is_null());
            Ok(provided(provider, host_id, inputs))
        }
        Some("host") => {
            let host_id = text(&args["hostId"]).unwrap_or(primary);
            let workspace = &args["workspace"];
            match workspace["type"].as_str() {
                Some("personal") => return Ok(provided("personal-workspace", host_id, None)),
                Some("managed-worktree") => {
                    let inputs = json!({ "branch": workspace["baseBranch"] });
                    return Ok(provided("git-worktree", host_id, Some(inputs)));
                }
                _ => {}
            }
            if let Some(path) = workspace["path"].as_str() {
                let mut inputs = json!({ "path": path });
                if let Some(branch) = workspace.get("branch") {
                    inputs["branch"] = branch.clone();
                }
                return Ok(provided("project-checkout", host_id, Some(inputs)));
            }
            if personal {
                return Ok(provided("personal-workspace", host_id, None));
            }
            if shared.is_some() {
                return Ok(provided("git-worktree", host_id, default_branch()));
            }
            Ok(provided("project-checkout", host_id, None))
        }
        Some("project-default") => {
            if personal {
                return Ok(provided("personal-workspace", primary, None));
            }
            if let Some(shared) = shared {
                return Ok(provided("git-worktree", shared.host_id.clone(), default_branch()));
            }
            Ok(EnvironmentIntent::ProjectDefault { host_id: primary })
        }
        _ => Err(invalid_request("unknown environment type")),
    }
}

fn intent_host_id(db: &Db, intent: &EnvironmentIntent) -> ApiResult<String> {
    match intent {
        EnvironmentIntent::Reuse { environment_id } => match get_environment(db, environment_id)? {
            Some(environment) => Ok(environment.host_id),
            None => Err(ApiError::internal("Environment disappeared")),
        },
        EnvironmentIntent::Provider { host_id, .. }
        | EnvironmentIntent::ProjectDefault { host_id } => Ok(host_id.clone()),
    }
}

pub async fn create_thread(ctx: &Ctx, request: CreateThreadRequest) -> ApiResult<ThreadResponse> {
    request.validate()?;
    let db = &ctx.db;
    let project_id = request.project_id.clone();
    let project = require_project(db, &project_id)?;
    let section_id = request.section_id.clone().flatten();
    if let Some(section_id) = &section_id {
        require_thread_section(db, section_id)?;
    }
    let parent = match &request.parent_thread_id {
        Some(parent_id) => Some(require_valid_parent(db, parent_id, None)?),
        None => None,
    };
    let shared = match parent.as_ref().filter(|parent| parent.project_id == project_id) {
        Some(ThreadRow { thread, .. }) => match &thread.environment_id {
            Some(environment_id) => get_environment(db, environment_id)?,
            None => None,
        },
        None => None,
    };
    let intent = resolve_intent(ctx, &request.environment, &project, shared.as_ref())?;
    let host_id = intent_host_id(db, &intent)?;
    let execution_request = request.execution()?;
    let created = resolve_create_execution(
        ctx,
        CreateExecutionArgs {
            request: &execution_request,
            project_id: &project_id,
            host_id: &host_id,
            parent: parent.as_ref(),
        },
    )
    .await?;
    let provider_id = created.provider_id.as_str().to_owned();
    let execution = created.execution;
    let startup = StartupContext {
        intent: serde_json::to_value(&intent)?,
        title_provided: request.title.is_some(),
    };
    let thread = engine::commit(ctx, |out| {
        let row = store::insert_thread(
            db,
            NewThread {
                project_id: project_id.clone(),
                provider_id: provider_id.clone(),
                model: Some(execution.model.clone()),
                reasoning_level: Some(execution.reasoning_level.as_str().to_owned()),
                permission_mode: Some(execution.permission_mode.as_str().to_owned()),
                service_tier: Some(execution.service_tier.as_str().to_owned()),
                title: request.title.clone(),
                title_fallback: derive_title_fallback(&request.input),
                section_id: section_id.clone(),
                startup_context: Some(serde_json::to_string(&startup)?),
                parent_thread_id: parent.as_ref().map(|parent| parent.id.clone()),
                lifecycle_owner_thread_id: request.lifecycle_owner_thread_id.clone(),
                origin_plugin_id: request.origin_plugin_id.clone(),
                visibility: request
                    .visibility
                    .or(parent.as_ref().map(|parent| parent.visibility))
                    .unwrap_or(ThreadVisibility::Visible),
                pinned: request.pinned == Some(true),
            },
        )?;
        let metadata = project_metadata(&project_id);
        out.thread(&row.id, vec![ThreadChangeKind::ThreadCreated], Some(metadata));
        out.project(&project_id, vec![ProjectChangeKind::ThreadsChanged]);
        let response = engine::respond(ctx, &row.id)?;
        let task_ctx = ctx.clone();
        out.after(move || {
            task_ctx.plugins.emit("thread.created", json!({ "thread": response }));
        });
        Ok(row)
    })?;
    let args = DispatchArgs {
        message: OutboundMessage {
            input: request.input.clone(),
            execution: execution.clone(),
            sender_thread_id: None,
            initiator: "user".to_owned(),
            system_notice: None,
        },
        mode: SendMode::Start,
        send_at: request.send_at,
        rows: Vec::new(),
        send_now: false,
    };
    let (task_ctx, thread_id) = (ctx.clone(), thread.id.clone());
    let dispatched = engine::in_thread(ctx, &thread.id, async move {
        dispatch_message(&task_ctx, &thread_id, args).await
    })
    .await;
    if let Err(error) = dispatched {
        store::delete_thread_row(db, &thread.id)?;
        let metadata = project_metadata(&project_id);
        ctx.hub.thread(&thread.id, vec![ThreadChangeKind::ThreadDeleted], Some(metadata));
        return Err(error);
    }
    if request.origin == "app" && request.environment["type"] != "reuse" {
        let defaults = ProjectExecutionDefaults {
            provider_id,
            model: execution.model,
            service_tier: execution.service_tier,
            reasoning_level: execution.reasoning_level,
            permission_mode: execution.permission_mode,
        };
        set_project_execution_defaults(db, &project_id, &defaults)?;
    }
    engine::respond(ctx, &thread.id)
}

pub(crate) fn project_metadata(project_id: &str) -> ThreadChangeMetadata {
    ThreadChangeMetadata { project_id: Some(project_id.to_owned()), ..Default::default() }
}
