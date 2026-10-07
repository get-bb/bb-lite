mod http_e2e_support;

use http_e2e_support::{assert_matches, boot};
use reqwest::StatusCode;
use serde_json::json;

#[tokio::test]
async fn gives_personal_threads_a_scratch_workspace_and_removes_it_on_request() {
    let server = boot().await;
    let id = server.create_echo_thread("proj_personal", "hello").await;
    server.wait_for_status(&id, "idle").await;
    let path = server.data_dir().join("workspaces").join(&id);

    let (status, listed) = server.get("/environments").await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    let environment_id = listed[0]["id"].as_str().unwrap().to_owned();
    let thread = server.read(&format!("/threads/{id}")).await;
    let thread_environment = thread["environmentId"].as_str().unwrap();
    assert_eq!(thread_environment, environment_id);
    let environment = server.read(&format!("/environments/{environment_id}")).await;
    let expected = json!({
        "environmentProviderId": "personal-workspace",
        "status": "ready",
        "path": path.to_string_lossy(),
        "managed": true,
        "isGitRepo": false,
    });
    assert_matches(&environment, &expected, "environment");
    assert!(path.exists());

    let remove = format!("/environments/{environment_id}");
    assert_eq!(server.delete(&remove).await.0, StatusCode::CONFLICT);
    let (status, archived) = server.post(&format!("/threads/{id}/archive-all"), json!({})).await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    let (status, removed) = server.delete(&remove).await;
    assert_eq!(status, StatusCode::OK, "{removed}");
    let stored =
        bb_server::db::environments::get_environment(&server.server.ctx.db, &environment_id)
            .unwrap()
            .unwrap();
    let left = (serde_json::to_value(stored.status).unwrap(), path.exists());
    assert_eq!(left, (json!("destroyed"), false));
    server.close().await;
}
