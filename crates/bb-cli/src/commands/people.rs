use serde_json::{Map, Value, json};

use crate::call::{Call, CliError, CliResult, Handler, Output, locale_date, usage_error, valid_id};
use crate::commands::workspace::{text, with};
use crate::http::encode;

const ROLES: &[&str] = &["owner", "member"];

/// Handlers ported from `apps/cli/src/commands/people.ts`.
pub fn handlers() -> Vec<(&'static str, Handler)> {
    vec![
        ("whoami", whoami),
        ("userList", user_list),
        ("userInvite", user_invite),
        ("userInvites", user_invites),
        ("userRevokeInvite", user_revoke_invite),
        ("userSignInLink", user_sign_in_link),
        ("userRole", user_role),
        ("userDisable", user_disable),
        ("userEnable", user_enable),
    ]
}

fn id(call: &Call, name: &str) -> CliResult<String> {
    valid_id(call.arg(name)?, &format!("<{name}> argument"))
}

fn date(value: &Value, key: &str) -> String {
    locale_date(value.get(key).and_then(Value::as_f64).unwrap_or(0.0))
}

fn user_path(user_id: &str, suffix: &str) -> String {
    format!("/users/{}{suffix}", encode(user_id))
}

fn current_user(call: &Call) -> CliResult<Value> {
    let session = call.http.get("/auth/session", &[])?;
    match session.get("user") {
        Some(user) if !user.is_null() => Ok(user.clone()),
        _ => Err(CliError::new("Not signed in: the server sees no user for this CLI.")
            .code("not_signed_in")
            .hint("Run bb on the server machine, where it acts as the owner.")),
    }
}

fn whoami(call: &mut Call) -> CliResult<Output> {
    let user = current_user(call)?;
    let email = match user.get("email").and_then(Value::as_str) {
        Some(email) => format!(" <{email}>"),
        None => String::new(),
    };
    let line =
        format!("{}{email}  {}  {}", text(&user, "name"), text(&user, "role"), text(&user, "id"));
    Ok(Output::text(json!({ "user": user }), line))
}

fn user_list(call: &mut Call) -> CliResult<Output> {
    let users = call.http.get("/users", &[])?;
    let rows: Vec<Value> = users
        .as_array()
        .into_iter()
        .flatten()
        .map(|user| {
            let active = user.get("disabledAt").is_none_or(Value::is_null);
            let status = if active { "active" } else { "disabled" };
            with(user.clone(), json!({ "status": status }))
        })
        .collect();
    Ok(Output::rows(&rows, &["id", "name", "email", "role", "status"], users))
}

const LOOPBACK_HINT: &str = "This link uses the server's own loopback address. Swap in the address \
    people use to reach this bb, or set it under Settings > Machines > Machine access so links \
    come out ready to share.";

fn link_lines(head: String, url: String) -> Vec<String> {
    let host = url.split_once("://").map_or("", |(_, rest)| rest);
    let loopback = ["127.0.0.1", "localhost", "[::1]"].iter().any(|name| {
        host.strip_prefix(name).is_some_and(|rest| rest.starts_with(':') || rest.starts_with('/'))
    });
    if loopback { vec![head, url, LOOPBACK_HINT.to_string()] } else { vec![head, url] }
}

fn user_invite(call: &mut Call) -> CliResult<Output> {
    let mut body = Map::new();
    for name in ["name", "email"] {
        if let Some(value) = call.flag(name)? {
            body.insert(name.into(), json!(value));
        }
    }
    if let Some(role) = call.choice("role", ROLES)? {
        body.insert("role".into(), json!(role));
    }
    let invite = call.http.post("/users/invites", &Value::Object(body))?;
    let head = format!(
        "Invite {} for a new {} (expires {}):",
        text(&invite, "id"),
        text(&invite, "role"),
        date(&invite, "expiresAt")
    );
    let lines = link_lines(head, text(&invite, "url"));
    Ok(Output::lines(invite, &lines))
}

fn user_invites(call: &mut Call) -> CliResult<Output> {
    let invites = call.http.get("/users/invites", &[])?;
    let rows = invites.as_array().cloned().unwrap_or_default();
    Ok(Output::rows(&rows, &["id", "name", "email", "role", "expiresAt"], invites))
}

fn user_revoke_invite(call: &mut Call) -> CliResult<Output> {
    let invite_id = id(call, "id")?;
    let result = call.http.delete(&format!("/users/invites/{}", encode(&invite_id)), &[])?;
    let line = format!("Invite {invite_id} revoked");
    Ok(Output::text(with(result, json!({ "inviteId": invite_id })), line))
}

fn user_sign_in_link(call: &mut Call) -> CliResult<Output> {
    let user_id = match call.args("id") {
        Some(given) => valid_id(given, "<id> argument")?,
        None => text(&current_user(call)?, "id"),
    };
    let link = call.http.request("POST", &user_path(&user_id, "/sign-in-links"), &[], None)?;
    let expires = date(&link, "expiresAt");
    let head = format!("One-time sign-in link for {user_id} (expires {expires}):");
    let lines = link_lines(head, text(&link, "url"));
    Ok(Output::lines(with(link, json!({ "userId": user_id })), &lines))
}

fn user_role(call: &mut Call) -> CliResult<Output> {
    let wanted = call.arg("role")?.trim().to_lowercase();
    let Some(role) = ROLES.iter().find(|candidate| **candidate == wanted) else {
        let expected = ROLES.join(", ");
        return Err(usage_error(format!("Invalid role '{wanted}'. Expected: {expected}.")));
    };
    let user = call.http.patch(&user_path(&id(call, "id")?, ""), &json!({ "role": role }))?;
    let line = format!("User {} is now {}", text(&user, "id"), text(&user, "role"));
    Ok(Output::text(user, line))
}

fn set_disabled(call: &mut Call, disabled: bool) -> CliResult<Output> {
    let user =
        call.http.patch(&user_path(&id(call, "id")?, ""), &json!({ "disabled": disabled }))?;
    let enabled = user.get("disabledAt").is_none_or(Value::is_null);
    let state = if enabled { "enabled" } else { "disabled" };
    let line = format!("User {} is {state}", text(&user, "id"));
    Ok(Output::text(user, line))
}

fn user_disable(call: &mut Call) -> CliResult<Output> {
    set_disabled(call, true)
}

fn user_enable(call: &mut Call) -> CliResult<Output> {
    set_disabled(call, false)
}
