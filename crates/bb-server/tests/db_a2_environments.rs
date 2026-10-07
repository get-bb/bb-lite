use std::sync::Arc;

use bb_server::db::environments::*;
use bb_server::db::projects::ensure_personal_project;
use bb_server::db::{Db, params};
use bb_server::domain::environment::{
    EnvironmentHostLifecycle, EnvironmentLifecyclePhase, EnvironmentMachineSelection,
    EnvironmentStatus, TeardownStatus, WorkspaceProvisionType,
};
use bb_server::domain::project::PERSONAL_PROJECT_ID;
use serde_json::json;

fn open() -> Db {
    let db = Db::open_in_memory(Some(Arc::new(|| 1_000))).unwrap();
    ensure_personal_project(&db).unwrap();
    db.run("INSERT INTO hosts (id, name, created_at, updated_at) VALUES ('host_a', 'a', 1, 1)", [])
        .unwrap();
    db
}

fn add_thread(db: &Db, id: &str, environment_id: Option<&str>, status: &str, archived: bool) {
    let sql = "INSERT INTO threads (id, project_id, environment_id, provider_id, status,
      archived_at, latest_attention_at, created_at, updated_at)
      VALUES (?, ?, ?, 'echo', ?, ?, 1, 1, 1)";
    let archived_at = archived.then_some(5_i64);
    db.run(sql, params![id, PERSONAL_PROJECT_ID, environment_id, status, archived_at]).unwrap();
}

fn insert(db: &Db, provider: &str, path: &str, owner: Option<&str>) -> String {
    let input = NewEnvironment {
        project_id: PERSONAL_PROJECT_ID.into(),
        host_id: "host_a".into(),
        path: Some(path.into()),
        environment_provider_id: provider.into(),
        owner_thread_id: owner.map(Into::into),
        instance_key: Some(format!("key:{path}")),
    };
    insert_environment(db, &input).unwrap()
}

#[test]
fn inserts_managed_and_unmanaged_environments() {
    let db = open();
    let managed = insert(&db, "git-worktree", "/w/1", Some("thr_owner"));
    let checkout = insert(&db, "project-checkout", "/repo", None);
    let worktree = get_environment(&db, &managed).unwrap().unwrap();
    assert_eq!(worktree.status, EnvironmentStatus::Creating);
    assert!(worktree.managed && worktree.is_git_repo && worktree.is_worktree);
    assert_eq!(worktree.workspace_provision_type, Some(WorkspaceProvisionType::ManagedWorktree));
    assert_eq!(worktree.host_lifecycle, EnvironmentHostLifecycle::Active);
    let json = serde_json::to_string(&worktree).unwrap();
    let expected = json!({
        "id": managed, "name": null, "projectId": PERSONAL_PROJECT_ID, "hostId": "host_a",
        "path": "/w/1", "isGitRepo": true, "isWorktree": true, "branchName": null,
        "baseBranch": null, "defaultBranch": null, "mergeBaseBranch": null,
        "status": "creating", "environmentProviderId": "git-worktree",
        "lifecycle": { "phase": "active", "retireAt": null, "teardown": null },
        "hostLifecycle": "active", "environmentProviderSelection": null,
        "environmentProviderInstanceKey": "key:/w/1", "managed": true,
        "workspaceProvisionType": "managed-worktree", "createdAt": 1000, "updatedAt": 1000,
    });
    assert_eq!(json, serde_json::to_string(&expected).unwrap());
    let plain = get_environment(&db, &checkout).unwrap().unwrap();
    assert_eq!(plain.status, EnvironmentStatus::Provisioning);
    assert!(!plain.managed && !plain.is_git_repo);
    assert_eq!(plain.workspace_provision_type, Some(WorkspaceProvisionType::Unmanaged));
    assert_eq!(get_environment(&db, "env_missing").unwrap(), None);
    let found = find_environment(&db, "e.path = ? AND hosts.id = ?", ["/repo", "host_a"]);
    assert_eq!(found.unwrap().unwrap().id, checkout);
}

#[test]
fn records_retirement_teardown_and_destruction() {
    let db = open();
    let id = insert(&db, "git-worktree", "/w/1", Some("thr_owner"));
    let lifecycle = |db: &Db| get_environment(db, &id).unwrap().unwrap().lifecycle;
    let retire = EnvironmentPatch { retire_at: Some(Some(500)), ..Default::default() };
    assert!(update_environment(&db, &id, &retire).unwrap());
    let retiring = lifecycle(&db);
    assert_eq!(
        (retiring.phase, retiring.retire_at),
        (EnvironmentLifecyclePhase::Retiring, Some(500))
    );

    let teardown = EnvironmentPatch {
        teardown_status: Some(Some(TeardownStatus::Running)),
        teardown_attempt: Some(1),
        ..Default::default()
    };
    update_environment(&db, &id, &teardown).unwrap();
    let running = serde_json::to_value(lifecycle(&db)).unwrap();
    let expected = json!({
        "phase": "teardown", "retireAt": 500,
        "teardown": { "status": "running", "attempt": 1 },
    });
    assert_eq!(running, expected);
    let failed = EnvironmentPatch {
        teardown_status: Some(Some(TeardownStatus::Failed)),
        teardown_message: Some(Some("rm failed".into())),
        ..Default::default()
    };
    update_environment(&db, &id, &failed).unwrap();
    let teardown = lifecycle(&db).teardown.unwrap();
    assert_eq!(teardown.message.as_deref(), Some("rm failed"));

    let cancel = EnvironmentPatch {
        retire_at: Some(None),
        teardown_status: Some(None),
        teardown_message: Some(None),
        ..Default::default()
    };
    update_environment(&db, &id, &cancel).unwrap();
    assert_eq!(lifecycle(&db).phase, EnvironmentLifecyclePhase::Active);
    assert_eq!(list_retirable_environment_ids(&db).unwrap(), std::slice::from_ref(&id));

    let destroyed = EnvironmentPatch {
        status: Some(EnvironmentStatus::Destroyed),
        status_message: Some(Some("gone".into())),
        ..Default::default()
    };
    update_environment(&db, &id, &destroyed).unwrap();
    assert_eq!(lifecycle(&db).phase, EnvironmentLifecyclePhase::Destroyed);
    assert!(list_retirable_environment_ids(&db).unwrap().is_empty());
    assert!(list_environments(&db, &EnvironmentFilter::default()).unwrap().is_empty());
    let filter =
        EnvironmentFilter { status: Some(EnvironmentStatus::Destroyed), ..Default::default() };
    assert_eq!(list_environments(&db, &filter).unwrap().len(), 1);
    assert!(!update_environment(&db, "env_missing", &EnvironmentPatch::default()).unwrap());
}

#[test]
fn filters_and_pages_environments() {
    let db = open();
    let first = insert(&db, "git-worktree", "/w/1", Some("thr_1"));
    let second = insert(&db, "project-checkout", "/repo", None);
    let ids = |filter: EnvironmentFilter| -> Vec<String> {
        list_environments(&db, &filter).unwrap().into_iter().map(|env| env.id).collect()
    };
    let mut all = vec![first.clone(), second.clone()];
    all.sort();
    assert_eq!(ids(EnvironmentFilter::default()), all);
    let by_provider = EnvironmentFilter {
        environment_provider_id: Some("project-checkout".into()),
        ..Default::default()
    };
    assert_eq!(ids(by_provider), std::slice::from_ref(&second));
    let by_key = EnvironmentFilter { instance_key: Some("key:/w/1".into()), ..Default::default() };
    assert_eq!(ids(by_key), std::slice::from_ref(&first));
    let page = EnvironmentFilter { limit: Some(1), offset: Some(1), ..Default::default() };
    assert_eq!(ids(page), [all[1].clone()]);
}

#[test]
fn reports_host_lifecycle_and_decodes_provider_selection() {
    let db = open();
    let id = insert(&db, "git-worktree", "/w/1", None);
    let selection =
        r#"{"machine":{"type":"new","machineProviderId":"modal","inputs":null},"inputs":{"a":1}}"#;
    let set = "UPDATE environments SET environment_provider_selection = ? WHERE id = ?";
    db.run(set, [selection, id.as_str()]).unwrap();
    db.run("UPDATE hosts SET phase = 'removing'", []).unwrap();
    let env = get_environment(&db, &id).unwrap().unwrap();
    assert_eq!(env.host_lifecycle, EnvironmentHostLifecycle::Removing);
    let decoded = env.environment_provider_selection.unwrap();
    let machine =
        EnvironmentMachineSelection::New { machine_provider_id: "modal".into(), inputs: None };
    assert_eq!(decoded.machine, machine);
    assert_eq!(decoded.inputs, Some(json!({ "a": 1 })));
    db.run("UPDATE hosts SET destroyed_at = 9", []).unwrap();
    let env = get_environment(&db, &id).unwrap().unwrap();
    assert_eq!(env.host_lifecycle, EnvironmentHostLifecycle::Removed);
    db.run(set, [r#"{"machine":{"type":"existing","hostId":""},"inputs":null}"#, &id]).unwrap();
    assert!(get_environment(&db, &id).is_err());
}

#[test]
fn counts_threads_using_an_environment() {
    let db = open();
    let id = insert(&db, "git-worktree", "/w/1", Some("thr_owner"));
    assert_eq!(environment_use(&db, &id).unwrap(), EnvironmentUse { attached: 0, live: 0 });
    add_thread(&db, "thr_owner", None, "idle", false);
    add_thread(&db, "thr_a", Some(&id), "active", false);
    add_thread(&db, "thr_b", Some(&id), "idle", true);
    assert_eq!(environment_use(&db, &id).unwrap(), EnvironmentUse { attached: 3, live: 2 });
    let attached = list_environment_thread_ids(&db, &id, EnvironmentThreadScope::Attached);
    assert_eq!(attached.unwrap(), ["thr_a", "thr_b"]);
    let live = list_environment_thread_ids(&db, &id, EnvironmentThreadScope::Unarchived);
    assert_eq!(live.unwrap(), ["thr_a"]);
    assert!(has_other_live_thread(&db, &id, "thr_x").unwrap());
    assert!(!has_other_live_thread(&db, &id, "thr_a").unwrap());
    assert_eq!(environment_use(&db, "env_missing").unwrap(), EnvironmentUse::default());
}
