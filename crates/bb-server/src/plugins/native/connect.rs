//! The connect plugin (`plugins/connect/src/server.ts`): remote access through getbb.app,
//! shared ports, machine credentials for remote hosts.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, OnceLock, Weak};

use async_trait::async_trait;
use bb_connect::hosted::{MACHINE_HEADER, mint_machine, revoke_machine};
use bb_connect::{
    AccountOptions, ConnectAccount, ConnectError, ConnectStatus, ConnectTunnel, Link, LoginState,
    PortInput, SetEnabledInput, ShareView, TunnelOptions, legacy_link, share_url,
};
use bb_tunnel::TunnelLog;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::plugins::api::{
    CliContext, CliResult, MachineAccess, MachineAccessProvider, NativePlugin, PluginError,
    PluginResult, RpcFailure, RpcHandler, ThreadContext,
};
use crate::plugins::cli::{
    CliCommand, CliInput, CliOption, CliOutcome, CliPositional, CliSpec, PluginCliError, define_cli,
};
use crate::plugins::instance::{PluginApi, PluginKv, PluginLog};

pub const DEFAULT_BASE_URL: &str = "https://getbb.app";
pub const BASE_URL_ENV: &str = "BB_CONNECT_BASE_URL";
const STATUS_CHANNEL: &str = "status";
const SHARES_KEY: &str = "shares";
const ENABLED_KEY: &str = "enabled";
const JSON_DESCRIPTION: &str = "Emit machine-readable JSON";
const LEGACY_WARNING: &str = "STOP THE ORIGINAL bb SERVER FIRST. getbb.app allows one tunnel per \
     server label: while the original server runs, this one and that one \
     keep disconnecting each other and every machine with them.";
const REMOTE_THREAD: &str = "This thread runs on another machine. bb connect only shares ports of \
     the machine that runs the bb server.";

/// The native connect plugin. The hosted service is `BB_CONNECT_BASE_URL` or getbb.app.
pub struct ConnectPlugin {
    base_url: String,
}

impl ConnectPlugin {
    pub fn new() -> Self {
        let base_url = std::env::var(BASE_URL_ENV).unwrap_or_else(|_| DEFAULT_BASE_URL.to_owned());
        Self { base_url }
    }

    pub fn with_base_url(base_url: impl Into<String>) -> Self {
        Self { base_url: base_url.into() }
    }
}

impl Default for ConnectPlugin {
    fn default() -> Self {
        Self::new()
    }
}

type Grant = Shared<BoxFuture<'static, Result<MachineAccess, String>>>;

struct Outcome {
    text: String,
    json: Option<Value>,
}

#[derive(Clone, Copy)]
enum Act {
    Login,
    Show,
    Logout,
    On,
    Off,
    Share,
    Unshare,
    UnshareAll,
    List,
}

struct Connect {
    api: PluginApi,
    kv: PluginKv,
    enabled: Mutex<bool>,
    shares: Arc<Mutex<BTreeSet<u16>>>,
    remote_threads: Mutex<HashSet<String>>,
    grants: Mutex<HashMap<String, Grant>>,
    grants_credential: Mutex<Option<String>>,
    server_host_id: Option<String>,
    account: OnceLock<ConnectAccount>,
    tunnel: OnceLock<ConnectTunnel>,
}

fn describe(status: &ConnectStatus) -> String {
    let login = status.login.as_ref();
    if let Some(login) = login.filter(|login| login.state == LoginState::Pending) {
        return format!("Confirm the code {} at {}", login.user_code, login.verification_url);
    }
    if !status.paired {
        let failure = match login {
            Some(login) if login.state == LoginState::Failed => {
                format!(" ({})", login.message.as_deref().unwrap_or("null"))
            }
            _ => String::new(),
        };
        return format!("Not signed in{failure}. Run `bb connect login`.");
    }
    let state = match status.enabled {
        true => json!(status.state).as_str().unwrap_or_default().to_owned(),
        false => "off".to_owned(),
    };
    let error = status.last_error.as_ref().map(|e| format!("  ({e})")).unwrap_or_default();
    let null = || "null".to_owned();
    let handle = status.handle.clone().unwrap_or_else(null);
    let url = status.url.clone().unwrap_or_else(null);
    let mut lines = vec![format!("{handle}  {url}  {state}{error}")];
    for share in &status.shares {
        lines.push(format!("  {}  {}", share.port, share.url.clone().unwrap_or_else(null)));
    }
    lines.join("\n")
}

fn reply(json: bool, value: &Value, text: &str) -> CliOutcome {
    let stdout = match json {
        true => serde_json::to_string_pretty(value).unwrap_or_default(),
        false => text.to_owned(),
    };
    Ok(CliResult { exit_code: 0, stdout: format!("{stdout}\n"), stderr: String::new() })
}

/// `Number(text)` as JavaScript formats it back.
fn js_number(text: &str) -> f64 {
    let trimmed = text.trim();
    match trimmed {
        "" => 0.0,
        _ => trimmed.parse().unwrap_or(f64::NAN),
    }
}

fn js_display(number: f64) -> String {
    match number {
        n if n.is_nan() => "NaN".to_owned(),
        n if n.is_finite() && n.fract() == 0.0 => format!("{}", n as i64),
        n => n.to_string(),
    }
}

fn as_port(number: f64) -> Option<u16> {
    let valid = number.fract() == 0.0 && (0.0..=65_535.0).contains(&number);
    valid.then_some(number as u16)
}

/// The port of a URL as `Number(new URL(url).port)`: 0 when it has none.
fn port_of(url: &str) -> u16 {
    url::Url::parse(url).ok().and_then(|url| url.port()).unwrap_or(0)
}

fn cli_failure(error: impl std::fmt::Display) -> PluginCliError {
    PluginCliError::new(error.to_string())
}

impl Connect {
    fn account(&self) -> &ConnectAccount {
        self.account.get().expect("account is set at start")
    }

    fn tunnel(&self) -> &ConnectTunnel {
        self.tunnel.get().expect("tunnel is set at start")
    }

    fn publish(&self) {
        self.api.realtime_publish(STATUS_CHANNEL, Value::Null);
    }

    fn active_link(&self) -> Option<Link> {
        match *self.enabled.lock() {
            true => self.account().link(),
            false => None,
        }
    }

    fn sync(&self) {
        // The account may report a change before `start` has finished wiring the tunnel.
        if self.account.get().is_none() || self.tunnel.get().is_none() {
            return;
        }
        let link = self.active_link();
        let credential = self.account().link().map(|link| link.credential);
        {
            let mut known = self.grants_credential.lock();
            if *known != credential {
                self.grants.lock().clear();
            }
            *known = credential;
        }
        self.tunnel().set(link.clone());
        self.api.set_public_url(link.map(|link| link.server_url));
        self.publish();
    }

    fn status(&self) -> ConnectStatus {
        let tunnel = self.tunnel().status();
        let link = self.account().link();
        let shares = self.shares.lock().iter().copied().collect::<Vec<_>>();
        ConnectStatus {
            state: tunnel.state,
            last_error: tunnel.last_error,
            next_retry_at: tunnel.next_retry_at,
            paired: link.is_some(),
            enabled: *self.enabled.lock(),
            handle: link.as_ref().map(|link| link.server_label.clone()),
            url: link.as_ref().map(|link| link.server_url.clone()),
            login: self.account().login(),
            shares: shares
                .into_iter()
                .map(|port| ShareView { port, url: link.as_ref().map(|l| share_url(l, port)) })
                .collect(),
        }
    }

    fn status_json(&self) -> Value {
        serde_json::to_value(self.status()).unwrap_or(Value::Null)
    }

    fn set_enabled(&self, next: bool) -> Result<(), String> {
        *self.enabled.lock() = next;
        self.kv.set(ENABLED_KEY, &json!(next)).map_err(|e| e.to_string())?;
        self.sync();
        Ok(())
    }

    fn save_shares(&self) -> Result<(), String> {
        let ports = self.shares.lock().iter().copied().collect::<Vec<_>>();
        self.kv.set(SHARES_KEY, &json!(ports)).map_err(|e| e.to_string())?;
        self.publish();
        Ok(())
    }

    fn expose(&self, port: f64, thread_id: Option<&str>) -> Result<String, PluginCliError> {
        let Some(link) = self.account().link() else {
            let message = "this bb isn't signed in; run `bb connect login` first";
            return Err(PluginCliError::new(message).code("not_paired"));
        };
        let own_port = port_of(&self.api.server_url);
        let valid = as_port(port).filter(|port| *port >= 1 && *port != own_port);
        let Some(valid) = valid else {
            let message = format!(
                "Cannot share port {}: expected a TCP port other than bb's own",
                js_display(port)
            );
            return Err(PluginCliError::new(message).code("invalid_port"));
        };
        if thread_id.is_some_and(|id| self.remote_threads.lock().contains(id)) {
            return Err(PluginCliError::new(REMOTE_THREAD).code("remote_machine"));
        }
        self.shares.lock().insert(valid);
        self.save_shares().map_err(cli_failure)?;
        Ok(share_url(&link, valid))
    }

    fn unexpose(&self, ports: &[f64]) -> Result<Outcome, String> {
        let removed = {
            let mut shares = self.shares.lock();
            ports.iter().filter(|port| as_port(**port).is_some_and(|p| shares.remove(&p))).count()
        };
        self.save_shares()?;
        let text = format!("Revoked {removed} shared ports.");
        Ok(Outcome { text, json: Some(json!({ "removed": removed })) })
    }

    async fn act(
        &self,
        act: Act,
        port: f64,
        context: &CliContext,
    ) -> Result<Outcome, PluginCliError> {
        let shown = |connect: &Self| Outcome { text: describe(&connect.status()), json: None };
        match act {
            Act::Login => self.account().start_login().await.map(drop).map_err(cli_failure)?,
            Act::Logout => self.account().logout().await.map(drop).map_err(cli_failure)?,
            Act::Show => {}
            Act::On => self.set_enabled(true).map_err(cli_failure)?,
            Act::Off => self.set_enabled(false).map_err(cli_failure)?,
            Act::Share => {
                let url = self.expose(port, context.thread_id.as_deref())?;
                let json = json!({ "port": port as u16, "url": url });
                return Ok(Outcome { text: url, json: Some(json) });
            }
            Act::Unshare => return self.unexpose(&[port]).map_err(cli_failure),
            Act::UnshareAll => {
                let all =
                    self.shares.lock().iter().map(|port| f64::from(*port)).collect::<Vec<_>>();
                return self.unexpose(&all).map_err(cli_failure);
            }
            Act::List => {
                let status = self.status();
                let json = serde_json::to_value(&status.shares).ok();
                return Ok(Outcome { text: describe(&status), json });
            }
        }
        Ok(shown(self))
    }

    async fn run_command(&self, act: Act, input: CliInput, context: CliContext) -> CliOutcome {
        let port = js_number(input.positional("port").unwrap_or(""));
        let Outcome { text, json } = self.act(act, port, &context).await?;
        let json = json.unwrap_or_else(|| self.status_json());
        reply(input.flag("json"), &json, &text)
    }

    fn import_legacy(&self, input: CliInput, context: CliContext) -> CliOutcome {
        if !input.flag("yes") {
            let hint = "Re-run with --yes once it is stopped.";
            return Err(PluginCliError::new(LEGACY_WARNING)
                .code("confirmation_required")
                .hint(hint));
        }
        let cwd = context.cwd.unwrap_or_else(|| ".".to_owned());
        let path = Path::new(&cwd).join(input.string("db").unwrap_or_default());
        let path = std::path::absolute(&path).unwrap_or(path);
        let link = legacy_link(&path).map_err(cli_failure)?;
        self.account().adopt(Some(link)).map_err(cli_failure)?;
        let text = format!("{LEGACY_WARNING}\n\n{}", describe(&self.status()));
        reply(input.flag("json"), &self.status_json(), &text)
    }

    fn instructions(&self, context: &ThreadContext) -> Option<String> {
        let elsewhere =
            context.host_id.as_ref().is_some_and(|host| Some(host) != self.server_host_id.as_ref());
        match elsewhere {
            true => self.remote_threads.lock().insert(context.thread_id.clone()),
            false => self.remote_threads.lock().remove(&context.thread_id),
        };
        let link = self.active_link().filter(|_| !elsewhere)?;
        Some(format!(
            "The user can reach this bb remotely at {}. When you \
             start an HTTP server they should see, run `bb connect expose <port>` \
             and give them the URL it prints as a markdown link; a localhost URL \
             does not open remotely.",
            link.server_url
        ))
    }

    async fn rpc(&self, method: &str, input: Value) -> Result<Value, RpcFailure> {
        let invalid = |error: serde_json::Error| RpcFailure::invalid_input(error.to_string());
        let handler = |error: String| RpcFailure::handler(error);
        let takes_null = matches!(method, "status" | "login" | "logout");
        if takes_null && !input.is_null() {
            let received = match input {
                Value::Bool(_) => "boolean",
                Value::Number(_) => "number",
                Value::String(_) => "string",
                Value::Array(_) => "array",
                _ => "object",
            };
            return Err(RpcFailure::invalid_input(format!("Expected null, received {received}")));
        }
        match method {
            "login" => {
                self.account().start_login().await.map(drop).map_err(|e| e.0).map_err(handler)?
            }
            "logout" => {
                self.account().logout().await.map(drop).map_err(|e| e.0).map_err(handler)?
            }
            "setEnabled" => {
                let input: SetEnabledInput = serde_json::from_value(input).map_err(invalid)?;
                self.set_enabled(input.enabled).map_err(handler)?;
            }
            "unexpose" => {
                let input: PortInput = serde_json::from_value(input).map_err(invalid)?;
                self.unexpose(&[input.port]).map_err(handler)?;
            }
            _ => {}
        }
        Ok(self.status_json())
    }

    async fn grant_machine(
        self: Arc<Self>,
        link: Link,
        host_id: String,
    ) -> Result<MachineAccess, String> {
        let machine = mint_machine(&link.base_url, &link.credential).await.map_err(|e| e.0)?;
        let stored = json!({ "machineId": machine.machine_id });
        self.kv.set(&format!("machine:{host_id}"), &stored).map_err(|e| e.to_string())?;
        let headers = IndexMap::from([(MACHINE_HEADER.to_owned(), machine.credential)]);
        Ok(MachineAccess { server_url: link.server_url, headers })
    }
}

struct Rpc {
    connect: Arc<Connect>,
    method: &'static str,
}

#[async_trait]
impl RpcHandler for Rpc {
    async fn call(&self, input: Value) -> Result<Value, RpcFailure> {
        self.connect.rpc(self.method, input).await
    }
}

struct Machines(Arc<Connect>);

#[async_trait]
impl MachineAccessProvider for Machines {
    async fn grant(&self, host_id: &str) -> PluginResult<Option<MachineAccess>> {
        let Some(link) = self.0.active_link() else { return Ok(None) };
        let granting = {
            let mut grants = self.0.grants.lock();
            let connect = self.0.clone();
            let fresh = || connect.grant_machine(link, host_id.to_owned()).boxed().shared();
            grants.entry(host_id.to_owned()).or_insert_with(fresh).clone()
        };
        match granting.await {
            Ok(access) => Ok(Some(access)),
            Err(message) => {
                self.0.grants.lock().remove(host_id);
                Err(PluginError::new(message))
            }
        }
    }

    async fn revoke(&self, host_id: &str, connect_machine_id: Option<&str>) -> PluginResult<()> {
        self.0.grants.lock().remove(host_id);
        let key = format!("machine:{host_id}");
        let stored = self.0.kv.get(&key)?;
        let stored = stored.as_ref().and_then(|value| value["machineId"].as_str());
        let link = self.0.account().link();
        let mut seen = HashSet::new();
        for machine_id in [stored, connect_machine_id] {
            let (Some(link), Some(machine_id)) = (&link, machine_id) else { continue };
            if !seen.insert(machine_id) {
                continue;
            }
            revoke_machine(&link.base_url, &link.credential, machine_id)
                .await
                .map_err(|error: ConnectError| PluginError::new(error.0))?;
        }
        self.0.kv.delete(&key)?;
        Ok(())
    }
}

struct Log(PluginLog);

impl TunnelLog for Log {
    fn info(&self, message: &str) {
        self.0.info(message);
    }

    fn warn(&self, message: &str) {
        self.0.warn(message);
    }
}

fn command(connect: &Arc<Connect>, summary: &str, act: Act, port: bool) -> CliCommand {
    let connect = connect.clone();
    let run = move |input: CliInput, context: CliContext| {
        let connect = connect.clone();
        async move { connect.run_command(act, input, context).await }
    };
    let command = CliCommand::new(summary, run);
    let command = match port {
        true => command
            .positional(CliPositional::new("port", "TCP port on the server machine").required()),
        false => command,
    };
    command.option("json", CliOption::boolean(JSON_DESCRIPTION))
}

fn cli(connect: &Arc<Connect>) -> CliSpec {
    let legacy = connect.clone();
    let import_legacy = CliCommand::new(
        "Adopt the bb connect credential of an original bb database",
        move |input, context| {
            let legacy = legacy.clone();
            async move { legacy.import_legacy(input, context) }
        },
    )
    .description(LEGACY_WARNING)
    .option("db", CliOption::string("Old bb.db").required())
    .option("yes", CliOption::boolean("The original bb is stopped"))
    .option("json", CliOption::boolean(JSON_DESCRIPTION));
    CliSpec::new("connect", "Reach this bb at its getbb.app address and share local ports")
        .command(
            "login",
            command(connect, "Sign this bb in to your getbb.app account", Act::Login, false),
        )
        .command("status", command(connect, "Show remote-access status", Act::Show, false))
        .command("logout", command(connect, "Sign out and close the tunnel", Act::Logout, false))
        .command("on", command(connect, "Turn remote access on", Act::On, false))
        .command(
            "off",
            command(connect, "Turn remote access off and stay signed in", Act::Off, false),
        )
        .command("expose", command(connect, "Share a port of the server machine", Act::Share, true))
        .command("unexpose", command(connect, "Stop sharing a port", Act::Unshare, true))
        .command(
            "unexpose-all",
            command(connect, "Stop sharing every port", Act::UnshareAll, false),
        )
        .command("shares", command(connect, "List shared ports", Act::List, false))
        .command("import-legacy", import_legacy)
}

fn server_host_id(hosts: &Value) -> Option<String> {
    let hosts = hosts.as_array()?;
    let host = hosts.iter().find(|host| host.get("machineProviderId") == Some(&Value::Null))?;
    host["id"].as_str().map(str::to_owned)
}

#[async_trait]
impl NativePlugin for ConnectPlugin {
    async fn start(&self, api: PluginApi) -> PluginResult<()> {
        let kv = api.kv();
        let enabled = kv.get(ENABLED_KEY)?.and_then(|value| value.as_bool()).unwrap_or(true);
        let stored = kv.get(SHARES_KEY)?.unwrap_or(Value::Null);
        let shares = stored.as_array().into_iter().flatten().filter_map(Value::as_f64);
        let shares = shares.filter_map(as_port).collect::<BTreeSet<_>>();
        let hosts = api.outward.hosts_list().await?;
        let connect = Arc::new(Connect {
            api: api.clone(),
            kv,
            enabled: Mutex::new(enabled),
            shares: Arc::new(Mutex::new(shares)),
            remote_threads: Mutex::new(HashSet::new()),
            grants: Mutex::new(HashMap::new()),
            grants_credential: Mutex::new(None),
            server_host_id: server_host_id(&hosts),
            account: OnceLock::new(),
            tunnel: OnceLock::new(),
        });
        let weak: Weak<Connect> = Arc::downgrade(&connect);

        let log = api.log.clone();
        let on_change = weak.clone();
        let mut client_name = crate::runners::hosts::host_name();
        client_name = client_name.chars().take(100).collect();
        let account = ConnectAccount::new(AccountOptions::new(
            api.server_data_dir.join("connect.json"),
            self.base_url.clone(),
            client_name,
            Arc::new(move |message: &str| log.warn(message)),
            Arc::new(move || {
                if let Some(connect) = on_change.upgrade() {
                    connect.sync();
                }
            }),
        ));
        let shares = connect.shares.clone();
        let refused = account.clone();
        let published = weak.clone();
        let tunnel = ConnectTunnel::new(TunnelOptions::new(
            api.server_url.clone(),
            Arc::new(move |port| shares.lock().contains(&port)),
            Arc::new(move |credential: String| {
                let account = refused.clone();
                Box::pin(async move { account.confirm_refused(&credential).await })
            }),
            Arc::new(Log(api.log.clone())),
            Arc::new(move || {
                if let Some(connect) = published.upgrade() {
                    connect.publish();
                }
            }),
        ));
        let _ = connect.account.set(account.clone());
        let _ = connect.tunnel.set(tunnel.clone());

        api.set_machine_access_provider(Some(Arc::new(Machines(connect.clone()))));
        let contributor = connect.clone();
        api.contribute_instructions(Arc::new(move |context| {
            let contributed = contributor.instructions(&context);
            Box::pin(async move { Ok(contributed) })
        }));
        for method in bb_connect::CONNECT_RPC_METHODS {
            api.rpc_register(method, Arc::new(Rpc { connect: connect.clone(), method }));
        }
        api.cli_register(define_cli(cli(&connect)))?;
        api.on_dispose(Box::new(move || {
            Box::pin(async move {
                account.stop();
                tunnel.set(None);
            })
        }));
        connect.sync();
        Ok(())
    }
}
