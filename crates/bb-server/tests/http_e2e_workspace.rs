mod http_e2e_support;

use http_e2e_support::{assert_matches, boot, git, git_repo, write};
use serde_json::json;

#[tokio::test]
async fn resolves_a_project_to_its_checkout_for_paths_and_branches() {
    let server = boot().await;
    let repo = git_repo(&[
        ("README.md", "# demo\n"),
        ("src/a.ts", "export const a = 1;\n"),
        ("src/index.html", "<p>hi</p>\n"),
        (".bb/skills/ship/SKILL.md", "---\ndescription: Ship it\n---\n"),
    ]);
    let project = server.create_project("demo", repo.path()).await;
    let project_id = project["id"].as_str().unwrap();
    let host_id = server.host_id();
    git(repo.path(), &["branch", "feature"]);
    write(repo.path(), &[("src/reader.ts", "")]);

    let project = format!("/projects/{project_id}");
    let both = "includeFiles=true&includeDirectories=true";
    let path = format!("{project}/paths?query=read&{both}");
    let paths =
        json!({ "paths": [{ "kind": "file", "path": "README.md" }, { "path": "src/reader.ts" }] });
    assert_matches(&server.read(&path).await, &paths, &path);

    let expected = json!({
        "checkout": { "kind": "branch", "branchName": "main" },
        "branches": ["main", "feature"],
        "selectedBranch": { "name": "feature", "kind": "local" },
        "defaultWorktreeBaseBranch": "main",
        "hasUncommittedChanges": true,
    });
    for route in ["branches", "branch-options"] {
        let path = format!("{project}/{route}?hostId={host_id}&selectedBranch=feature");
        assert_matches(&server.read(&path).await, &expected, &path);
    }
    server.close().await;
}
