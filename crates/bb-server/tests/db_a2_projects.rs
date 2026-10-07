use std::sync::Arc;

use bb_server::db::projects::*;
use bb_server::db::{Db, params};
use bb_server::domain::project::{PERSONAL_PROJECT_ID, ProjectExecutionDefaults, ProjectKind};
use bb_server::error::ApiError;
use serde_json::json;

fn open() -> Db {
    let db = Db::open_in_memory(Some(Arc::new(|| 1_000))).unwrap();
    add_host(&db, "host_a");
    db
}

fn add_host(db: &Db, id: &str) {
    let sql = "INSERT INTO hosts (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)";
    db.run(sql, [id, id]).unwrap();
}

fn add_thread(db: &Db, id: &str, project_id: &str) {
    let sql = "INSERT INTO threads (id, project_id, provider_id, latest_attention_at,
      created_at, updated_at) VALUES (?, ?, 'echo', 1, 1, 1)";
    db.run(sql, [id, project_id]).unwrap();
}

fn create(db: &Db, name: &str, path: &str) -> FoundProject {
    let source = LocalPathSource { host_id: "host_a".into(), path: path.into() };
    let input = NewProject { name: name.into(), source, git_remote_url: None };
    find_or_create_project(db, &input).unwrap()
}

fn status(error: ApiError) -> (u16, String, String) {
    (error.status, error.body.code, error.body.message)
}

#[test]
fn finds_or_creates_projects_by_host_and_path_in_creation_order() {
    let db = open();
    let alpha = create(&db, "alpha", "/repos/alpha");
    assert!(alpha.created);
    let again = create(&db, "again", "/repos/alpha");
    assert_eq!(again, FoundProject { project_id: alpha.project_id.clone(), created: false });
    create(&db, "beta", "/repos/beta");
    let listed = list_standard_projects(&db).unwrap();
    let names: Vec<&str> = listed.iter().map(|project| project.name.as_str()).collect();
    assert_eq!(names, ["alpha", "beta"]);
    let sort_keys: Vec<String> = db
        .all::<serde_json::Value>("SELECT sort_key FROM projects ORDER BY sort_key", [])
        .unwrap()
        .into_iter()
        .map(|row| row["sortKey"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(sort_keys, ["U", "j"]);
    let responses = with_sources(&db, listed).unwrap();
    let first = serde_json::to_value(&responses[0]).unwrap();
    let source_id = first["sources"][0]["id"].clone();
    let expected = json!({
        "id": alpha.project_id, "kind": "standard", "name": "alpha", "gitRemoteUrl": null,
        "createdAt": 1000, "updatedAt": 1000,
        "sources": [{
            "id": source_id, "projectId": alpha.project_id, "type": "local_path",
            "hostId": "host_a", "path": "/repos/alpha", "isDefault": true,
            "createdAt": 1000, "updatedAt": 1000,
        }],
    });
    assert_eq!(serde_json::to_string(&first).unwrap(), serde_json::to_string(&expected).unwrap());
    assert_eq!(responses[1].sources.len(), 1);
}

#[test]
fn protects_the_personal_project_and_deletes_others_entirely() {
    let db = open();
    ensure_personal_project(&db).unwrap();
    ensure_personal_project(&db).unwrap();
    let personal = require_project(&db, PERSONAL_PROJECT_ID).unwrap();
    assert_eq!((personal.kind, personal.name.as_str()), (ProjectKind::Personal, "Personal"));
    let refused = require_standard_project(&db, PERSONAL_PROJECT_ID).unwrap_err();
    let not_found = (404, "project_not_found".to_owned(), "Project not found".to_owned());
    assert_eq!(status(refused), not_found);
    assert_eq!(status(require_project(&db, "proj_missing").unwrap_err()), not_found);
    assert!(list_standard_projects(&db).unwrap().is_empty());

    let alpha = create(&db, "alpha", "/repos/alpha");
    add_thread(&db, "thr_1", &alpha.project_id);
    let env = "INSERT INTO environments (id, project_id, host_id, path, provider_owns_path,
      created_at, updated_at) VALUES ('env_1', ?, 'host_a', '/w', 1, 1, 1)";
    db.run(env, [&alpha.project_id]).unwrap();
    let deleted = delete_project(&db, &alpha.project_id).unwrap();
    assert_eq!(deleted.thread_ids, ["thr_1"]);
    let environment = DeletedEnvironment {
        id: "env_1".into(),
        host_id: "host_a".into(),
        path: Some("/w".into()),
        provider_owns_path: 1,
    };
    assert_eq!(deleted.environments, [environment]);
    let rows = "SELECT id FROM threads UNION SELECT id FROM project_sources";
    assert!(db.rows(rows, []).unwrap().is_empty());
    assert!(require_project(&db, PERSONAL_PROJECT_ID).is_ok());
}

#[test]
fn keeps_one_source_per_machine_and_always_a_default() {
    let db = open();
    add_host(&db, "host_b");
    let project = create(&db, "alpha", "/repos/alpha").project_id;
    let on_b = LocalPathSource { host_id: "host_b".into(), path: "/srv/a".into() };
    let remote = add_project_source(&db, &project, &on_b).unwrap();
    assert_eq!((remote.host_id.as_str(), remote.is_default), ("host_b", false));
    let duplicate = add_project_source(&db, &project, &on_b).unwrap_err();
    let message = "Project already has a source on this host".to_owned();
    assert_eq!(status(duplicate), (409, "project_source_host_conflict".into(), message));

    let patch = ProjectSourcePatch { path: Some("/b".into()), is_default: true };
    update_project_source(&db, &remote, &patch).unwrap();
    let promoted =
        get_project_source(&db, &project, SourceSelector::Id(&remote.id)).unwrap().unwrap();
    assert_eq!((promoted.path.as_str(), promoted.is_default), ("/b", true));
    let local =
        get_project_source(&db, &project, SourceSelector::HostId("host_a")).unwrap().unwrap();
    assert!(!local.is_default);

    delete_project_source(&db, &promoted).unwrap();
    let kept =
        get_project_source(&db, &project, SourceSelector::HostId("host_a")).unwrap().unwrap();
    assert!(kept.is_default);
    let last = delete_project_source(&db, &kept).unwrap_err();
    let message = "Cannot delete the last source of a project".to_owned();
    assert_eq!(status(last), (409, "invalid_request".into(), message));
}

#[test]
fn first_source_of_an_empty_project_is_the_default() {
    let db = open();
    ensure_personal_project(&db).unwrap();
    let source = LocalPathSource { host_id: "host_a".into(), path: "/home/me".into() };
    let added = add_project_source(&db, PERSONAL_PROJECT_ID, &source).unwrap();
    assert!(added.is_default);
}

#[test]
fn reads_and_writes_execution_defaults_leniently() {
    let db = open();
    let project = create(&db, "alpha", "/repos/alpha").project_id;
    assert_eq!(get_project_execution_defaults(&db, &project).unwrap(), None);
    assert_eq!(get_project_execution_defaults(&db, "proj_missing").unwrap(), None);
    let defaults: ProjectExecutionDefaults = serde_json::from_value(json!({
        "providerId": "codex", "model": "gpt", "serviceTier": "fast",
        "reasoningLevel": "high", "permissionMode": "accept-edits",
    }))
    .unwrap();
    set_project_execution_defaults(&db, &project, &defaults).unwrap();
    assert_eq!(get_project_execution_defaults(&db, &project).unwrap(), Some(defaults));
    let set = "UPDATE projects SET execution_defaults = ? WHERE id = ?";
    for stored in [
        r#"{"providerId":"codex"}"#,
        r#"{"providerId":"codex","model":"","serviceTier":"fast","reasoningLevel":"high","permissionMode":"auto"}"#,
        "null",
    ] {
        db.run(set, params![stored, project]).unwrap();
        assert_eq!(get_project_execution_defaults(&db, &project).unwrap(), None, "{stored}");
    }
    db.run(set, params!["{not json", project]).unwrap();
    assert!(get_project_execution_defaults(&db, &project).is_err());
}

#[test]
fn sets_the_git_remote_only_when_missing() {
    let db = open();
    let project = create(&db, "alpha", "/repos/alpha").project_id;
    assert!(set_git_remote_url_if_missing(&db, &project, "git@a").unwrap());
    assert!(!set_git_remote_url_if_missing(&db, &project, "git@b").unwrap());
    let stored = require_project(&db, &project).unwrap();
    assert_eq!(stored.git_remote_url.as_deref(), Some("git@a"));
}
