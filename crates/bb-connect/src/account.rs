use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::contract::{LoginState, LoginView};
use crate::hosted::{self, ConnectError, LinkPoll, LinkStart, ProfileReply};

const MAX_POLL_INTERVAL: Duration = Duration::from_millis(30_000);
const UNCONFIRMED: &str =
    "getbb.app approved the sign-in but did not confirm the new credential. Sign in again.";
const LEGACY_CREDENTIAL: &str =
    "SELECT value FROM plugin_kv WHERE plugin_id = 'bb-account' AND key = 'credential'";
const NO_CREDENTIAL: &str = "that database holds no bb account credential";

/// The stored link to a getbb.app account, the content of `connect.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub base_url: String,
    pub server_url: String,
    pub server_id: String,
    pub server_label: String,
    pub credential: String,
}

fn is_http_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

impl Link {
    pub fn is_valid(&self) -> bool {
        is_http_url(&self.base_url)
            && is_http_url(&self.server_url)
            && !self.server_id.is_empty()
            && !self.server_label.is_empty()
            && !self.credential.is_empty()
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// `https://<label>--<port>.<host of baseUrl>`.
pub fn share_url(link: &Link, port: u16) -> String {
    let base = Url::parse(&link.base_url).ok();
    let scheme = base.as_ref().map_or("https", |url| url.scheme());
    let host = base.as_ref().map(hosted::host_of).unwrap_or_default();
    format!("{scheme}://{}--{port}.{host}", link.server_label)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyLink {
    base_url: String,
    server_url: String,
    server_id: String,
    credential: String,
}

/// Reads the credential of an original bb install out of its database, opened read-only.
pub fn legacy_link(database_path: &Path) -> Result<Link, ConnectError> {
    let error = |e: rusqlite::Error| ConnectError(e.to_string());
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let database = Connection::open_with_flags(database_path, flags).map_err(error)?;
    let value: Option<rusqlite::types::Value> =
        database.query_row(LEGACY_CREDENTIAL, [], |row| row.get(0)).optional().map_err(error)?;
    let Some(rusqlite::types::Value::Text(text)) = value else {
        return Err(ConnectError::new(NO_CREDENTIAL));
    };
    let invalid = |detail: String| ConnectError(format!("invalid bb account credential: {detail}"));
    let stored: LegacyLink = serde_json::from_str(&text).map_err(|e| invalid(e.to_string()))?;
    let server_label = Url::parse(&stored.server_url)
        .ok()
        .and_then(|url| url.host_str().map(|h| h.split('.').next().unwrap_or_default().to_string()))
        .unwrap_or_default();
    let link = Link {
        base_url: stored.base_url,
        server_url: stored.server_url,
        server_id: stored.server_id,
        server_label,
        credential: stored.credential,
    };
    let checked = is_http_url(&link.base_url)
        && is_http_url(&link.server_url)
        && !link.server_id.is_empty()
        && !link.credential.is_empty();
    if !checked {
        return Err(invalid("a field is missing or malformed".to_string()));
    }
    Ok(link)
}

pub struct AccountOptions {
    pub file: PathBuf,
    pub base_url: String,
    pub client_name: String,
    pub warn: Arc<dyn Fn(&str) + Send + Sync>,
    pub on_change: Arc<dyn Fn() + Send + Sync>,
    pub poll_margin: Duration,
    pub slow_down_step: Duration,
}

impl AccountOptions {
    /// Options with the default poll margin (250ms) and slow-down step (5s).
    pub fn new(
        file: PathBuf,
        base_url: String,
        client_name: String,
        warn: Arc<dyn Fn(&str) + Send + Sync>,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        AccountOptions {
            file,
            base_url,
            client_name,
            warn,
            on_change,
            poll_margin: Duration::from_millis(250),
            slow_down_step: Duration::from_millis(5_000),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LogoutResult {
    pub revoked: bool,
}

#[derive(Default)]
struct State {
    link: Option<Link>,
    login: Option<LoginView>,
    attempt: u64,
}

struct Inner {
    options: AccountOptions,
    state: Mutex<State>,
}

/// The account link of this bb and the device sign-in flow. Cheap to clone; clones share state.
#[derive(Clone)]
pub struct ConnectAccount {
    inner: Arc<Inner>,
}

impl ConnectAccount {
    /// Loads `options.file`; a missing or invalid file means not signed in.
    pub fn new(options: AccountOptions) -> Self {
        let link = std::fs::read_to_string(&options.file)
            .ok()
            .and_then(|text| serde_json::from_str::<Link>(&text).ok())
            .filter(Link::is_valid);
        let state = Mutex::new(State { link, ..State::default() });
        ConnectAccount { inner: Arc::new(Inner { options, state }) }
    }

    pub fn link(&self) -> Option<Link> {
        self.inner.state.lock().link.clone()
    }

    pub fn login(&self) -> Option<LoginView> {
        self.inner.state.lock().login.clone()
    }

    /// Stores `link` in the file with mode 0600 (or removes the file for `None`) and notifies.
    pub fn adopt(&self, link: Option<Link>) -> Result<(), ConnectError> {
        let file = &self.inner.options.file;
        let io = |e: std::io::Error| ConnectError(e.to_string());
        match &link {
            None => match std::fs::remove_file(file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(io(e)),
                _ => {}
            },
            Some(link) => {
                if !link.is_valid() {
                    return Err(ConnectError::new("invalid bb connect link"));
                }
                let content = serde_json::to_string_pretty(link).map_err(|e| io(e.into()))? + "\n";
                let mut tmp = file.clone().into_os_string();
                tmp.push(".tmp");
                let tmp = PathBuf::from(tmp);
                write_private(&tmp, content.as_bytes()).map_err(io)?;
                std::fs::rename(&tmp, file).map_err(io)?;
            }
        }
        self.inner.state.lock().link = link;
        (self.inner.options.on_change)();
        Ok(())
    }

    /// Starts the device sign-in (or returns the pending one) and polls for approval in the
    /// background.
    pub async fn start_login(&self) -> Result<LoginView, ConnectError> {
        if let Some(login) = self.login().filter(|l| l.state == LoginState::Pending) {
            return Ok(login);
        }
        let options = &self.inner.options;
        let started = hosted::start_link(&options.base_url, &options.client_name).await?;
        let (attempt, login) = {
            let mut state = self.inner.state.lock();
            state.attempt += 1;
            let login = LoginView {
                state: LoginState::Pending,
                user_code: started.user_code.clone(),
                verification_url: started.verification_url.clone(),
                message: None,
            };
            state.login = Some(login.clone());
            (state.attempt, login)
        };
        (options.on_change)();
        let account = self.clone();
        tokio::spawn(async move {
            if let Err(error) = account.poll(started, attempt).await {
                account.settle(attempt, Some(error.to_string()));
            }
        });
        Ok(login)
    }

    /// Abandons a sign-in in progress.
    pub fn stop(&self) {
        self.inner.state.lock().attempt += 1;
    }

    pub async fn logout(&self) -> Result<LogoutResult, ConnectError> {
        let mut revoked = false;
        if let Some(link) = self.link() {
            match hosted::disconnect_server(&link.server_url, &link.credential).await {
                Ok(()) => revoked = true,
                Err(error) => {
                    (self.inner.options.warn)(&format!("sign-out was not confirmed: {error}"))
                }
            }
        }
        {
            let mut state = self.inner.state.lock();
            state.attempt += 1;
            state.login = None;
        }
        self.adopt(None)?;
        Ok(LogoutResult { revoked })
    }

    /// Signs out when the gate refused `credential` and getbb.app confirms it is no longer valid.
    pub async fn confirm_refused(&self, credential: &str) -> Result<(), ConnectError> {
        let Some(link) = self.link().filter(|link| link.credential == credential) else {
            return Ok(());
        };
        let profile = hosted::fetch_profile(&link.base_url, credential).await?;
        if profile != ProfileReply::Unauthorized || self.link().as_ref() != Some(&link) {
            return Ok(());
        }
        (self.inner.options.warn)("getbb.app no longer accepts this server; signed out");
        self.adopt(None)
    }

    fn current(&self, attempt: u64) -> bool {
        self.inner.state.lock().attempt == attempt
    }

    fn settle(&self, attempt: u64, message: Option<String>) {
        {
            let mut state = self.inner.state.lock();
            if state.attempt != attempt {
                return;
            }
            let Some(login) = state.login.as_mut() else { return };
            login.state = if message.is_none() { LoginState::SignedIn } else { LoginState::Failed };
            login.message = message;
        }
        (self.inner.options.on_change)();
    }

    async fn poll(&self, started: LinkStart, attempt: u64) -> Result<(), ConnectError> {
        let options = &self.inner.options;
        let base_url = &options.base_url;
        let mut interval = Duration::from_millis(started.interval_ms);
        while self.current(attempt) {
            tokio::time::sleep(interval + options.poll_margin).await;
            if !self.current(attempt) {
                return Ok(());
            }
            if now_ms() as f64 >= started.expires_at {
                self.settle(attempt, Some("The sign-in code expired.".to_string()));
                return Ok(());
            }
            let result =
                hosted::poll_link(base_url, &started.device_code).await.unwrap_or_else(|error| {
                    (options.warn)(&format!("waiting for sign-in approval: {error}"));
                    LinkPoll::Pending
                });
            let credential = match result {
                LinkPoll::Refused { message } => {
                    self.settle(attempt, Some(message));
                    return Ok(());
                }
                LinkPoll::SlowDown => {
                    interval = (interval + options.slow_down_step).min(MAX_POLL_INTERVAL);
                    continue;
                }
                LinkPoll::Pending => continue,
                LinkPoll::Approved { credential, .. } => credential,
            };
            let profile = match hosted::fetch_profile(base_url, &credential).await {
                Ok(ProfileReply::Profile(profile)) => profile,
                _ => {
                    self.settle(attempt, Some(UNCONFIRMED.to_string()));
                    return Ok(());
                }
            };
            self.settle(attempt, None);
            let server_url = profile.server_url.trim_end_matches('/').to_string();
            return self.adopt(Some(Link {
                base_url: base_url.clone(),
                server_url,
                server_id: profile.server_id,
                server_label: profile.server_label,
                credential,
            }));
        }
        Ok(())
    }
}

fn write_private(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        let mut file = options.open(path)?;
        file.write_all(content)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
    }
    #[cfg(not(unix))]
    {
        options.open(path)?.write_all(content)
    }
}
