use bb_core::{PermissionMode as P, ReasoningLevel as R, ServiceTier as T};
use bb_server::db::projects::set_project_execution_defaults;
use bb_server::db::settings::{get_app_settings, set_app_settings};
use bb_server::db::threads::{ThreadRow, get_thread};
use bb_server::db::{Db, OnConflict, RowValues, insert_row};
use bb_server::domain::project::ProjectExecutionDefaults;
use bb_server::row;
use bb_server::threads::execution::{
    ExecutionRequest, ExecutionTuple, find_turn_execution, recorded_execution, require_provider_id,
    resolve_turn_execution,
};
use serde_json::json;

fn open(ceiling: &str) -> Db {
    let db = Db::open_in_memory(None).unwrap();
    let at = |values: RowValues| values.set("createdAt", 1).set("updatedAt", 1);
    let host = row! { "id" => "host_1", "name" => "bee", "maxPermissionMode" => ceiling };
    insert_row(&db, "hosts", &at(host), OnConflict::Fail).unwrap();
    let project = row! { "id" => "proj_demo", "name" => "demo" };
    insert_row(&db, "projects", &at(project), OnConflict::Fail).unwrap();
    let env = row! {
        "id" => "env_demo", "projectId" => "proj_demo", "hostId" => "host_1",
        "path" => "/work/demo", "status" => "ready",
    };
    insert_row(&db, "environments", &at(env), OnConflict::Fail).unwrap();
    db
}

fn seed(db: &Db, id: &str, extra: RowValues) -> ThreadRow {
    let mut values = row! {
        "id" => id, "projectId" => "proj_demo", "environmentId" => "env_demo",
        "providerId" => "codex", "status" => "idle",
        "latestAttentionAt" => 5, "createdAt" => 1, "updatedAt" => 1,
    };
    for key in extra.keys() {
        values.put(key, extra.get(key).unwrap().clone());
    }
    insert_row(db, "threads", &values, OnConflict::Fail).unwrap();
    get_thread(db, id).unwrap().unwrap()
}

fn request(value: serde_json::Value) -> ExecutionRequest {
    serde_json::from_value(value).unwrap()
}

fn tuple(model: &str, reasoning_level: R, permission_mode: P, service_tier: T) -> ExecutionTuple {
    ExecutionTuple { model: model.into(), reasoning_level, permission_mode, service_tier }
}

#[test]
fn falls_back_to_defaults() {
    let db = open("full");
    let thread = seed(&db, "thr_a", row! { "model" => "gpt" });
    let found = resolve_turn_execution(&db, &thread, &ExecutionRequest::default()).unwrap();
    assert_eq!(found, tuple("gpt", R::Medium, P::Auto, T::Default));
}

#[test]
fn clamps_permission_mode_to_the_host_ceiling() {
    let db = open("auto");
    let thread = seed(&db, "thr_a", row! { "model" => "gpt", "permissionMode" => "full" });
    let found = resolve_turn_execution(&db, &thread, &ExecutionRequest::default()).unwrap();
    assert_eq!(found.permission_mode, P::Auto);
    let asked = request(json!({ "permissionMode": "accept-edits" }));
    let found = resolve_turn_execution(&db, &thread, &asked).unwrap();
    assert_eq!(found.permission_mode, P::AcceptEdits);

    let db = open("accept-edits");
    let thread = seed(&db, "thr_a", row! { "model" => "gpt" });
    let found = resolve_turn_execution(&db, &thread, &ExecutionRequest::default()).unwrap();
    assert_eq!(found.permission_mode, P::AcceptEdits);
}

#[test]
fn input_sources_limit_which_request_fields_apply() {
    let db = open("full");
    let thread = seed(
        &db,
        "thr_a",
        row! { "model" => "gpt", "reasoningLevel" => "low", "serviceTier" => "default" },
    );
    let all = request(json!({ "model": "opus", "reasoningLevel": "high", "serviceTier": "fast" }));
    let found = resolve_turn_execution(&db, &thread, &all).unwrap();
    assert_eq!(found, tuple("opus", R::High, P::Auto, T::Fast));

    let named = request(json!({
        "model": "opus", "reasoningLevel": "high", "serviceTier": "fast",
        "executionInputSources": { "reasoningLevel": "client-preference", "model": "explicit" },
    }));
    let found = resolve_turn_execution(&db, &thread, &named).unwrap();
    assert_eq!(found, tuple("opus", R::High, P::Auto, T::Default));

    let none = request(json!({ "model": "opus", "executionInputSources": {} }));
    assert_eq!(resolve_turn_execution(&db, &thread, &none).unwrap().model, "gpt");
    let empty = request(json!({ "model": "" }));
    assert_eq!(resolve_turn_execution(&db, &thread, &empty).unwrap().model, "gpt");
}

#[test]
fn overrides_parent_and_project_defaults_layer_in_order() {
    let db = open("full");
    let defaults = ProjectExecutionDefaults {
        provider_id: "codex".into(),
        model: "default-model".into(),
        service_tier: T::Fast,
        reasoning_level: R::Xhigh,
        permission_mode: P::AcceptEdits,
    };
    set_project_execution_defaults(&db, "proj_demo", &defaults).unwrap();
    let bare = seed(&db, "thr_bare", RowValues::new());
    let found = resolve_turn_execution(&db, &bare, &ExecutionRequest::default()).unwrap();
    assert_eq!(found, tuple("default-model", R::Xhigh, P::AcceptEdits, T::Fast));

    let other = seed(&db, "thr_claude", row! { "providerId" => "claude-code" });
    assert_eq!(find_turn_execution(&db, &other, &ExecutionRequest::default()).unwrap(), None);
    let error = resolve_turn_execution(&db, &other, &ExecutionRequest::default()).unwrap_err();
    assert_eq!((error.status, error.body.code.as_str()), (500, "internal_error"));
    assert_eq!(error.body.message, "Thread thr_claude has no stored execution model");

    seed(&db, "thr_parent", row! { "permissionMode" => "full" });
    let child = seed(
        &db,
        "thr_child",
        row! {
            "parentThreadId" => "thr_parent", "model" => "gpt", "modelOverride" => "override",
            "reasoningLevelOverride" => "max", "reasoningLevel" => "low",
        },
    );
    let found = resolve_turn_execution(&db, &child, &ExecutionRequest::default()).unwrap();
    assert_eq!(found, tuple("override", R::Max, P::Full, T::Fast));

    seed(&db, "thr_gone", row! { "permissionMode" => "full", "archivedAt" => 9 });
    let orphan = seed(&db, "thr_orphan", row! { "parentThreadId" => "thr_gone" });
    let found = resolve_turn_execution(&db, &orphan, &ExecutionRequest::default()).unwrap();
    assert_eq!(found.permission_mode, P::AcceptEdits);
}

#[test]
fn fast_tier_requires_the_setting() {
    let db = open("full");
    let mut settings = get_app_settings(&db).unwrap();
    settings.allow_fast_service_tier = false;
    set_app_settings(&db, &settings).unwrap();
    let thread = seed(&db, "thr_a", row! { "model" => "gpt", "serviceTier" => "fast" });
    let found = resolve_turn_execution(&db, &thread, &ExecutionRequest::default()).unwrap();
    assert_eq!(found.service_tier, T::Default);
}

#[test]
fn provider_ids_and_recorded_execution() {
    assert_eq!(require_provider_id("echo").unwrap(), bb_core::ProviderId::Echo);
    let error = require_provider_id("gemini").unwrap_err();
    assert_eq!(error.status, 400);
    assert_eq!(error.body.message, "Unknown provider \"gemini\". Use codex, claude-code, echo.");
    let recorded = recorded_execution(tuple("gpt", R::Low, P::Full, T::Fast));
    assert_eq!(
        serde_json::to_value(recorded).unwrap(),
        json!({
            "model": "gpt", "reasoningLevel": "low", "permissionMode": "full",
            "serviceTier": "fast", "source": "client/turn/requested",
        })
    );
}
