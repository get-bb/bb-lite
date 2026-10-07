//! The environment providers offered for a project and machine, with the JSON Schema of their
//! inputs (`environment-providers.ts`).

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::context::Ctx;
use crate::db::hosts::{HostFilter, list_hosts};
use crate::db::projects::{SourceSelector, get_project_source, require_project};
use crate::domain::project::ProjectKind;
use crate::error::ApiResult;
use crate::projects::workspace::inspect_project_path;

/// `z.toJSONSchema(checkoutInputsSchema, { io: "input" })`.
pub const CHECKOUT_INPUTS_JSON_SCHEMA: &str = r#"{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"path":{"type":"string","minLength":1},"branch":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"existing"},"name":{"type":"string","minLength":1}},"required":["kind","name"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"new"},"baseBranch":{"type":"string","minLength":1}},"required":["kind","baseBranch"],"additionalProperties":false}]}}}"#;

/// `z.toJSONSchema(worktreeInputsSchema, { io: "input" })`.
pub const WORKTREE_INPUTS_JSON_SCHEMA: &str = r#"{"$schema":"https://json-schema.org/draft/2020-12/schema","default":{"branch":{"kind":"default"}},"anyOf":[{"type":"object","properties":{"kind":{"type":"string","const":"existing"},"path":{"type":"string","minLength":1}},"required":["kind","path"],"additionalProperties":false},{"type":"object","properties":{"branch":{"default":{"kind":"default"},"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"named"},"name":{"type":"string","minLength":1}},"required":["kind","name"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"default"}},"required":["kind"],"additionalProperties":false}]}},"additionalProperties":false}]}"#;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemEnvironmentProvidersQuery {
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub host_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentProviderRequirements {
    pub project_checkout: bool,
    pub git_checkout: bool,
    pub git_remote: bool,
    pub projectless: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemEnvironmentProvider {
    pub machine_provider_id: Option<String>,
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub icon: String,
    pub requires: EnvironmentProviderRequirements,
    pub inputs: Option<Value>,
    pub logo_url: Option<String>,
    pub plugin_id: String,
    pub accepts_empty_inputs: bool,
    /// `null`, `{ status: "available" }` or `{ status: "unavailable", message }`.
    pub availability: Value,
    pub machine_availability: Map<String, Value>,
}

struct Definition {
    id: &'static str,
    display_name: &'static str,
    description: &'static str,
    icon: &'static str,
    requires: EnvironmentProviderRequirements,
    inputs: Option<Value>,
}

fn schema(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

static ENVIRONMENT_PROVIDERS: LazyLock<Vec<Definition>> = LazyLock::new(|| {
    let none = EnvironmentProviderRequirements::default();
    vec![
        Definition {
            id: "project-checkout",
            display_name: "Project checkout",
            description: "Work in a project checkout on this machine.",
            icon: "Laptop",
            requires: EnvironmentProviderRequirements { project_checkout: true, ..none },
            inputs: schema(CHECKOUT_INPUTS_JSON_SCHEMA),
        },
        Definition {
            id: "git-worktree",
            display_name: "Worktree",
            description: "Create an isolated Git worktree for your changes.",
            icon: "FolderGit",
            requires: EnvironmentProviderRequirements {
                project_checkout: true,
                git_checkout: true,
                ..none
            },
            inputs: schema(WORKTREE_INPUTS_JSON_SCHEMA),
        },
        Definition {
            id: "personal-workspace",
            display_name: "Personal workspace",
            description: "Create a personal directory without a project.",
            icon: "Folder",
            requires: EnvironmentProviderRequirements { projectless: true, ..none },
            inputs: None,
        },
    ]
});

async fn git_checkout_availability(ctx: &Ctx, host_id: &str, path: &str) -> Value {
    let Some(inspection) = inspect_project_path(ctx, host_id, path).await else {
        return Value::Null;
    };
    if inspection.get("isGitRepo") == Some(&Value::Bool(true)) {
        return json!({ "status": "available" });
    }
    let message = "This project checkout has no usable git branch.";
    json!({ "status": "unavailable", "message": message })
}

async fn machine_availability(
    ctx: &Ctx,
    definition: &Definition,
    project_id: &str,
    only: Option<&str>,
) -> ApiResult<Map<String, Value>> {
    let hosts = list_hosts(&ctx.db, HostFilter { include_creating: false, host_type: None })?;
    let mut available = Map::new();
    for host in hosts {
        if only.is_some_and(|only| only != host.id) {
            continue;
        }
        let source = get_project_source(&ctx.db, project_id, SourceSelector::HostId(&host.id))?;
        let requires = definition.requires;
        if requires.project_checkout && source.is_none() {
            continue;
        }
        let availability = match source {
            Some(source) if requires.git_checkout => {
                git_checkout_availability(ctx, &host.id, &source.path).await
            }
            _ => Value::Null,
        };
        available.insert(host.id, availability);
    }
    Ok(available)
}

pub async fn list_environment_providers(
    ctx: &Ctx,
    query: SystemEnvironmentProvidersQuery,
) -> ApiResult<Vec<SystemEnvironmentProvider>> {
    let host_id = query.host_id.as_deref();
    let project = match &query.project_id {
        None => None,
        Some(id) => Some(require_project(&ctx.db, id)?),
    };
    let mut providers = Vec::new();
    for definition in ENVIRONMENT_PROVIDERS.iter() {
        let personal =
            project.as_ref().is_some_and(|project| project.kind == ProjectKind::Personal);
        if project.is_some() && definition.requires.projectless != personal {
            continue;
        }
        let machines = match &project {
            None => Map::new(),
            Some(project) => machine_availability(ctx, definition, &project.id, host_id).await?,
        };
        if project.is_some() && machines.is_empty() {
            continue;
        }
        let availability = host_id.and_then(|id| machines.get(id)).cloned().unwrap_or(Value::Null);
        providers.push(SystemEnvironmentProvider {
            machine_provider_id: None,
            id: definition.id.to_owned(),
            display_name: definition.display_name.to_owned(),
            description: definition.description.to_owned(),
            icon: definition.icon.to_owned(),
            requires: definition.requires,
            inputs: definition.inputs.clone(),
            logo_url: None,
            plugin_id: format!("environment-{}", definition.id),
            accepts_empty_inputs: true,
            availability,
            machine_availability: machines,
        });
    }
    Ok(providers)
}
