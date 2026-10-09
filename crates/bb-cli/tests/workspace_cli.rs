mod support_b;

use bb_cli::call::CliEnv;
use serde_json::json;
use support_b::{FakeServer, Request, route, run};

fn request(method: &str, path: &str, body: Option<serde_json::Value>) -> Request {
    Request { method: method.into(), path: path.into(), body }
}

#[test]
fn project_list_prints_sources_per_project() {
    let projects = json!([{ "id": "proj_1", "name": "Demo",
        "sources": [{ "hostId": "host_1", "path": "/src" }] }]);
    let server = FakeServer::start(vec![route("GET", "/projects", projects)]);
    let (result, printed) = run(&server, &["project", "list"], CliEnv::default());
    result.unwrap();
    assert_eq!(printed, "\nID      NAME  SOURCES\nproj_1  Demo  host_1:/src\n\n");
    assert_eq!(server.requests(), [request("GET", "/projects?includePersonal=false", None)]);
}

#[test]
fn project_create_and_source_add_send_local_paths() {
    let server = FakeServer::start(vec![
        route("POST", "/projects", json!({ "id": "proj_2", "name": "Demo" })),
        route("POST", "/projects/proj_1/sources", json!({ "id": "src_1" })),
        route("PATCH", "/projects/proj_1/sources/src_1", json!({ "id": "src_1" })),
    ]);
    let words =
        ["project", "create", "--name", "Demo", "--root", "/tmp/x/../y", "--machine", "host_1"];
    let (result, printed) = run(&server, &words, CliEnv::default());
    result.unwrap();
    assert_eq!(printed, "Project proj_2 created (Demo)\n");
    let words = [
        "project",
        "source",
        "add",
        "proj_1",
        "--path",
        "/src",
        "--machine",
        "host_1",
        "--default",
    ];
    let (result, printed) = run(&server, &words, CliEnv::default());
    result.unwrap();
    assert_eq!(printed, "Source src_1 added to project proj_1\n");
    let source = json!({ "type": "local_path", "hostId": "host_1", "path": "/tmp/y" });
    assert_eq!(
        server.requests(),
        [
            request("POST", "/projects", Some(json!({ "name": "Demo", "source": source }))),
            request(
                "POST",
                "/projects/proj_1/sources",
                Some(json!({ "hostId": "host_1", "path": "/src", "type": "local_path" }))
            ),
            request(
                "PATCH",
                "/projects/proj_1/sources/src_1",
                Some(json!({ "isDefault": true, "type": "local_path" }))
            ),
        ]
    );
}

#[test]
fn machine_list_shows_creating_hosts_with_owner_and_sharing() {
    let hosts = json!([
        { "id": "host_1", "name": "box", "status": "online", "lastSeenAt": null,
          "ownerUserId": "usr_1", "sharing": "shared" },
        { "id": "host_2", "name": "lab", "status": "offline", "lastSeenAt": null,
          "ownerUserId": "usr_9", "sharing": "private" },
        { "id": "host_3", "name": "old", "status": "offline", "lastSeenAt": null,
          "ownerUserId": null, "sharing": "shared" },
    ]);
    let users = json!([{ "id": "usr_1", "name": "Ada" }]);
    let routes = vec![route("GET", "/machines", hosts.clone()), route("GET", "/users", users)];
    let server = FakeServer::start(routes);
    let (result, printed) = run(&server, &["machine", "list"], CliEnv::default());
    result.unwrap();
    let expected = "\nID      NAME  STATUS   SHARING  OWNER  LASTSEENAT\n\
        host_1  box   online   shared   Ada    -\n\
        host_2  lab   offline  private  usr_9  -\n\
        host_3  old   offline  shared   -      -\n\n";
    assert_eq!(printed, expected);
    let listed =
        [request("GET", "/machines?includeCreating=true", None), request("GET", "/users", None)];
    assert_eq!(server.requests(), listed);
    let forbidden = FakeServer::start(vec![route("GET", "/machines", hosts.clone())]);
    let (result, printed) = run(&forbidden, &["machine", "list", "--json"], CliEnv::default());
    result.unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&printed).unwrap(), hosts);
}

#[test]
fn machine_share_and_unshare_patch_the_sharing_of_a_machine() {
    let host = json!({ "id": "host_1", "sharing": "shared" });
    let server = FakeServer::start(vec![route("PATCH", "/machines/host_1/sharing", host)]);
    let (result, printed) = run(&server, &["machine", "share", "host_1"], CliEnv::default());
    result.unwrap();
    assert_eq!(printed, "Machine host_1 is shared\n");
    run(&server, &["machine", "unshare", "host_1"], CliEnv::default()).0.unwrap();
    let sent = |sharing: &str| {
        request("PATCH", "/machines/host_1/sharing", Some(json!({ "sharing": sharing })))
    };
    assert_eq!(server.requests(), [sent("shared"), sent("private")]);
}

#[test]
fn provider_list_and_models_route_by_machine() {
    let models = json!({ "models": [{ "model": "m1", "displayName": "M1", "isDefault": true }],
        "modelLoadError": null });
    let server = FakeServer::start(vec![
        route("GET", "/sessions/providers", json!([{ "id": "codex", "displayName": "Codex" }])),
        route("GET", "/sessions/execution-options", models),
    ]);
    let (result, printed) = run(&server, &["provider", "list"], CliEnv::default());
    result.unwrap();
    assert_eq!(printed, "\nID     DISPLAYNAME\ncodex  Codex\n\n");
    let words = ["provider", "models", "codex", "--machine", "host_1"];
    let (result, printed) = run(&server, &words, CliEnv::default());
    result.unwrap();
    assert_eq!(printed, "\nMODEL  DISPLAYNAME  ISDEFAULT\nm1     M1           true\n\n");
    assert_eq!(
        server.requests(),
        [
            request("GET", "/sessions/providers", None),
            request("GET", "/sessions/execution-options?hostId=host_1&providerId=codex", None),
        ]
    );
}

#[test]
fn env_commands_build_queries_and_bodies() {
    let server = FakeServer::start(vec![
        route("GET", "/environments", json!([])),
        route("PATCH", "/environments/env_1", json!({ "id": "env_1" })),
        route("DELETE", "/environments/env_1", json!({ "ok": true })),
        route("GET", "/environments/env_1/status", json!({ "branch": "b" })),
    ]);
    let env = CliEnv::default;
    let words = ["env", "list", "--project", "proj_1", "--status", "READY", "--limit", "5"];
    let (result, printed) = run(&server, &words, env());
    result.unwrap();
    assert_eq!(printed, "None found\n");
    let (result, printed) = run(&server, &["env", "update", "env_1", "--name", "x"], env());
    result.unwrap();
    assert_eq!(printed, "Environment env_1 updated\n");
    let (result, _) = run(&server, &["env", "update", "env_1"], env());
    let error = result.unwrap_err();
    assert_eq!(error.message, "Nothing to change; pass --name or --merge-base-branch.");
    assert_eq!(error.code, "invalid_value");
    let words = ["env", "update", "env_1", "--name", "x", "--clear-name"];
    let (result, _) = run(&server, &words, env());
    assert_eq!(result.unwrap_err().message, "Cannot combine --name with --clear-name.");
    let (result, printed) = run(&server, &["env", "delete", "env_1", "--yes", "--json"], env());
    result.unwrap();
    assert_eq!(printed, "{\n  \"ok\": true,\n  \"environmentId\": \"env_1\"\n}\n");
    let words = ["env", "status", "env_1", "--merge-base-branch", "main"];
    let (result, printed) = run(&server, &words, env());
    result.unwrap();
    assert_eq!(printed, "{\n  \"branch\": \"b\"\n}\n");
    assert_eq!(
        server.requests(),
        [
            request("GET", "/environments?projectId=proj_1&status=ready&limit=5", None),
            request("PATCH", "/environments/env_1", Some(json!({ "name": "x" }))),
            request("DELETE", "/environments/env_1", None),
            request("GET", "/environments/env_1/status?mergeBaseBranch=main", None),
        ]
    );
}

#[test]
fn env_diff_commands_print_what_the_original_printed() {
    let files = json!({
        "outcome": "available",
        "files": [{
            "path": "b.txt", "previousPath": "a.txt", "changeKind": "renamed",
            "additions": 1, "deletions": 0, "binary": false, "origin": "tracked",
            "loadMode": "auto"
        }],
        "truncated": true, "shortstat": " 1 file changed\n", "mergeBaseRef": null,
        "initialPatches": []
    });
    let server = FakeServer::start(vec![
        route("GET", "/environments/env_1/diff/files", files),
        route(
            "POST",
            "/environments/env_1/diff/patch",
            json!({ "outcome": "not_applicable", "reason": "non_git_environment",
                    "message": "Not git" }),
        ),
        route(
            "GET",
            "/environments/env_1/diff/branches",
            json!({ "branches": ["main"], "branchesTruncated": false,
                    "remoteBranches": [], "remoteBranchesTruncated": true }),
        ),
        route(
            "POST",
            "/environments/env_1/archive-threads",
            json!({
            "ok": true, "archivedThreadIds": ["thr_1", "thr_2"] }),
        ),
    ]);
    let env = CliEnv::default;
    let words = ["env", "diff-files", "env_1", "--target", "all", "--merge-base-branch", "main"];
    let (result, printed) = run(&server, &words, env());
    result.unwrap();
    let expected = "renamed\t+1 -0\ttracked\tauto\ta.txt -> b.txt\n1 file changed\n\
                    (additional changed files omitted)\n";
    assert_eq!(printed, expected);
    let words =
        ["env", "diff-patch", "env_1", "--target", "commit", "--sha", "abcd", "--path", "x"];
    let (result, printed) = run(&server, &words, env());
    result.unwrap();
    assert_eq!(printed, "Diff patches unavailable: Not git\n");
    let (result, printed) = run(&server, &["env", "branches", "env_1", "--limit", "0"], env());
    result.unwrap();
    assert_eq!(printed, "Local branches:\n  main\nRemote branches:\n  (none)\n  (truncated)\n");
    let (result, printed) = run(&server, &["env", "archive-threads", "env_1"], env());
    result.unwrap();
    assert_eq!(printed, "Archived 2 thread(s) in environment env_1\n");
    let words = ["env", "diff-files", "env_1", "--target", "commit"];
    let (result, _) = run(&server, &words, env());
    assert_eq!(result.unwrap_err().message, "--sha is required when --target commit is used.");
    let words = ["env", "diff-patch", "env_1", "--target", "uncommitted"];
    let (result, _) = run(&server, &words, env());
    assert_eq!(result.unwrap_err().message, "Provide at least one --path.");
    assert_eq!(
        server.requests(),
        [
            request("GET", "/environments/env_1/diff/files?target=all&mergeBaseBranch=main", None),
            request(
                "POST",
                "/environments/env_1/diff/patch",
                Some(json!({ "target": { "type": "commit", "sha": "abcd" }, "paths": ["x"] })),
            ),
            request("GET", "/environments/env_1/diff/branches?limit=0", None),
            request("POST", "/environments/env_1/archive-threads", Some(json!({}))),
        ]
    );
}
