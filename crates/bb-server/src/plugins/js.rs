//! The QuickJS bridge for TypeScript plugin server halves.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Body;
use axum::extract::Request;
use axum::response::Response;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use bb_js::{JsError, JsRuntime, JsRuntimeOptions, NodeCompatOptions};
use futures::FutureExt;
use http_body_util::BodyExt;
use parking_lot::Mutex;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::api::{
    AgentTool, AgentToolResult, CliCommandSummary, CliContext, CliResult, EnvironmentDefinition,
    FileReadArgs, FileWriteArgs, HttpAuth, HttpHandler, InferenceService, InputRequest,
    MachineAccess, MachineAccessProvider, MentionItem, MentionProvider, MentionQuery, PluginCli,
    PluginError, PluginResult, ProviderEnvEntry, RpcFailure, RpcHandler, SettingDescriptors,
    ThreadContext, ToolFailure,
};
use super::instance::{PluginApi, SettingsHandle};

const GLUE: &str = include_str!("js/host.js");
const GLUE_MODULE: &str = "bb:plugin-host";
const PLUGIN_MODULE: &str = "bb:plugin";
const DATABASE: &str = "plugin";
const MEMORY_LIMIT: usize = 1024 * 1024 * 1024;

struct Bridge {
    rt: JsRuntime,
    api: PluginApi,
    settings: Mutex<Vec<SettingsHandle>>,
    signals: Mutex<HashMap<String, CancellationToken>>,
    next: AtomicU64,
}

type Shared = Arc<Bridge>;

fn plugin_error(error: JsError) -> PluginError {
    PluginError::new(error.message)
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| e.to_string())
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

impl Bridge {
    async fn call<T: DeserializeOwned>(&self, handler: &str, arg: Value) -> PluginResult<T> {
        let value = self.rt.call(handler, arg).await.map_err(plugin_error)?;
        decode(value).map_err(PluginError::new)
    }

    async fn call_cancellable(
        &self,
        handler: &str,
        mut arg: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, JsError> {
        let key = format!("signal:{}", self.next.fetch_add(1, Ordering::Relaxed));
        arg["signal"] = Value::String(key.clone());
        let done = CancellationToken::new();
        let watcher = {
            let (rt, done, cancel, key) = (self.rt.clone(), done.clone(), cancel.clone(), key);
            tokio::spawn(async move {
                tokio::select! {
                    () = done.cancelled() => {}
                    () = cancel.cancelled() => { let _ = rt.call("plugin:abort", json!(key)).await; }
                }
            })
        };
        let result = self.rt.call(handler, arg).await;
        done.cancel();
        drop(watcher);
        result
    }

    fn register(self: &Shared, arg: Value) -> Result<Value, String> {
        let api = &self.api;
        let handler = text(&arg, "handler");
        let adapter = || JsHandler { bridge: self.clone(), handler: handler.clone() };
        match arg["kind"].as_str().unwrap_or_default() {
            "settings.define" => {
                let descriptors: SettingDescriptors = decode(arg["descriptors"].clone())?;
                let mut handles = self.settings.lock();
                handles.push(api.settings_define(descriptors));
                return Ok(json!(handles.len() - 1));
            }
            "settings.onChange" => {
                let index = arg["handle"].as_u64().unwrap_or_default() as usize;
                let handles = self.settings.lock();
                let handle = handles.get(index).ok_or("unknown settings handle")?;
                let bridge = self.clone();
                handle.on_change(Arc::new(move |next, previous| {
                    let (bridge, handler) = (bridge.clone(), handler.clone());
                    let arg = json!({ "next": next, "previous": previous });
                    tokio::spawn(async move {
                        if let Err(e) = bridge.rt.call(&handler, arg).await {
                            bridge
                                .api
                                .log
                                .warn(&format!("settings listener failed: {}", e.message));
                        }
                    });
                }));
            }
            "database" => return Ok(json!(DATABASE)),
            "rpc" => api.rpc_register(&text(&arg, "method"), Arc::new(adapter())),
            "http" => {
                let auth = match arg["auth"].as_str() {
                    Some("token") => HttpAuth::Token,
                    Some("none") => HttpAuth::None,
                    _ => HttpAuth::Local,
                };
                api.http_route(
                    &text(&arg, "method"),
                    &text(&arg, "path"),
                    auth,
                    Arc::new(adapter()),
                );
            }
            "service" => {
                let bridge = self.clone();
                api.background_service(
                    &text(&arg, "name"),
                    Arc::new(move |cancel| {
                        let (bridge, handler) = (bridge.clone(), handler.clone());
                        async move {
                            bridge
                                .call_cancellable(&handler, json!({}), &cancel)
                                .await
                                .map(|_| ())
                                .map_err(plugin_error)
                        }
                        .boxed()
                    }),
                );
            }
            "cli" => {
                let commands = decode(arg["commands"].clone())?;
                let cli = JsCli {
                    inner: adapter(),
                    name: text(&arg, "name"),
                    summary: text(&arg, "summary"),
                    commands,
                };
                api.cli_register(Arc::new(cli)).map_err(|e| e.message)?;
            }
            "event" => {
                let inner = adapter();
                api.events_on(
                    &text(&arg, "name"),
                    Arc::new(move |payload| {
                        let inner = inner.clone();
                        async move {
                            inner.bridge.call::<Value>(&inner.handler, payload).await.map(|_| ())
                        }
                        .boxed()
                    }),
                );
            }
            "tool" => api.register_tool(Arc::new(JsTool { bridge: self.clone(), meta: arg })),
            "instructions" => {
                let inner = adapter();
                api.contribute_instructions(Arc::new(move |context| {
                    let inner = inner.clone();
                    async move { inner.bridge.call(&inner.handler, json!(context)).await }.boxed()
                }));
            }
            "mention" => api
                .register_mention_provider(Arc::new(JsMention { bridge: self.clone(), meta: arg })),
            "env" => {
                let inner = adapter();
                api.contribute_env(
                    &text(&arg, "providerId"),
                    Arc::new(move |context| {
                        let inner = inner.clone();
                        async move {
                            inner
                                .bridge
                                .call::<Vec<ProviderEnvEntry>>(&inner.handler, json!(context))
                                .await
                        }
                        .boxed()
                    }),
                );
            }
            "environment" => api.register_environment(decode::<EnvironmentDefinition>(arg)?),
            "inference" => {
                api.register_inference(Arc::new(JsInference { bridge: self.clone(), meta: arg }))
            }
            "needsConfiguration" => api.needs_configuration(&text(&arg, "message")),
            "machineAccess" => {
                let provider = (!arg["grant"].is_null()).then(|| {
                    Arc::new(JsMachineAccess { bridge: self.clone(), meta: arg })
                        as Arc<dyn MachineAccessProvider>
                });
                api.set_machine_access_provider(provider);
            }
            "publicUrl" => api.set_public_url(arg["url"].as_str().map(str::to_owned)),
            "dispose" => {
                let inner = adapter();
                api.on_dispose(Box::new(move || {
                    async move {
                        if let Err(e) = inner.bridge.rt.call(&inner.handler, Value::Null).await {
                            inner.bridge.api.log.warn(&format!("dispose failed: {}", e.message));
                        }
                    }
                    .boxed()
                }));
            }
            kind => return Err(format!("unknown plugin registration \"{kind}\"")),
        }
        Ok(Value::Null)
    }

    async fn outward(self: Shared, arg: Value) -> Result<Value, String> {
        let args = arg["args"].as_array().cloned().unwrap_or_default();
        let at = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        let id = |i: usize| at(i).as_str().unwrap_or_default().to_owned();
        let out = &self.api.outward;
        let json = |r: crate::error::ApiResult<Value>| r.map_err(|e| e.to_string());
        let method = arg["method"].as_str().unwrap_or_default().to_owned();
        match method.as_str() {
            "settings.get" | "settings.set" => {
                let index = at(0).as_u64().unwrap_or_default() as usize;
                let handle =
                    self.settings.lock().get(index).cloned().ok_or("unknown settings handle")?;
                let record = if method == "settings.get" {
                    handle.get().await
                } else {
                    handle.set(&decode(at(1))?).await
                };
                record.map(|r| json!(r)).map_err(|e| e.to_string())
            }
            "kv.get" => {
                let stored = self.api.kv().get(&id(0)).map_err(|e| e.to_string())?;
                Ok(match stored {
                    Some(Value::String(text)) => serde_json::from_str(&text).unwrap_or(Value::Null),
                    Some(value) => value,
                    None => Value::Null,
                })
            }
            "kv.set" => {
                let text = at(1).as_str().map(str::to_owned);
                let key = id(0);
                match text {
                    Some(text) if text.len() <= 256 * 1024 => {
                        let value: Value =
                            serde_json::from_str(&text).map_err(|e| e.to_string())?;
                        self.api
                            .kv()
                            .set(&key, &value)
                            .map(|_| Value::Null)
                            .map_err(|e| e.to_string())
                    }
                    _ => Err(format!("KV value for \"{key}\" is not JSON under 256 KiB")),
                }
            }
            "kv.delete" => {
                self.api.kv().delete(&id(0)).map(|_| Value::Null).map_err(|e| e.to_string())
            }
            "kv.list" => {
                let prefix = at(0).as_str().map(str::to_owned);
                self.api.kv().list(prefix.as_deref()).map(|k| json!(k)).map_err(|e| e.to_string())
            }
            "threads.spawn" => json(out.threads_spawn(at(0)).await),
            "threads.send" => json(out.threads_send(&id(0), at(1)).await),
            "threads.get" => json(out.threads_get(&id(0)).await.map(|t| t.unwrap_or(Value::Null))),
            "threads.list" => json(out.threads_list(at(0)).await),
            "threads.stop" => json(out.threads_stop(&id(0)).await.map(|_| Value::Null)),
            "threads.update" => json(out.threads_update(&id(0), at(1)).await),
            "threads.output" => json(out.threads_output(&id(0)).await.map(|o| json!(o))),
            "threads.events" => {
                json(out.threads_events(&id(0), at(1).as_i64()).await.map(|e| json!(e)))
            }
            "projects.list" => json(out.projects_list().await),
            "hosts.list" => json(out.hosts_list().await),
            "sections.list" => json(out.sections_list().await),
            "sections.create" => json(out.sections_create(&id(0)).await),
            "files.read" => {
                json(out.files_read(decode::<FileReadArgs>(at(0))?).await.map(|r| json!(r)))
            }
            "files.write" => {
                json(out.files_write(decode::<FileWriteArgs>(at(0))?).await.map(|r| json!(r)))
            }
            "ui.requestInput" => {
                let request = at(0);
                let cancel = request["signal"]
                    .as_str()
                    .and_then(|key| self.signals.lock().get(key).cloned());
                let describe_submission = request["describeSubmission"].as_str().map(|handler| {
                    let inner = JsHandler { bridge: self.clone(), handler: handler.to_owned() };
                    Arc::new(move |value: Value| {
                        let inner = inner.clone();
                        async move {
                            inner
                                .bridge
                                .call::<Value>(&inner.handler, value)
                                .await
                                .ok()
                                .filter(|v| !v.is_null())
                        }
                        .boxed()
                    }) as super::api::DescribeSubmission
                });
                let result = self
                    .api
                    .request_input(InputRequest {
                        thread_id: text(&request, "threadId"),
                        renderer_id: text(&request, "rendererId"),
                        title: text(&request, "title"),
                        payload: request["payload"].clone(),
                        timeout_ms: request["timeoutMs"].as_u64(),
                        cancel,
                        presentation: request.get("presentation").filter(|p| !p.is_null()).cloned(),
                        describe_submission,
                    })
                    .await;
                if let Some(key) = request["signal"].as_str() {
                    self.signals.lock().remove(key);
                }
                Ok(json!(result))
            }
            other => Err(format!("unknown plugin call \"{other}\"")),
        }
    }
}

#[derive(Clone)]
struct JsHandler {
    bridge: Shared,
    handler: String,
}

#[async_trait]
impl RpcHandler for JsHandler {
    async fn call(&self, input: Value) -> Result<Value, RpcFailure> {
        let out = self
            .bridge
            .rt
            .call(&self.handler, input)
            .await
            .map_err(|e| RpcFailure::handler(e.message))?;
        if out["ok"] == Value::Bool(true) {
            return Ok(out["value"].clone());
        }
        Err(decode(out["error"].clone()).map_err(RpcFailure::handler)?)
    }
}

fn error_response(message: String) -> Response {
    let mut response = Response::new(Body::from(message));
    *response.status_mut() = http::StatusCode::INTERNAL_SERVER_ERROR;
    response
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body_base64: Option<String>,
}

impl JsHandler {
    async fn http(&self, request: Request) -> Result<Response, String> {
        let (parts, body) = request.into_parts();
        let bytes = body.collect().await.map_err(|e| e.to_string())?.to_bytes();
        let path = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
        let url = if parts.uri.scheme().is_some() {
            parts.uri.to_string()
        } else {
            format!("{}{path}", self.bridge.api.server_url.trim_end_matches('/'))
        };
        let headers: Vec<(&str, &str)> = parts
            .headers
            .iter()
            .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str(), v)))
            .collect();
        let arg = json!({
            "method": parts.method.as_str(),
            "url": url,
            "headers": headers,
            "bodyBase64": (!bytes.is_empty()).then(|| BASE64.encode(&bytes)),
        });
        let out: JsResponse = self.bridge.call(&self.handler, arg).await.map_err(|e| e.message)?;
        let body = match out.body_base64 {
            Some(b) => BASE64.decode(b).map_err(|e| e.to_string())?,
            None => Vec::new(),
        };
        let mut builder = Response::builder().status(out.status);
        for (name, value) in out.headers {
            builder = builder.header(name, value);
        }
        builder.body(Body::from(body)).map_err(|e| e.to_string())
    }
}

#[async_trait]
impl HttpHandler for JsHandler {
    async fn handle(&self, request: Request) -> Response {
        self.http(request).await.unwrap_or_else(error_response)
    }
}

struct JsCli {
    inner: JsHandler,
    name: String,
    summary: String,
    commands: Vec<CliCommandSummary>,
}

#[async_trait]
impl PluginCli for JsCli {
    fn name(&self) -> String {
        self.name.clone()
    }
    fn summary(&self) -> String {
        self.summary.clone()
    }
    fn commands(&self) -> Vec<CliCommandSummary> {
        self.commands.clone()
    }
    async fn run(&self, argv: Vec<String>, context: CliContext) -> CliResult {
        let arg = json!({
            "argv": argv,
            "context": {
                "cwd": context.cwd, "threadId": context.thread_id, "projectId": context.project_id,
            },
        });
        let result =
            self.inner.bridge.call_cancellable(&self.inner.handler, arg, &context.cancel).await;
        match result.map_err(|e| e.message).and_then(decode::<CliResult>) {
            Ok(result) => result,
            Err(message) => {
                CliResult { exit_code: 1, stdout: String::new(), stderr: format!("{message}\n") }
            }
        }
    }
}

struct JsTool {
    bridge: Shared,
    meta: Value,
}

#[async_trait]
impl AgentTool for JsTool {
    fn name(&self) -> String {
        text(&self.meta, "name")
    }
    fn description(&self) -> String {
        text(&self.meta, "description")
    }
    fn instructions(&self) -> Option<String> {
        self.meta["instructions"].as_str().map(str::to_owned)
    }
    fn presentation(&self) -> Option<Value> {
        Some(self.meta["presentation"].clone()).filter(|p| !p.is_null())
    }
    fn input_schema(&self) -> Value {
        self.meta["inputSchema"].clone()
    }
    async fn enabled_for(&self, context: &ThreadContext) -> bool {
        match self.meta["enabledFor"].as_str() {
            Some(handler) => self.bridge.call(handler, json!(context)).await.unwrap_or(false),
            None => true,
        }
    }
    async fn execute(
        &self,
        input: Value,
        context: ThreadContext,
        cancel: CancellationToken,
    ) -> Result<AgentToolResult, ToolFailure> {
        let handler = text(&self.meta, "execute");
        let arg = json!({ "input": input, "context": context });
        let out = self.bridge.call_cancellable(&handler, arg, &cancel).await;
        let out = out.map_err(|e| ToolFailure::Failed(e.message))?;
        if let Some(message) = out["invalid"].as_str() {
            return Err(ToolFailure::InvalidArguments(message.to_owned()));
        }
        if let Some(message) = out["failed"].as_str() {
            return Err(ToolFailure::Failed(message.to_owned()));
        }
        let text = text(&out, "text");
        Ok(if out["plain"] == Value::Bool(true) {
            AgentToolResult::Text(text)
        } else {
            AgentToolResult::Detailed { text, is_error: out["isError"] == Value::Bool(true) }
        })
    }
}

struct JsMention {
    bridge: Shared,
    meta: Value,
}

#[async_trait]
impl MentionProvider for JsMention {
    fn id(&self) -> String {
        text(&self.meta, "id")
    }
    fn label(&self) -> String {
        text(&self.meta, "label")
    }
    fn triggers(&self) -> Vec<String> {
        decode(self.meta["triggers"].clone()).unwrap_or_else(|_| vec!["@".to_owned()])
    }
    async fn search(&self, query: MentionQuery) -> PluginResult<Vec<MentionItem>> {
        self.bridge.call(&text(&self.meta, "search"), json!(query)).await
    }
    async fn resolve(&self, item_id: &str) -> PluginResult<String> {
        self.bridge.call(&text(&self.meta, "resolve"), json!(item_id)).await
    }
}

struct JsInference {
    bridge: Shared,
    meta: Value,
}

#[async_trait]
impl InferenceService for JsInference {
    fn id(&self) -> String {
        text(&self.meta, "id")
    }
    fn display_name(&self) -> String {
        text(&self.meta, "displayName")
    }
    async fn complete(&self, prompt: &str, cancel: CancellationToken) -> PluginResult<String> {
        let arg = json!({ "prompt": prompt });
        let out = self.bridge.call_cancellable(&text(&self.meta, "handler"), arg, &cancel).await;
        decode(out.map_err(plugin_error)?).map_err(PluginError::new)
    }
}

struct JsMachineAccess {
    bridge: Shared,
    meta: Value,
}

#[async_trait]
impl MachineAccessProvider for JsMachineAccess {
    async fn grant(&self, host_id: &str) -> PluginResult<Option<MachineAccess>> {
        self.bridge.call(&text(&self.meta, "grant"), json!(host_id)).await
    }
    async fn revoke(&self, host_id: &str, connect_machine_id: Option<&str>) -> PluginResult<()> {
        let host = json!({ "id": host_id, "connectMachineId": connect_machine_id });
        self.bridge.call::<Value>(&text(&self.meta, "revoke"), host).await.map(|_| ())
    }
}

/// Runs a bundled plugin server entry (an ES module whose default export takes
/// the plugin host configuration) in its own QuickJS runtime, which lives
/// until the plugin is disposed.
pub async fn start_js_plugin(source: &str, api: PluginApi) -> PluginResult<()> {
    let log = api.log.clone();
    let options = JsRuntimeOptions {
        memory_limit: Some(MEMORY_LIMIT),
        deadline: Duration::from_secs(30),
        console: Some(Arc::new(move |level: &str, message: &str| match level {
            "error" => log.error(message),
            "warn" => log.warn(message),
            "debug" | "trace" => log.debug(message),
            _ => log.info(message),
        })),
        tokio: None,
    };
    let rt = JsRuntime::new(options).map_err(plugin_error)?;
    let shutdown = rt.clone();
    api.on_dispose_last(Box::new(move || async move { shutdown.shutdown().await }.boxed()));
    let cwd = api.data_dir.to_string_lossy().into_owned();
    let env = std::env::vars().collect();
    let compat = NodeCompatOptions { cwd, env, fs_root: None };
    bb_js::install_node_compat(&rt, compat).await.map_err(plugin_error)?;
    let database = bb_js::register_lazy_database(&rt, DATABASE, &api.database_path()).await;
    api.on_dispose_last(Box::new(move || async move { database.close() }.boxed()));
    let config = json!({
        "pluginId": api.plugin_id,
        "dataDir": api.data_dir,
        "serverUrl": api.server_url,
        "serverDataDir": api.server_data_dir,
    });
    let bridge = Arc::new(Bridge {
        rt: rt.clone(),
        api,
        settings: Mutex::default(),
        signals: Mutex::default(),
        next: AtomicU64::new(0),
    });
    let ops: [(&str, bb_js::SyncOp); 5] = [
        ("plugin.register", {
            let bridge = bridge.clone();
            Arc::new(move |arg| bridge.register(arg))
        }),
        ("plugin.log", {
            let log = bridge.api.log.clone();
            Arc::new(move |arg| {
                let message = text(&arg, "message");
                match arg["level"].as_str() {
                    Some("debug") => log.debug(&message),
                    Some("warn") => log.warn(&message),
                    Some("error") => log.error(&message),
                    _ => log.info(&message),
                }
                Ok(Value::Null)
            })
        }),
        ("plugin.publish", {
            let bridge = bridge.clone();
            Arc::new(move |arg| {
                bridge.api.realtime_publish(&text(&arg, "channel"), arg["payload"].clone());
                Ok(Value::Null)
            })
        }),
        ("plugin.signal", {
            let bridge = bridge.clone();
            Arc::new(move |_| {
                let key = format!("input:{}", bridge.next.fetch_add(1, Ordering::Relaxed));
                bridge.signals.lock().insert(key.clone(), CancellationToken::new());
                Ok(json!(key))
            })
        }),
        ("plugin.abort", {
            let bridge = bridge.clone();
            Arc::new(move |arg| {
                if let Some(token) =
                    arg.as_str().and_then(|k| bridge.signals.lock().get(k).cloned())
                {
                    token.cancel();
                }
                Ok(Value::Null)
            })
        }),
    ];
    for (name, op) in ops {
        rt.register_sync_op(name, op).await;
    }
    let outward = bridge.clone();
    rt.register_async_op(
        "plugin.outward",
        Arc::new(move |arg| outward.clone().outward(arg).boxed()),
    )
    .await;
    let started = async {
        rt.load_module(GLUE_MODULE, GLUE).await?;
        rt.load_module(PLUGIN_MODULE, source).await?;
        rt.call_export(PLUGIN_MODULE, "default", config).await
    };
    if let Err(error) = started.await {
        rt.shutdown().await;
        return Err(plugin_error(error));
    }
    Ok(())
}
