mod http_e2e_support;

use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use bb_server::db::pending_interactions::{
    get_pending_interaction, list_active_interactions, to_pending_interaction,
};
use futures::{SinkExt, StreamExt};
use http_e2e_support::{Server, assert_matches, boot};
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

async fn echo_server() -> (Server, String, std::path::PathBuf) {
    let server = boot().await;
    let directory = server.data_dir().join("repo");
    std::fs::create_dir_all(&directory).unwrap();
    let project = server.create_project("echo", &directory).await;
    let project_id = project["id"].as_str().unwrap().to_owned();
    (server, project_id, directory)
}

fn pending_now(server: &Server, thread_id: &str) -> Option<(String, Value)> {
    let rows = list_active_interactions(&server.server.ctx.db, thread_id).unwrap();
    let row = rows.into_iter().next()?;
    if serde_json::to_value(row.status).unwrap() != "pending" {
        return None;
    }
    let path = format!("/threads/{thread_id}/interactions/{}", row.id);
    let interaction = serde_json::to_value(to_pending_interaction(&row).unwrap()).unwrap();
    Some((path, interaction))
}

async fn pending(server: &Server, thread_id: &str) -> (String, Value) {
    server.wait_until("a pending interaction", || pending_now(server, thread_id).is_some()).await;
    pending_now(server, thread_id).unwrap()
}

fn events(server: &Server, thread_id: &str, kind: &str) -> Vec<Value> {
    let sql = "SELECT data FROM events WHERE thread_id = ? AND type = ? ORDER BY sequence";
    let rows = server.server.ctx.db.rows(sql, [thread_id, kind]).unwrap();
    rows.iter().map(|row| serde_json::from_str(row["data"].as_str().unwrap()).unwrap()).collect()
}

async fn post_ok(server: &Server, path: &str, body: Value) -> Value {
    let (status, response) = server.post(path, body).await;
    assert!(status.is_success(), "POST {path}: {status} {response}");
    response
}

fn run_cli(server: &Server, plugin: &str, body: Value) -> JoinHandle<Value> {
    let request = server.http.post(format!("{}/api/v1/plugins/{plugin}/cli", server.url));
    tokio::spawn(async move {
        let response = request.json(&body).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        serde_json::from_str(&response.text().await.unwrap()).unwrap()
    })
}

#[tokio::test]
async fn collects_secrets_in_a_thread_form_and_writes_them_to_the_dotenv_file() {
    let (server, project_id, cwd) = echo_server().await;
    let thread_id = server.create_echo_thread(&project_id, "hello").await;
    server.wait_for_status(&thread_id, "idle").await;
    let file = cwd.join(".env.local");
    std::fs::write(&file, "OTHER=1\nAPI_KEY=old # rotate me\n").unwrap();
    let ws_url = format!("{}/ws", server.url.replace("http://", "ws://"));
    let (mut socket, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
    let subscribe = json!({ "type": "subscribe", "target": { "kind": "thread-list" } });
    socket.send(Message::text(subscribe.to_string())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let names = ["API_KEY", "TOKEN"];
    let argv = json!([
        "request",
        "API_KEY",
        "TOKEN",
        "--write-env=.env.local",
        "--purpose=Deploy",
        "--describe",
        "API_KEY",
        "Main"
    ]);
    let cwd_text = cwd.to_string_lossy().into_owned();
    let run = |scope: Value| {
        let mut body = json!({ "argv": argv, "cwd": cwd_text });
        body.as_object_mut().unwrap().extend(scope.as_object().unwrap().clone());
        run_cli(&server, "secrets", body)
    };
    let unscoped = run(json!({})).await.unwrap();
    let stderr = unscoped["stderr"].as_str().unwrap();
    assert!(stderr.contains("must run from a bb thread"), "{unscoped}");

    let cancelled = run(json!({ "threadId": thread_id }));
    let changed = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(message) = socket.next().await {
            if let Message::Text(text) = message.unwrap() {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["changes"].to_string().contains("interactions-changed") {
                    return value;
                }
            }
        }
        panic!("socket closed");
    })
    .await
    .unwrap();
    assert_matches(&changed["metadata"], &json!({ "hasPendingInteraction": true }), "metadata");
    let (path, _) = pending(&server, &thread_id).await;
    post_ok(&server, &format!("{path}/cancel"), json!({})).await;
    let refusal = "Secret request cancelled (user).\n";
    let cancelled = cancelled.await.unwrap();
    assert_matches(&cancelled, &json!({ "exitCode": 1, "stderr": refusal }), "cancelled");

    let command = run(json!({ "threadId": thread_id }));
    let (path, interaction) = pending(&server, &thread_id).await;
    let file_text = file.to_string_lossy().into_owned();
    let fields = json!([{ "name": "API_KEY", "description": "Main" }, { "name": "TOKEN", "description": null }]);
    let destination = json!({ "kind": "dotenv", "path": file_text });
    let data = json!({ "purpose": "Deploy", "destination": destination, "fields": fields });
    let origin = json!({ "pluginId": "secrets", "rendererId": "secret-request" });
    let payload = json!({ "title": "Add secrets", "data": data });
    assert_matches(&interaction, &json!({ "origin": origin, "payload": payload }), "interaction");
    let mut appended = std::fs::read_to_string(&file).unwrap();
    appended.push_str("LATE=1\n");
    std::fs::write(&file, appended).unwrap();
    let values = json!({ "API_KEY": "s3cr3t", "TOKEN": "it's" });
    post_ok(&server, &format!("{path}/respond"), json!({ "value": { "values": values } })).await;
    let report =
        json!({ "path": file_text, "names": names, "added": 1, "updated": 1, "unchanged": 0 });
    let stdout = format!("{report}\n");
    let command = command.await.unwrap();
    assert_eq!(command, json!({ "exitCode": 0, "stdout": stdout, "stderr": "" }));
    let written = "OTHER=1\nAPI_KEY='s3cr3t' # rotate me\nLATE=1\nTOKEN=\"it's\"\n";
    assert_eq!(std::fs::read_to_string(&file).unwrap(), written);
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);

    let lifecycle = events(&server, &thread_id, "system/interaction/lifecycle");
    let states: Vec<&Value> =
        lifecycle.iter().map(|event| &event["interaction"]["status"]).collect();
    assert_eq!(
        states,
        [&json!("pending"), &json!("interrupted"), &json!("pending"), &json!("resolved")]
    );
    let detail = format!("{file_text}\n- API_KEY\n- TOKEN");
    let description = json!({ "title": "Provided API_KEY, TOKEN", "detail": detail });
    let resolution = json!({ "kind": "plugin_submitted", "description": description });
    assert_eq!(lifecycle.last().unwrap()["interaction"]["resolution"], resolution);
    let id = interaction["id"].as_str().unwrap();
    let row = get_pending_interaction(&server.server.ctx.db, id).unwrap();
    let stored = serde_json::to_string(&(lifecycle, row)).unwrap();
    assert!(!stored.contains("s3cr3t"), "{stored}");
    server.close().await;
}

#[tokio::test]
async fn asks_the_user_on_behalf_of_a_provider_without_native_questions() {
    let (server, project_id, _cwd) = echo_server().await;
    let option = |label: &str| json!({ "label": label, "description": format!("Use_{label}") });
    let options = [option("Postgres"), option("SQLite")];
    let questions = json!([{ "question": "Which_db?", "header": "DB", "options": options }]);
    let input = json!({ "questions": questions }).to_string();
    let prompt = format!("call_tool:AskUserQuestion tool_input:{input}");
    let thread_id = server.create_echo_thread(&project_id, &prompt).await;
    let (path, interaction) = pending(&server, &thread_id).await;
    let choices = json!([
        { "value": "q0o0", "label": "Postgres", "description": "Use Postgres" },
        { "value": "q0o1", "label": "SQLite", "description": "Use SQLite" },
    ]);
    let shown = json!({
        "id": "q0",
        "prompt": "Which db?",
        "shortLabel": "DB",
        "multiSelect": false,
        "allowFreeText": true,
        "options": choices,
    });
    let data = json!({ "questions": [shown] });
    let origin = json!({ "pluginId": "ask-user-question" });
    let shape = json!({ "origin": origin, "payload": { "title": "DB", "data": data } });
    assert_matches(&interaction, &shape, "interaction");
    let answers = json!({ "q0": { "selected": ["q0o0"], "freeText": "with pgbouncer" } });
    post_ok(&server, &format!("{path}/respond"), json!({ "value": { "answers": answers } })).await;
    server.wait_for_status(&thread_id, "idle").await;

    let answer = "Postgres; with pgbouncer";
    let completed = events(&server, &thread_id, "item/completed");
    let items: Vec<&Value> = completed.iter().map(|event| &event["item"]).collect();
    let call = items.iter().find(|item| item["type"] == "toolCall").unwrap();
    let result: Value = serde_json::from_str(call["result"].as_str().unwrap()).unwrap();
    let expected = json!({
        "questions": [{ "question": "Which db?", "header": "DB" }],
        "answers": { "Which db?": answer },
        "annotations": { "Which db?": { "notes": "with pgbouncer" } },
    });
    assert_matches(&result, &expected, "result");
    assert_eq!(items.last().unwrap()["text"], "Tool called: AskUserQuestion");
    let lifecycle = events(&server, &thread_id, "system/interaction/lifecycle");
    let description = json!({ "title": format!("Answered Which db? — {answer}") });
    let settled = &lifecycle[1]["interaction"];
    assert_matches(settled, &json!({ "resolution": { "description": description } }), "settled");

    let dismissed_id = server.create_echo_thread(&project_id, &prompt).await;
    let (path, _) = pending(&server, &dismissed_id).await;
    post_ok(&server, &format!("{path}/cancel"), json!({})).await;
    server.wait_for_status(&dismissed_id, "idle").await;
    let refused = events(&server, &dismissed_id, "item/completed");
    let refused = serde_json::to_string(&refused).unwrap();
    assert!(refused.contains("dismissed the question"), "{refused}");
    server.close().await;
}
