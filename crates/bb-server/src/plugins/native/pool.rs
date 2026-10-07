//! The Account Pooler plugin: `plugins/account-pool/src/server.ts` and `cli.ts`, in Rust.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Body;
use axum::extract::Request;
use axum::response::Response;
use bb_pool::contract::*;
use bb_pool::hub::{Changed, Hub, HubDeps, ReqwestUpstream, UpstreamClient};
use bb_pool::oauth::{
    AccountDraft, ConfigGetter, HttpClient, LoginDeps, Logins, ReqwestClient, default_home,
    import_account,
};
use bb_pool::store::{self, AccountSecret, AccountStore, HubTokens, NewAccount, PoolState};
use futures::FutureExt;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::plugins::api::*;
use crate::plugins::cli::*;
use crate::plugins::instance::{PluginApi, PluginKv};

const NEEDS_ACCOUNT: &str = "Add and enable a Claude or Codex account with `bb pool account add`.";
const CLAUDE_ROUTES: [&str; 2] = ["/v1/messages", "/v1/messages/count_tokens"];
const CODEX_ROUTES: [&str; 4] =
    ["/v1/responses", "/v1/images/generations", "/v1/images/edits", "/v1/alpha/search"];
const LOGIN_POLL_MS: u64 = 250;
const ADD_DESCRIPTION: &str = "--login prints the browser or device step and exits; finish it with `bb pool account login-complete` (Claude) or `bb pool account login-poll` (Codex).\n--import reads the provider's existing login on this bb server host (~/.claude or ~/.codex).";

/// The native Account Pooler. `default()` talks to the real providers; tests inject clients.
#[derive(Clone, Default)]
pub struct AccountPoolPlugin {
    clients: Option<(Arc<dyn UpstreamClient>, Arc<dyn HttpClient>)>,
    home: Option<PathBuf>,
}

impl AccountPoolPlugin {
    /// Proxied traffic goes through `upstream`; OAuth refreshes, usage and logins through `http`.
    pub fn with_clients(upstream: Arc<dyn UpstreamClient>, http: Arc<dyn HttpClient>) -> Self {
        Self { clients: Some((upstream, http)), home: None }
    }

    /// The home directory `--import` reads `~/.claude` and `~/.codex` from.
    pub fn with_home(mut self, home: impl Into<PathBuf>) -> Self {
        self.home = Some(home.into());
        self
    }
}

/// The server's KV rows behind the `bb_pool` store trait.
struct Kv(PluginKv);

#[async_trait]
impl store::PluginKv for Kv {
    async fn get(&self, key: &str) -> Option<Value> {
        self.0.get(key).ok().flatten()
    }
    async fn set(&self, key: &str, value: Value) {
        let _ = self.0.set(key, &value);
    }
    async fn delete(&self, key: &str) {
        let _ = self.0.delete(key);
    }
    async fn list(&self, prefix: Option<&str>) -> Vec<String> {
        self.0.list(prefix).unwrap_or_default()
    }
}

type PoolResult<T> = Result<T, String>;

struct Pool {
    kv: PluginKv,
    accounts: Arc<AccountStore>,
    tokens: Arc<HubTokens>,
    state: Arc<PoolState>,
    hub: Arc<Hub>,
    logins: Logins,
    config: Arc<Mutex<PoolConfig>>,
    changed: Changed,
    outward: Arc<dyn PluginOutward>,
    home: PathBuf,
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn missing(id: &str) -> String {
    format!("Account {id} does not exist.")
}

async fn adopt(
    accounts: &AccountStore,
    hub: &Hub,
    changed: &Changed,
    draft: AccountDraft,
    label: Option<String>,
    priority: i64,
) -> PoolResult<Account> {
    let secret = AccountSecret::from(draft.secret.clone());
    let account = accounts.add(draft.new_account(label, priority), &secret).await.map_err(text)?;
    hub.refresh_usage(Some(&account.id), true).await;
    changed();
    Ok(account)
}

impl Pool {
    async fn is_routed(&self, provider: PoolProvider) -> bool {
        let key = format!("routing.{}", provider.as_str());
        !matches!(self.kv.get(&key), Ok(Some(Value::Bool(false))))
    }

    async fn can_serve(&self, provider: PoolProvider) -> bool {
        if !self.is_routed(provider).await {
            return false;
        }
        for account in self.accounts.list().await.unwrap_or_default() {
            if !account.enabled || account.provider != provider {
                continue;
            }
            if self.accounts.read_secret(&account.id).await.is_ok() {
                return true;
            }
        }
        false
    }

    async fn status(&self) -> PoolResult<PoolStatus> {
        let hosts = self.outward.hosts_list().await.map_err(text)?;
        let hosts = hosts.as_array().cloned().unwrap_or_default();
        let host_name = |id: &str| {
            let host = hosts.iter().find(|host| host["id"].as_str() == Some(id))?;
            host["name"].as_str().map(str::to_owned)
        };
        let hosts = self.tokens.host_ids();
        Ok(PoolStatus {
            route: HUB_PATH.to_owned(),
            hosts: hosts
                .into_iter()
                .map(|host_id| PoolHost { host_name: host_name(&host_id), host_id })
                .collect(),
            accounts: self.hub.summary().await,
            routing: Routing {
                claude: self.is_routed(PoolProvider::Claude).await,
                codex: self.is_routed(PoolProvider::Codex).await,
            },
            config: self.config.lock().clone(),
        })
    }

    async fn add(&self, input: AccountAddInput) -> PoolResult<Account> {
        let AccountAddInput { provider, api_key, label, priority } = input;
        let Some(api_key) = api_key else {
            let draft = import_account(provider, &self.home).await.map_err(text)?;
            return adopt(&self.accounts, &self.hub, &self.changed, draft, label, priority).await;
        };
        if provider != PoolProvider::Claude {
            return Err("API keys are only supported for the claude provider.".into());
        }
        let added = NewAccount {
            provider,
            kind: AccountKind::ApiKey,
            label: label.unwrap_or_else(|| "Claude API key".into()),
            email: None,
            account_uuid: None,
            codex_account_id: None,
            subscription_type: None,
            rate_limit_tier: None,
            enabled: true,
            priority,
        };
        let secret = AccountSecret::ApiKey { api_key };
        let account = self.accounts.add(added, &secret).await.map_err(text)?;
        (self.changed)();
        Ok(account)
    }

    async fn update(
        &self,
        id: &str,
        enabled: Option<bool>,
        priority: Option<i64>,
    ) -> PoolResult<Account> {
        let patch = move |account: &mut Account| {
            if let Some(enabled) = enabled {
                account.enabled = enabled;
            }
            if let Some(priority) = priority {
                account.priority = priority;
            }
        };
        let account = self.accounts.update(id, patch).await.map_err(text)?;
        let account = account.ok_or_else(|| missing(id))?;
        if enabled == Some(true) {
            let cleared = AccountQuota { error: None, held_until: None, ..self.state.quota(id) };
            self.state.set_quota(id, Some(cleared));
            self.hub.refresh_usage(Some(id), true).await;
        }
        (self.changed)();
        Ok(account)
    }

    async fn remove(&self, id: &str) -> PoolResult<()> {
        if !self.accounts.remove(id).await.map_err(text)? {
            return Err(missing(id));
        }
        self.state.set_quota(id, None);
        (self.changed)();
        Ok(())
    }

    async fn refresh(&self, id: &str) -> PoolResult<()> {
        let listed = self.accounts.list().await.map_err(text)?;
        if !listed.iter().any(|account| account.id == id) {
            return Err(missing(id));
        }
        self.hub.refresh_usage(Some(id), true).await;
        (self.changed)();
        Ok(())
    }

    async fn set_routing(&self, provider: PoolProvider, enabled: bool) -> PoolResult<()> {
        let key = format!("routing.{}", provider.as_str());
        self.kv.set(&key, &Value::Bool(enabled)).map_err(text)?;
        (self.changed)();
        Ok(())
    }

    async fn set_threshold(&self, switch_threshold: f64) -> PoolResult<()> {
        let next = PoolConfig { switch_threshold, ..self.config.lock().clone() };
        next.validate().map_err(text)?;
        let stored = serde_json::to_value(&next).map_err(text)?;
        self.kv.set("config", &stored).map_err(text)?;
        *self.config.lock() = next;
        (self.changed)();
        Ok(())
    }
}

#[async_trait]
impl NativePlugin for AccountPoolPlugin {
    async fn start(&self, api: PluginApi) -> PluginResult<()> {
        let kv = api.kv();
        let stored = kv.get("config").map_err(|error| PluginError::new(error.to_string()))?;
        let config: PoolConfig = serde_json::from_value(stored.unwrap_or_else(|| json!({})))
            .map_err(|error| PluginError::new(error.to_string()))?;
        config.validate().map_err(|error| PluginError::new(error.0))?;
        let config = Arc::new(Mutex::new(config));
        let secrets = api.data_dir.join("secrets").join("accounts");
        let accounts = Arc::new(AccountStore::new(Arc::new(Kv(kv.clone())), &secrets));
        let tokens = Arc::new(HubTokens::new(&secrets));
        tokens.load().await;
        let state = Arc::new(PoolState::new(api.data_dir.join("state.json")));
        state.load().await;
        let (upstream, http) = match &self.clients {
            Some(clients) => clients.clone(),
            None => {
                let reqwest = |error: reqwest::Error| PluginError::new(error.to_string());
                let upstream: Arc<dyn UpstreamClient> =
                    Arc::new(ReqwestUpstream::new().map_err(reqwest)?);
                let http: Arc<dyn HttpClient> = Arc::new(ReqwestClient::new().map_err(reqwest)?);
                (upstream, http)
            }
        };
        let publisher = api.clone();
        let changed: Changed = Arc::new(move || {
            publisher.realtime_publish(ACCOUNTS_CHANGED, json!({}));
        });
        let shared = config.clone();
        let get_config: ConfigGetter = Arc::new(move || shared.lock().clone());
        let log = api.log.clone();
        let hub = Arc::new(Hub::new(HubDeps {
            accounts: accounts.clone(),
            tokens: tokens.clone(),
            state: state.clone(),
            config: get_config.clone(),
            http: http.clone(),
            upstream,
            warn: Arc::new(move |message: &str| log.warn(message)),
            changed: changed.clone(),
        }));
        let (stopping, flushing) = (hub.clone(), state.clone());
        api.on_dispose(Box::new(move || {
            async move {
                stopping.stopped().cancel();
                let _ = flushing.flush().await;
            }
            .boxed()
        }));

        let (adopting, adopt_hub, adopt_changed) = (accounts.clone(), hub.clone(), changed.clone());
        let add = Arc::new(move |draft: AccountDraft| {
            let (accounts, hub, changed) =
                (adopting.clone(), adopt_hub.clone(), adopt_changed.clone());
            async move { adopt(&accounts, &hub, &changed, draft, None, 100).await }.boxed()
        });
        let logins = Logins::new(LoginDeps { client: http, config: get_config, add });
        let pool = Arc::new(Pool {
            kv,
            accounts: accounts.clone(),
            tokens,
            state,
            hub: hub.clone(),
            logins,
            config,
            changed,
            outward: api.outward.clone(),
            home: self.home.clone().unwrap_or_else(default_home),
        });

        register_rpc(&api, &pool);
        api.cli_register(define_cli(pool_cli(&pool)))?;
        contribute(&api, &pool, "claude-code", PoolProvider::Claude, |token| {
            vec![
                server_path("ANTHROPIC_BASE_URL", HUB_PATH),
                literal("ANTHROPIC_AUTH_TOKEN", token),
                literal("ANTHROPIC_CUSTOM_HEADERS", &format!("x-bb-account-pool-token: {token}")),
                literal("ENABLE_TOOL_SEARCH", "true"),
                literal("_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL", "1"),
            ]
        });
        contribute(&api, &pool, "codex", PoolProvider::Codex, |token| {
            vec![
                server_path("CODEX_OPENAI_BASE_URL", &format!("{HUB_PATH}/v1")),
                literal("CODEX_POOL_AUTH_TOKEN", token),
            ]
        });

        let route = |method: &str, path: &str, provider: PoolProvider| {
            let handler = Arc::new(Proxy { hub: hub.clone(), provider });
            api.http_route(method, path, HttpAuth::None, handler);
        };
        for path in CLAUDE_ROUTES {
            route("POST", path, PoolProvider::Claude);
        }
        for path in CODEX_ROUTES {
            route("POST", path, PoolProvider::Codex);
        }
        route("GET", "/v1/models", PoolProvider::Codex);
        api.http_route("HEAD", "/api/hello", HttpAuth::None, Arc::new(Hello));
        let usage = hub.clone();
        api.background_service(
            "usage",
            Arc::new(move |signal| {
                let hub = usage.clone();
                async move {
                    hub.start(signal).await;
                    Ok(())
                }
                .boxed()
            }),
        );

        let listed = accounts.list().await.map_err(|error| PluginError::new(error.to_string()))?;
        if !listed.iter().any(|account| account.enabled) {
            api.needs_configuration(NEEDS_ACCOUNT);
        }
        Ok(())
    }
}

struct Proxy {
    hub: Arc<Hub>,
    provider: PoolProvider,
}

#[async_trait]
impl HttpHandler for Proxy {
    async fn handle(&self, request: Request) -> Response {
        self.hub.handle(request, self.provider).await
    }
}

struct Hello;

#[async_trait]
impl HttpHandler for Hello {
    async fn handle(&self, _: Request) -> Response {
        Response::new(Body::empty())
    }
}

fn literal(name: &str, value: &str) -> ProviderEnvEntry {
    ProviderEnvEntry { name: name.to_owned(), value: EnvValue::Literal(value.to_owned()) }
}

fn server_path(name: &str, path: &str) -> ProviderEnvEntry {
    let value = EnvValue::ServerPath { server_path: path.to_owned() };
    ProviderEnvEntry { name: name.to_owned(), value }
}

fn contribute(
    api: &PluginApi,
    pool: &Arc<Pool>,
    provider_id: &str,
    provider: PoolProvider,
    entries: fn(&str) -> Vec<ProviderEnvEntry>,
) {
    let pool = pool.clone();
    let contributor: EnvContributor = Arc::new(move |context: ThreadContext| {
        let pool = pool.clone();
        async move {
            let Some(host_id) = context.host_id else { return Ok(Vec::new()) };
            if !pool.can_serve(provider).await {
                return Ok(Vec::new());
            }
            let token = pool.tokens.for_host(&host_id).await;
            Ok(entries(&token.map_err(|error| PluginError::new(error.to_string()))?))
        }
        .boxed()
    });
    api.contribute_env(provider_id, contributor);
}

// RPC

type RpcFuture = BoxFuture<'static, Result<Value, RpcFailure>>;
type RpcMethod = fn(Arc<Pool>, Value) -> RpcFuture;

struct Rpc {
    pool: Arc<Pool>,
    call: RpcMethod,
}

#[async_trait]
impl RpcHandler for Rpc {
    async fn call(&self, input: Value) -> Result<Value, RpcFailure> {
        (self.call)(self.pool.clone(), input).await
    }
}

fn parse<T: DeserializeOwned>(input: Value) -> Result<T, RpcFailure> {
    serde_json::from_value(input).map_err(|error| RpcFailure::invalid_input(error.to_string()))
}

fn checked(result: Result<(), ValidationError>) -> Result<(), RpcFailure> {
    result.map_err(|error| RpcFailure::invalid_input(error.0))
}

fn output<T: Serialize>(result: PoolResult<T>) -> Result<Value, RpcFailure> {
    let value = result.map_err(RpcFailure::handler)?;
    let value = serde_json::to_value(value).map_err(|e| RpcFailure::handler(e.to_string()))?;
    Ok(js_numbers(value))
}

fn register_rpc(api: &PluginApi, pool: &Arc<Pool>) {
    let methods: [(&str, RpcMethod); 9] = [
        (RPC_STATUS, |pool, _| async move { output(pool.status().await) }.boxed()),
        (RPC_ACCOUNT_ADD, |pool, input| {
            async move {
                let input: AccountAddInput = parse(input)?;
                checked(input.validate())?;
                output(pool.add(input).await)
            }
            .boxed()
        }),
        (RPC_ACCOUNT_UPDATE, |pool, input| {
            async move {
                let input: AccountUpdateInput = parse(input)?;
                checked(input.validate())?;
                output(pool.update(&input.id, input.enabled, input.priority).await.map(|_| ()))
            }
            .boxed()
        }),
        (RPC_ACCOUNT_REFRESH, |pool, input| {
            async move {
                let input: AccountIdInput = parse(input)?;
                checked(input.validate())?;
                output(pool.refresh(&input.id).await)
            }
            .boxed()
        }),
        (RPC_ROUTING_SET, |pool, input| {
            async move {
                let input: RoutingSetInput = parse(input)?;
                output(pool.set_routing(input.provider, input.enabled).await)
            }
            .boxed()
        }),
        (RPC_CONFIG_SET, |pool, input| {
            async move {
                let input: ConfigSetInput = parse(input)?;
                checked(input.validate())?;
                output(pool.set_threshold(input.switch_threshold).await)
            }
            .boxed()
        }),
        (RPC_LOGIN_START, |pool, input| {
            async move {
                let input: ProviderInput = parse(input)?;
                output(pool.logins.start(input.provider).await.map_err(text))
            }
            .boxed()
        }),
        (RPC_LOGIN_COMPLETE, |pool, input| {
            async move {
                let mut input: LoginCompleteInput = parse(input)?;
                checked(input.validate())?;
                output(pool.logins.complete(&input.session_id, &input.code).await.map_err(text))
            }
            .boxed()
        }),
        (RPC_LOGIN_POLL, |pool, input| {
            async move {
                let input: SessionInput = parse(input)?;
                checked(input.validate())?;
                output(Ok(pool.logins.poll(&input.session_id).await))
            }
            .boxed()
        }),
    ];
    for (method, call) in methods {
        api.rpc_register(method, Arc::new(Rpc { pool: pool.clone(), call }));
    }
}

/// Whole `f64`s as integers, the way `JSON.stringify` prints numbers.
fn js_numbers(value: Value) -> Value {
    match value {
        Value::Number(number) => match number.as_f64() {
            Some(float)
                if !number.is_i64()
                    && !number.is_u64()
                    && float.fract() == 0.0
                    && float.abs() < 9_007_199_254_740_992.0 =>
            {
                Value::from(float as i64)
            }
            _ => Value::Number(number),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(js_numbers).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(key, item)| (key, js_numbers(item))).collect())
        }
        other => other,
    }
}

// CLI

fn invalid(message: &str) -> PluginCliError {
    PluginCliError::new(message).code("invalid_value")
}

fn reply(as_json: bool, value: impl Serialize, text: String) -> CliOutcome {
    let stdout = if as_json {
        let value = serde_json::to_value(value).map_err(|e| PluginCliError::new(e.to_string()))?;
        serde_json::to_string_pretty(&js_numbers(value))
            .map_err(|e| PluginCliError::new(e.to_string()))?
    } else {
        text
    };
    cli_output(format!("{stdout}\n"))
}

fn added(as_json: bool, account: Account) -> CliOutcome {
    let text = format!("Added {} ({}).", account.label, account.id);
    reply(as_json, json!({ "ok": true, "account": account }), text)
}

fn failed(message: String) -> PluginCliError {
    PluginCliError::new(message)
}

/// JavaScript's `Number(text)` for decimal input: blank is 0, anything unparsable is NaN.
fn js_number(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    let finite = trimmed.trim_start_matches(['+', '-']);
    if finite == "Infinity" {
        return if trimmed.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let decimal =
        finite.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'));
    if !decimal {
        return f64::NAN;
    }
    trimmed.parse().unwrap_or(f64::NAN)
}

/// `new Date(ms).toISOString()`.
fn iso_time(ms: i64) -> String {
    let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let (hour, minute) = (rest / 3_600_000, rest / 60_000 % 60);
    let (second, milli) = (rest / 1_000 % 60, rest % 1_000);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

fn format_window(window: &LimitWindow) -> String {
    let used = match window.utilization {
        None => "-".to_owned(),
        Some(utilization) => format!("{}%", (utilization * 100.0 + 0.5).floor() as i64),
    };
    let reset = window.reset_at.map_or_else(|| "-".to_owned(), iso_time);
    format!("{}={used} {reset}", window.key)
}

fn status_name(status: AccountStatus) -> String {
    serde_json::to_value(status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn format_accounts(accounts: &[AccountSummary]) -> String {
    if accounts.is_empty() {
        return "No accounts configured.".to_owned();
    }
    let rows = accounts.iter().map(|summary| {
        let account = &summary.account;
        let windows: Vec<String> = summary.quota.windows.iter().map(format_window).collect();
        let limits = if windows.is_empty() { "-".to_owned() } else { windows.join("; ") };
        let state = summary.quota.error.clone().unwrap_or_else(|| status_name(summary.status));
        let provider = account.provider.as_str();
        let priority = account.priority.to_string();
        [account.id.as_str(), &account.label, provider, &priority, &limits, &state].join("\t")
    });
    rows.collect::<Vec<_>>().join("\n")
}

fn format_status(status: &PoolStatus) -> String {
    let mut routed = Vec::new();
    if status.routing.claude {
        routed.push("claude");
    }
    if status.routing.codex {
        routed.push("codex");
    }
    let machines: Vec<&str> = status
        .hosts
        .iter()
        .map(|host| host.host_name.as_deref().unwrap_or(&host.host_id))
        .collect();
    let or =
        |list: String, fallback: &str| if list.is_empty() { fallback.to_owned() } else { list };
    [
        format!("Route: {}", status.route),
        format!("Routing: {}", or(routed.join(", "), "off")),
        format!("Switch threshold: {}", status.config.switch_threshold),
        format!("Machine tokens: {}", or(machines.join(", "), "none minted")),
        String::new(),
        format_accounts(&status.accounts),
    ]
    .join("\n")
}

async fn show_config(pool: &Pool, as_json: bool) -> CliOutcome {
    let config = pool.status().await.map_err(failed)?.config;
    let entries = js_numbers(serde_json::to_value(&config).map_err(|e| failed(e.to_string()))?);
    let lines: Vec<String> = entries
        .as_object()
        .into_iter()
        .flatten()
        .map(|(key, value)| match value {
            Value::String(text) => format!("{key}: {text}"),
            other => format!("{key}: {other}"),
        })
        .collect();
    reply(as_json, json!({ "ok": true, "config": config }), lines.join("\n"))
}

fn command<F, Fut>(pool: &Arc<Pool>, summary: &str, run: F) -> CliCommand
where
    F: Fn(Arc<Pool>, CliInput, CliContext) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = CliOutcome> + Send + 'static,
{
    let pool = pool.clone();
    CliCommand::new(summary, move |input, context| run(pool.clone(), input, context))
}

fn json_option() -> CliOption {
    CliOption::boolean("Emit JSON")
}

fn session_option() -> CliOption {
    CliOption::string("Session ID printed by `bb pool account add --login`").required()
}

fn account_id() -> CliPositional {
    CliPositional::new("id", "Account UUID from `bb pool account list`").required()
}

type AccountAct = fn(Arc<Pool>, String) -> BoxFuture<'static, PoolResult<Option<Account>>>;

fn account_command(
    pool: &Arc<Pool>,
    summary: &str,
    done: &'static str,
    act: AccountAct,
) -> CliCommand {
    command(pool, summary, move |pool, input, _| async move {
        let id = input.positional("id").unwrap_or_default().to_owned();
        let account = act(pool, id.clone()).await.map_err(failed)?;
        let value = json!({ "ok": true, "id": id, "account": account });
        reply(input.flag("json"), value, format!("{done} {id}."))
    })
    .positional(account_id())
    .option("json", json_option())
}

fn pool_cli(pool: &Arc<Pool>) -> CliSpec {
    let summary = "Manage Claude and Codex accounts and the Account Pooler hub";
    CliSpec::new("pool", summary)
        .command(
            "status",
            command(
                pool,
                "Show hub, routing, machine token and account status",
                |pool, input, _| async move {
                    let status = pool.status().await.map_err(failed)?;
                    let text = format_status(&status);
                    reply(input.flag("json"), status, text)
                },
            )
            .option("json", json_option()),
        )
        .command(
            "account list",
            command(pool, "List pool accounts and observed quota", |pool, input, _| async move {
                let accounts = pool.status().await.map_err(failed)?.accounts;
                let text = format_accounts(&accounts);
                reply(input.flag("json"), json!({ "accounts": accounts }), text)
            })
            .option("json", json_option()),
        )
        .command("account add", account_add(pool))
        .command(
            "account login-complete",
            command(
                pool,
                "Complete a Claude browser login with its manual code",
                |pool, input, _| async move {
                    let session = input.string("session").unwrap_or_default();
                    let code = input.string("code").unwrap_or_default();
                    let account = pool
                        .logins
                        .complete(session, code)
                        .await
                        .map_err(|e| failed(e.to_string()))?;
                    added(input.flag("json"), account)
                },
            )
            .option("session", session_option())
            .option(
                "code",
                CliOption::string("Code from the final login page; prefer --code-stdin").required(),
            )
            .option("json", json_option()),
        )
        .command(
            "account login-poll",
            command(
                pool,
                "Wait for a Codex device-code login to complete",
                |pool, input, context| async move {
                    let session = input.string("session").unwrap_or_default().to_owned();
                    loop {
                        tokio::select! {
                            () = context.cancel.cancelled() => {
                                return Err(failed("This operation was aborted".into()));
                            }
                            () = tokio::time::sleep(Duration::from_millis(LOGIN_POLL_MS)) => {}
                        }
                        match pool.logins.poll(&session).await {
                            LoginPoll::Complete { account } => {
                                return added(input.flag("json"), *account);
                            }
                            LoginPoll::Pending => continue,
                            LoginPoll::Error { message } => {
                                return Err(PluginCliError::new(message).code("login_failed"));
                            }
                        }
                    }
                },
            )
            .option("session", session_option())
            .option("json", json_option()),
        )
        .command(
            "account remove",
            account_command(
                pool,
                "Remove an account and its secret token file",
                "Removed",
                |pool, id| async move { pool.remove(&id).await.map(|()| None) }.boxed(),
            ),
        )
        .command(
            "account enable",
            account_command(
                pool,
                "Enable an account and clear its error",
                "Enabled",
                |pool, id| {
                    async move { pool.update(&id, Some(true), None).await.map(Some) }.boxed()
                },
            ),
        )
        .command(
            "account disable",
            account_command(pool, "Disable an account", "Disabled", |pool, id| {
                async move { pool.update(&id, Some(false), None).await.map(Some) }.boxed()
            }),
        )
        .command(
            "account priority",
            command(
                pool,
                "Set an account's position in the failover order",
                |pool, input, _| async move {
                    let priority = js_number(input.positional("priority").unwrap_or_default());
                    if !priority.is_finite() || priority.fract() != 0.0 {
                        return Err(invalid("Priority is a whole number."));
                    }
                    let id = input.positional("id").unwrap_or_default();
                    let account =
                        pool.update(id, None, Some(priority as i64)).await.map_err(failed)?;
                    let text = format!("Set {} priority to {}.", account.label, priority as i64);
                    reply(input.flag("json"), json!({ "ok": true, "account": account }), text)
                },
            )
            .positional(account_id())
            .positional(CliPositional::new("priority", "Lower runs first").required())
            .option("json", json_option()),
        )
        .command(
            "routing",
            command(
                pool,
                "Enable or disable pooled routing for one provider",
                |pool, input, _| async move {
                    let provider = match input.positional("provider") {
                        Some("claude") => PoolProvider::Claude,
                        Some("codex") => PoolProvider::Codex,
                        _ => return Err(invalid("Provider is claude or codex.")),
                    };
                    let enabled = !input.flag("off");
                    pool.set_routing(provider, enabled).await.map_err(failed)?;
                    let verb = if enabled { "Enabled" } else { "Disabled" };
                    let text = format!("{verb} {} routing.", provider.as_str());
                    let value = json!({ "ok": true, "provider": provider, "enabled": enabled });
                    reply(input.flag("json"), value, text)
                },
            )
            .positional(CliPositional::new("provider", "claude or codex").required())
            .option("off", CliOption::boolean("Disable instead of enable"))
            .option("json", json_option()),
        )
        .command(
            "config",
            command(pool, "Show Account Pooler configuration", |pool, input, _| async move {
                show_config(&pool, input.flag("json")).await
            })
            .option("json", json_option()),
        )
        .command(
            "config set",
            command(
                pool,
                "Set switchThreshold, the quota fraction at which accounts rotate",
                |pool, input, _| async move {
                    let value = js_number(input.positional("value").unwrap_or_default());
                    let valid = value > 0.0 && value <= 1.0;
                    if input.positional("key") != Some("switchThreshold") || !valid {
                        return Err(invalid(
                            "Use: bb pool config set switchThreshold <above 0, at most 1>",
                        ));
                    }
                    pool.set_threshold(value).await.map_err(failed)?;
                    show_config(&pool, input.flag("json")).await
                },
            )
            .positional(CliPositional::new("key", "switchThreshold").required())
            .positional(CliPositional::new("value", "Above 0, at most 1").required())
            .option("json", json_option()),
        )
}

fn account_add(pool: &Arc<Pool>) -> CliCommand {
    let summary = "Sign in to Claude or Codex, import credentials, or add an Anthropic API key";
    command(pool, summary, |pool, input, _| async move {
        let as_json = input.flag("json");
        let provider = match input.string("provider") {
            Some("codex") => PoolProvider::Codex,
            _ => PoolProvider::Claude,
        };
        let api_key = input.string("api-key").map(str::to_owned);
        let (login, import) = (input.flag("login"), input.flag("import"));
        let sources = [login, import, api_key.is_some()];
        if sources.iter().filter(|source| **source).count() != 1 {
            return Err(invalid("Pass exactly one of --login, --import or --api-key."));
        }
        if !login {
            let label = input.string("label").map(str::to_owned);
            let priority = input.integer("priority").unwrap_or(100);
            let account_input = AccountAddInput { provider, api_key, label, priority };
            return added(as_json, pool.add(account_input).await.map_err(failed)?);
        }
        let login = pool.logins.start(provider).await.map_err(|e| failed(e.to_string()))?;
        let session = &login.session_id;
        let finish = match &login.device {
            None => vec![
                "After signing in, pipe the code shown on the final page into:".to_owned(),
                format!("printf '%s\\n' \"$CLAUDE_AUTH_CODE\" | bb pool account login-complete --session {session} --code-stdin"),
            ],
            Some(device) => vec![
                format!("Enter this code: {}", device.user_code),
                "After authorizing, wait for the account to be added with:".to_owned(),
                format!("bb pool account login-poll --session {session}"),
            ],
        };
        let mut steps = vec![
            format!("Open this URL to sign in to {}:", provider.as_str()),
            login.url.clone(),
            String::new(),
            format!("Session ID: {session}"),
        ];
        steps.extend(finish);
        reply(as_json, json!({ "ok": true, "login": login }), steps.join("\n"))
    })
    .description(ADD_DESCRIPTION)
    .option(
        "provider",
        CliOption::enumeration(["claude", "codex"], "Provider this account belongs to").required(),
    )
    .option("login", CliOption::boolean("Start a browser or device login"))
    .option("import", CliOption::boolean("Import this host's login"))
    .option("api-key", CliOption::string("Anthropic API key; prefer --api-key-stdin"))
    .option("label", CliOption::string("Label shown in listings"))
    .option(
        "priority",
        CliOption::integer("Failover position; lower numbers run first").default_value(100),
    )
    .option("json", json_option())
}
