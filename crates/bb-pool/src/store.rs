use std::collections::BTreeMap;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use base64::Engine;
use indexmap::IndexMap;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task::JoinHandle;

use crate::contract::{Account, AccountKind, AccountQuota, PoolProvider, ValidationError, is_uuid};
use crate::limits::EMPTY_QUOTA;

const ACCOUNTS_KEY: &str = "accounts:v1";
const STATE_FLUSH_DELAY_MS: u64 = 5_000;
pub const AFFINITY_IDLE_TTL_MS: i64 = 30 * 60 * 1_000;
const MAX_BINDINGS: usize = 4_096;

static HOST_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+$").expect("host id"));
static TOKEN_VALUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{43}$").expect("token value"));
static TOKEN_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^hub-token-.+\.json$").expect("token file"));

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Invalid(#[from] ValidationError),
}

pub type StoreResult<T> = Result<T, StoreError>;

#[async_trait]
pub trait PluginKv: Send + Sync {
    async fn get(&self, key: &str) -> Option<Value>;
    async fn set(&self, key: &str, value: Value);
    async fn delete(&self, key: &str);
    async fn list(&self, prefix: Option<&str>) -> Vec<String>;
}

#[derive(Debug, Default)]
pub struct MemoryKv {
    values: Mutex<BTreeMap<String, Value>>,
}

impl MemoryKv {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl PluginKv for MemoryKv {
    async fn get(&self, key: &str) -> Option<Value> {
        self.values.lock().get(key).cloned()
    }
    async fn set(&self, key: &str, value: Value) {
        self.values.lock().insert(key.to_string(), value);
    }
    async fn delete(&self, key: &str) {
        self.values.lock().remove(key);
    }
    async fn list(&self, prefix: Option<&str>) -> Vec<String> {
        let values = self.values.lock();
        values.keys().filter(|key| key.starts_with(prefix.unwrap_or(""))).cloned().collect()
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// A random RFC 9562 version 4 UUID, as `crypto.randomUUID()` returns.
pub fn random_uuid() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum AccountSecret {
    #[serde(rename = "oauth")]
    OAuth {
        access_token: String,
        refresh_token: String,
        expires_at: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id_token: Option<String>,
    },
    #[serde(rename = "api-key")]
    ApiKey { api_key: String },
}

impl AccountSecret {
    pub fn validate(&self) -> Result<(), ValidationError> {
        let ok = match self {
            AccountSecret::OAuth { access_token, refresh_token, expires_at, id_token } => {
                !access_token.is_empty()
                    && !refresh_token.is_empty()
                    && expires_at.is_none_or(|at| at > 0)
                    && id_token.as_deref().is_none_or(|token| !token.is_empty())
            }
            AccountSecret::ApiKey { api_key } => !api_key.is_empty(),
        };
        if ok { Ok(()) } else { Err(ValidationError("secret: Invalid input".into())) }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAccount {
    pub provider: PoolProvider,
    pub kind: AccountKind,
    pub label: String,
    pub email: Option<String>,
    pub account_uuid: Option<String>,
    pub codex_account_id: Option<String>,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
    pub enabled: bool,
    pub priority: i64,
}

async fn write_private(file: &Path, value: &impl Serialize) -> StoreResult<()> {
    let directory = file.parent().unwrap_or(Path::new("."));
    tokio::fs::DirBuilder::new().recursive(true).mode(0o700).create(directory).await?;
    tokio::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700)).await?;
    let temporary = PathBuf::from(format!("{}.{}.tmp", file.display(), random_uuid()));
    let text = format!("{}\n", serde_json::to_string(value)?);
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true).mode(0o600);
    let mut handle = options.open(&temporary).await?;
    tokio::io::AsyncWriteExt::write_all(&mut handle, text.as_bytes()).await?;
    drop(handle);
    tokio::fs::rename(&temporary, file).await?;
    Ok(())
}

async fn read_json(file: &Path) -> Option<Value> {
    let text = tokio::fs::read_to_string(file).await.ok()?;
    serde_json::from_str(&text).ok()
}

pub struct AccountStore {
    kv: Arc<dyn PluginKv>,
    directory: PathBuf,
    queue: tokio::sync::Mutex<()>,
}

impl AccountStore {
    pub fn new(kv: Arc<dyn PluginKv>, directory: impl Into<PathBuf>) -> Self {
        AccountStore { kv, directory: directory.into(), queue: tokio::sync::Mutex::new(()) }
    }

    pub async fn list(&self) -> StoreResult<Vec<Account>> {
        let stored = self.kv.get(ACCOUNTS_KEY).await.unwrap_or(Value::Array(Vec::new()));
        let mut accounts: Vec<Account> = serde_json::from_value(stored)?;
        accounts.iter().try_for_each(Account::validate)?;
        accounts.sort_by_key(|account| account.priority);
        Ok(accounts)
    }

    pub async fn add(&self, input: NewAccount, secret: &AccountSecret) -> StoreResult<Account> {
        let account = Account {
            id: random_uuid(),
            provider: input.provider,
            kind: input.kind,
            label: input.label,
            email: input.email,
            account_uuid: input.account_uuid,
            codex_account_id: input.codex_account_id,
            subscription_type: input.subscription_type,
            rate_limit_tier: input.rate_limit_tier,
            enabled: input.enabled,
            priority: input.priority,
            created_at: now_ms(),
            last_used_at: None,
            last_used_host_id: None,
        };
        account.validate()?;
        self.write_secret(&account.id, secret).await?;
        let _turn = self.queue.lock().await;
        let mut accounts = self.list().await?;
        accounts.push(account.clone());
        self.save(&accounts).await?;
        Ok(account)
    }

    /// Applies `patch` to the account with `id` (the id itself cannot change); `None` if absent.
    pub async fn update(
        &self,
        id: &str,
        patch: impl FnOnce(&mut Account) + Send,
    ) -> StoreResult<Option<Account>> {
        let _turn = self.queue.lock().await;
        let mut accounts = self.list().await?;
        let Some(index) = accounts.iter().position(|account| account.id == id) else {
            self.save(&accounts).await?;
            return Ok(None);
        };
        let mut updated = accounts[index].clone();
        patch(&mut updated);
        updated.id = id.to_string();
        updated.validate()?;
        accounts[index] = updated.clone();
        self.save(&accounts).await?;
        Ok(Some(updated))
    }

    pub async fn remove(&self, id: &str) -> StoreResult<bool> {
        let _turn = self.queue.lock().await;
        let mut accounts = self.list().await?;
        let Some(index) = accounts.iter().position(|account| account.id == id) else {
            self.save(&accounts).await?;
            return Ok(false);
        };
        accounts.remove(index);
        match tokio::fs::remove_file(self.secret_path(id)?).await {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
        self.save(&accounts).await?;
        Ok(true)
    }

    pub async fn read_secret(&self, id: &str) -> StoreResult<AccountSecret> {
        let text = tokio::fs::read_to_string(self.secret_path(id)?).await?;
        let secret: AccountSecret = serde_json::from_str(&text)?;
        secret.validate()?;
        Ok(secret)
    }

    pub async fn write_secret(&self, id: &str, secret: &AccountSecret) -> StoreResult<()> {
        secret.validate()?;
        write_private(&self.secret_path(id)?, secret).await
    }

    fn secret_path(&self, id: &str) -> StoreResult<PathBuf> {
        if !is_uuid(id) {
            return Err(ValidationError("id: Invalid UUID".into()).into());
        }
        Ok(self.directory.join(format!("account-{id}.json")))
    }

    async fn save(&self, accounts: &[Account]) -> StoreResult<()> {
        self.kv.set(ACCOUNTS_KEY, serde_json::to_value(accounts)?).await;
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HubToken {
    host_id: String,
    value: String,
    minted_at: u64,
}

impl HubToken {
    fn valid(&self) -> bool {
        HOST_ID.is_match(&self.host_id) && TOKEN_VALUE.is_match(&self.value)
    }
}

pub struct HubTokens {
    directory: PathBuf,
    tokens: Mutex<BTreeMap<String, String>>,
}

impl HubTokens {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        HubTokens { directory: directory.into(), tokens: Mutex::new(BTreeMap::new()) }
    }

    pub async fn load(&self) {
        let Ok(mut entries) = tokio::fs::read_dir(&self.directory).await else { return };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !TOKEN_FILE.is_match(&name) {
                continue;
            }
            let stored = read_json(&entry.path()).await;
            let token = stored.and_then(|value| serde_json::from_value::<HubToken>(value).ok());
            if let Some(token) = token.filter(HubToken::valid) {
                self.tokens.lock().insert(token.host_id, token.value);
            }
        }
    }

    pub async fn for_host(&self, host_id: &str) -> StoreResult<String> {
        if let Some(existing) = self.tokens.lock().get(host_id) {
            return Ok(existing.clone());
        }
        let bytes: [u8; 32] = rand::random();
        let value = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        let token =
            HubToken { host_id: host_id.into(), value: value.clone(), minted_at: now_ms() as u64 };
        if !token.valid() {
            return Err(ValidationError("hostId: Invalid string".into()).into());
        }
        self.tokens.lock().insert(host_id.into(), value.clone());
        write_private(&self.directory.join(format!("hub-token-{host_id}.json")), &token).await?;
        Ok(value)
    }

    /// The host whose token equals `presented`, compared in constant time against every token.
    pub fn authenticate(&self, presented: Option<&str>) -> Option<String> {
        let given = presented.unwrap_or("").as_bytes();
        let mut matched = None;
        for (host_id, value) in self.tokens.lock().iter() {
            let expected = value.as_bytes();
            if expected.len() == given.len() {
                let difference = expected.iter().zip(given).fold(0u8, |acc, (a, b)| acc | (a ^ b));
                if difference == 0 {
                    matched = Some(host_id.clone());
                }
            }
        }
        matched
    }

    pub fn host_ids(&self) -> Vec<String> {
        self.tokens.lock().keys().cloned().collect()
    }
}

#[derive(Debug, Clone)]
struct StoredBinding {
    account_id: String,
    last_used_at: i64,
}

#[derive(Default)]
struct StateData {
    active: IndexMap<PoolProvider, String>,
    bindings: IndexMap<String, StoredBinding>,
    quotas: IndexMap<String, AccountQuota>,
    timer: Option<JoinHandle<()>>,
}

#[derive(Serialize, Deserialize)]
struct StoredState {
    quotas: IndexMap<String, AccountQuota>,
    bindings: Vec<(String, String, serde_json::Number)>,
    active: IndexMap<PoolProvider, String>,
}

struct StateInner {
    file: PathBuf,
    data: Mutex<StateData>,
}

/// Quota, session bindings and the current account per provider, flushed to `file` 5 s after a change.
#[derive(Clone)]
pub struct PoolState {
    inner: Arc<StateInner>,
}

impl PoolState {
    pub fn new(file: impl Into<PathBuf>) -> Self {
        let inner = StateInner { file: file.into(), data: Mutex::new(StateData::default()) };
        PoolState { inner: Arc::new(inner) }
    }

    pub async fn load(&self) {
        let Some(value) = read_json(&self.inner.file).await else { return };
        let Ok(stored) = serde_json::from_value::<StoredState>(value) else { return };
        if stored.quotas.values().any(|quota| quota.validate().is_err()) {
            return;
        }
        let cutoff = now_ms() - AFFINITY_IDLE_TTL_MS;
        let mut data = self.inner.data.lock();
        data.quotas.extend(stored.quotas);
        for (key, account_id, last_used_at) in stored.bindings {
            let last_used_at = last_used_at.as_f64().unwrap_or(f64::NEG_INFINITY);
            if last_used_at > cutoff as f64 {
                let binding = StoredBinding { account_id, last_used_at: last_used_at as i64 };
                data.bindings.insert(key, binding);
            }
        }
        for provider in PoolProvider::ALL {
            if let Some(account_id) = stored.active.get(&provider) {
                data.active.insert(provider, account_id.clone());
            }
        }
    }

    pub fn quota(&self, account_id: &str) -> AccountQuota {
        self.inner.data.lock().quotas.get(account_id).cloned().unwrap_or(EMPTY_QUOTA)
    }

    pub fn set_quota(&self, account_id: &str, quota: Option<AccountQuota>) {
        {
            let mut data = self.inner.data.lock();
            match quota {
                None => {
                    data.quotas.shift_remove(account_id);
                }
                Some(quota) => {
                    data.quotas.insert(account_id.to_string(), quota);
                }
            }
        }
        self.touch();
    }

    pub fn bound_account(&self, key: Option<&str>) -> Option<String> {
        let data = self.inner.data.lock();
        let binding = data.bindings.get(key?)?;
        let idle = now_ms() - binding.last_used_at;
        (idle < AFFINITY_IDLE_TTL_MS).then(|| binding.account_id.clone())
    }

    pub fn bind(&self, key: &str, account_id: &str) {
        {
            let mut data = self.inner.data.lock();
            data.bindings.shift_remove(key);
            let binding = StoredBinding { account_id: account_id.into(), last_used_at: now_ms() };
            data.bindings.insert(key.into(), binding);
            while data.bindings.len() > MAX_BINDINGS {
                data.bindings.shift_remove_index(0);
            }
        }
        self.touch();
    }

    pub fn active(&self, provider: PoolProvider) -> Option<String> {
        self.inner.data.lock().active.get(&provider).cloned()
    }

    /// Sets the current account for `provider` without scheduling a flush (as `active.set` in the TS).
    pub fn set_active(&self, provider: PoolProvider, account_id: &str) {
        self.inner.data.lock().active.insert(provider, account_id.into());
    }

    pub fn touch(&self) {
        let mut data = self.inner.data.lock();
        if data.timer.is_some() {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
        let weak: Weak<StateInner> = Arc::downgrade(&self.inner);
        data.timer = Some(runtime.spawn(async move {
            tokio::time::sleep(Duration::from_millis(STATE_FLUSH_DELAY_MS)).await;
            let Some(inner) = weak.upgrade() else { return };
            inner.data.lock().timer = None;
            let _ = PoolState { inner }.write().await;
        }));
    }

    pub async fn flush(&self) -> StoreResult<()> {
        if let Some(timer) = self.inner.data.lock().timer.take() {
            timer.abort();
        }
        self.write().await
    }

    async fn write(&self) -> StoreResult<()> {
        let stored = {
            let data = self.inner.data.lock();
            StoredState {
                quotas: data.quotas.clone(),
                bindings: data
                    .bindings
                    .iter()
                    .map(|(key, b)| (key.clone(), b.account_id.clone(), b.last_used_at.into()))
                    .collect(),
                active: data.active.clone(),
            }
        };
        write_private(&self.inner.file, &stored).await
    }
}
