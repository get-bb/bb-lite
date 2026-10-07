use std::sync::OnceLock;
use std::time::Duration;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use url::Url;

const REQUEST_TIMEOUT: Duration = Duration::from_millis(15_000);
pub const MACHINE_HEADER: &str = "x-bb-connect-machine";

const MACHINE_LIMIT: &str = "this account has reached its machine limit; revoke a device on the \
                             getbb.app dashboard, then try again";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ConnectError(pub String);

impl ConnectError {
    pub fn new(message: impl Into<String>) -> Self {
        ConnectError(message.into())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub server_id: String,
    pub server_label: String,
    pub server_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileReply {
    Unauthorized,
    Profile(Profile),
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_url: String,
    pub expires_at: f64,
    pub interval_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkPoll {
    Pending,
    Approved { credential: String, server_id: String },
    SlowDown,
    Refused { message: String },
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum PollBody {
    Pending,
    #[serde(rename_all = "camelCase")]
    Approved {
        credential: String,
        server_id: String,
    },
}

#[derive(Deserialize)]
struct MachineCode {
    code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub credential: String,
    pub machine_id: String,
}

#[derive(Deserialize)]
struct Revoked {
    ok: bool,
}

fn client() -> Result<&'static reqwest::Client, ConnectError> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    let built = CLIENT.get_or_init(|| {
        let builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
        builder.build().map_err(|error| error.to_string())
    });
    built.as_ref().map_err(|error| ConnectError(error.clone()))
}

pub(crate) fn host_of(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

pub(crate) fn is_url(value: &str) -> bool {
    Url::parse(value).is_ok()
}

struct Reply {
    host: String,
    status: u16,
    json: Value,
}

impl Reply {
    fn read<T: DeserializeOwned>(
        &self,
        what: &str,
        valid: impl Fn(&T) -> bool,
    ) -> Result<T, ConnectError> {
        let parsed = serde_json::from_value::<T>(self.json.clone()).ok().filter(|v| valid(v));
        match parsed {
            Some(value) if (200..300).contains(&self.status) => Ok(value),
            _ => Err(ConnectError(format!("{} returned HTTP {} {what}", self.host, self.status))),
        }
    }
}

async fn call(
    origin: &str,
    path: &str,
    get: bool,
    credential: Option<&str>,
    body: Option<Value>,
) -> Result<Reply, ConnectError> {
    let url = Url::parse(origin)
        .and_then(|base| base.join(path))
        .map_err(|error| ConnectError(format!("Invalid URL: {error}")))?;
    let host = host_of(&url);
    let method = if get { reqwest::Method::GET } else { reqwest::Method::POST };
    let mut request = client()?
        .request(method, url)
        .timeout(REQUEST_TIMEOUT)
        .header("accept", "application/json");
    if let Some(body) = &body {
        request = request.header("content-type", "application/json").body(body.to_string());
    }
    if let Some(credential) = credential {
        request = request
            .header("authorization", format!("Bearer {credential}"))
            .header(MACHINE_HEADER, credential);
    }
    let response = request
        .send()
        .await
        .map_err(|error| ConnectError(format!("couldn't reach {host}: {error}")))?;
    let status = response.status().as_u16();
    let json = match response.bytes().await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    };
    Ok(Reply { host, status, json })
}

pub async fn fetch_profile(origin: &str, credential: &str) -> Result<ProfileReply, ConnectError> {
    let reply = call(origin, "/api/account/me", true, Some(credential), None).await?;
    if reply.status == 401 {
        return Ok(ProfileReply::Unauthorized);
    }
    let valid = |p: &Profile| {
        !p.server_id.is_empty() && !p.server_label.is_empty() && is_url(&p.server_url)
    };
    reply.read("for the account profile", valid).map(ProfileReply::Profile)
}

pub async fn start_link(origin: &str, client_name: &str) -> Result<LinkStart, ConnectError> {
    let body = json!({ "clientName": client_name });
    let reply = call(origin, "/api/account/link/start", false, None, Some(body)).await?;
    let valid = |s: &LinkStart| {
        !s.device_code.is_empty()
            && !s.user_code.is_empty()
            && is_url(&s.verification_url)
            && s.interval_ms > 0
    };
    let started = reply.read("when starting sign-in", valid)?;
    let origin_of = |value: &str| Url::parse(value).map(|url| url.origin()).ok();
    if origin_of(&started.verification_url) != origin_of(origin) {
        return Err(ConnectError::new("the sign-in link points at a different site"));
    }
    Ok(started)
}

pub async fn poll_link(origin: &str, device_code: &str) -> Result<LinkPoll, ConnectError> {
    let body = json!({ "deviceCode": device_code });
    let reply = call(origin, "/api/account/link/poll", false, None, Some(body)).await?;
    let refusal = match reply.status {
        429 => return Ok(LinkPoll::SlowDown),
        403 => Some("Sign-in was denied on getbb.app."),
        404 => Some("getbb.app no longer knows this sign-in."),
        409 => Some("This sign-in was already completed."),
        410 => Some("The sign-in code expired."),
        _ => None,
    };
    if let Some(message) = refusal {
        return Ok(LinkPoll::Refused { message: message.to_string() });
    }
    let valid = |p: &PollBody| match p {
        PollBody::Pending => true,
        PollBody::Approved { credential, server_id } => {
            !credential.is_empty() && !server_id.is_empty()
        }
    };
    Ok(match reply.read("while waiting for approval", valid)? {
        PollBody::Pending => LinkPoll::Pending,
        PollBody::Approved { credential, server_id } => {
            LinkPoll::Approved { credential, server_id }
        }
    })
}

pub async fn disconnect_server(server_url: &str, credential: &str) -> Result<(), ConnectError> {
    let path = "/api/connect/disconnect";
    let reply = call(server_url, path, false, Some(credential), None).await?;
    if reply.status == 401 || reply.status == 403 {
        return Ok(());
    }
    reply.read::<Value>("when signing out", |_| true).map(drop)
}

pub async fn mint_machine(origin: &str, credential: &str) -> Result<Machine, ConnectError> {
    let minted = call(origin, "/api/connect/machine-code", false, Some(credential), None).await?;
    if minted.status == 409 {
        return Err(ConnectError::new(MACHINE_LIMIT));
    }
    let code: MachineCode =
        minted.read("when minting a machine code", |c: &MachineCode| !c.code.is_empty())?;
    let body = json!({ "code": code.code });
    let redeemed = call(origin, "/api/connect/redeem-machine", false, None, Some(body)).await?;
    let valid = |m: &Machine| !m.credential.is_empty() && !m.machine_id.is_empty();
    redeemed.read("when redeeming a machine code", valid)
}

pub async fn revoke_machine(
    origin: &str,
    credential: &str,
    machine_id: &str,
) -> Result<(), ConnectError> {
    let body = json!({ "machineId": machine_id });
    let path = "/api/connect/revoke-machine";
    let reply = call(origin, path, false, Some(credential), Some(body)).await?;
    reply.read("when revoking a machine", |r: &Revoked| r.ok).map(drop)
}
