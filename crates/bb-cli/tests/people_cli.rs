mod support_b;

use bb_cli::call::{CliEnv, locale_date};
use serde_json::{Value, json};
use support_b::{FakeServer, Request, route, run};

const EXPIRES_AT: f64 = 1_800_000_000_000.0;

fn request(method: &str, path: &str, body: Option<Value>) -> Request {
    Request { method: method.into(), path: path.into(), body }
}

fn user(id: &str, name: &str, role: &str, disabled_at: Value) -> Value {
    json!({ "id": id, "name": name, "email": null, "role": role, "disabledAt": disabled_at })
}

fn ok(server: &FakeServer, words: &[&str]) -> String {
    let (result, printed) = run(server, words, CliEnv::default());
    result.unwrap();
    printed
}

#[test]
fn whoami_prints_the_session_user_and_fails_without_one() {
    let mut ada = user("usr_1", "Ada", "owner", Value::Null);
    ada["email"] = json!("ada@example.com");
    let session = json!({ "user": ada });
    let server = FakeServer::start(vec![route("GET", "/auth/session", session.clone())]);
    assert_eq!(ok(&server, &["whoami"]), "Ada <ada@example.com>  owner  usr_1\n");
    let printed = ok(&server, &["whoami", "--json"]);
    assert_eq!(serde_json::from_str::<Value>(&printed).unwrap(), session);
    let anonymous = FakeServer::start(vec![route("GET", "/auth/session", json!({ "user": null }))]);
    let error = run(&anonymous, &["whoami"], CliEnv::default()).0.unwrap_err();
    assert_eq!(error.code, "not_signed_in");
    assert_eq!(error.message, "Not signed in: the server sees no user for this CLI.");
}

#[test]
fn user_list_shows_who_is_disabled() {
    let users = json!([
        user("usr_1", "Ada", "owner", Value::Null),
        user("usr_2", "Bo", "member", json!(5))
    ]);
    let server = FakeServer::start(vec![route("GET", "/users", users)]);
    let expected = "\nID     NAME  EMAIL  ROLE    STATUS\n\
        usr_1  Ada   -      owner   active\n\
        usr_2  Bo    -      member  disabled\n\n";
    assert_eq!(ok(&server, &["user", "list"]), expected);
}

#[test]
fn invites_are_created_listed_and_revoked() {
    let invite = json!({ "id": "inv_1", "name": "Bo", "email": null, "role": "member",
        "expiresAt": EXPIRES_AT, "url": "http://bb/invite/tok" });
    let server = FakeServer::start(vec![
        ("POST", "/user-invites".into(), 201, invite.clone()),
        route("GET", "/user-invites", json!([invite])),
        route("DELETE", "/user-invites/inv_1", json!({ "ok": true })),
    ]);
    let expires = locale_date(EXPIRES_AT);
    let printed = ok(&server, &["user", "invite", "--name", "Bo", "--role", "Member"]);
    let expected =
        format!("Invite inv_1 for a new member (expires {expires}):\nhttp://bb/invite/tok\n");
    assert_eq!(printed, expected);
    ok(&server, &["invite"]);
    assert!(
        ok(&server, &["user", "invites"])
            .contains(&format!("inv_1  Bo    -      member  {expires}"))
    );
    assert_eq!(ok(&server, &["user", "revoke-invite", "inv_1"]), "Invite inv_1 revoked\n");
    let sent = [
        request("POST", "/user-invites", Some(json!({ "name": "Bo", "role": "member" }))),
        request("POST", "/user-invites", Some(json!({}))),
        request("GET", "/user-invites", None),
        request("DELETE", "/user-invites/inv_1", None),
    ];
    assert_eq!(server.requests(), sent);
    let error = run(&server, &["user", "invite", "--role", "admin"], CliEnv::default()).0;
    assert_eq!(error.unwrap_err().message, "Invalid --role 'admin'. Expected: owner, member.");
}

#[test]
fn sign_in_link_defaults_to_the_session_user() {
    let link = json!({ "url": "http://bb/sign-in/tok", "expiresAt": EXPIRES_AT });
    let session = json!({ "user": user("usr_1", "Ada", "owner", Value::Null) });
    let server = FakeServer::start(vec![
        route("GET", "/auth/session", session),
        ("POST", "/users/usr_1/sign-in-links".into(), 201, link.clone()),
        ("POST", "/users/usr_2/sign-in-links".into(), 201, link),
    ]);
    let expires = locale_date(EXPIRES_AT);
    let expected =
        format!("One-time sign-in link for usr_1 (expires {expires}):\nhttp://bb/sign-in/tok\n");
    assert_eq!(ok(&server, &["user", "sign-in-link"]), expected);
    let printed = ok(&server, &["user", "sign-in-link", "usr_2", "--json"]);
    assert_eq!(serde_json::from_str::<Value>(&printed).unwrap()["userId"], "usr_2");
    let sent = [
        request("GET", "/auth/session", None),
        request("POST", "/users/usr_1/sign-in-links", None),
        request("POST", "/users/usr_2/sign-in-links", None),
    ];
    assert_eq!(server.requests(), sent);
}

#[test]
fn role_disable_and_enable_patch_the_user() {
    let patched = user("usr_2", "Bo", "owner", json!(5));
    let server = FakeServer::start(vec![route("PATCH", "/users/usr_2", patched)]);
    assert_eq!(ok(&server, &["user", "role", "usr_2", "owner"]), "User usr_2 is now owner\n");
    assert_eq!(ok(&server, &["user", "disable", "usr_2"]), "User usr_2 is disabled\n");
    ok(&server, &["users", "enable", "usr_2"]);
    let sent = |body: Value| request("PATCH", "/users/usr_2", Some(body));
    let bodies =
        [json!({ "role": "owner" }), json!({ "disabled": true }), json!({ "disabled": false })];
    assert_eq!(server.requests(), bodies.map(sent));
    let error = run(&server, &["user", "role", "usr_2", "admin"], CliEnv::default()).0;
    assert_eq!(error.unwrap_err().message, "Invalid role 'admin'. Expected: owner, member.");
}

#[test]
fn every_request_names_the_thread_it_is_sent_for() {
    let server = FakeServer::start(vec![route("GET", "/users", json!([]))]);
    let env = CliEnv { thread_id: Some("thr_abc".into()), ..CliEnv::default() };
    run(&server, &["user", "list"], env).0.unwrap();
    ok(&server, &["user", "list"]);
    assert_eq!(*server.thread_ids.lock().unwrap(), [Some("thr_abc".to_string()), None]);
}
