//! `apps/server/src/plugins/deps.ts`: what the server offers each plugin,
//! attributed to it.

use std::path::Path;
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bb_core::RunnerErrorCode;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::api::{
    FileRead, FileReadArgs, FileWriteArgs, FileWriteOutcome, InputRequest, InputResult,
    PluginHostDeps, PluginOutward,
};
use crate::context::{Ctx, ServerContext};
use crate::db::event_read::{EventQuery, decode_event, last_output, list_events};
use crate::db::hosts::{HostFilter, list_hosts};
use crate::db::projects::list_standard_projects;
use crate::db::thread_read::{ThreadListQuery, list_thread_rows};
use crate::db::thread_sections::{create_thread_section, list_thread_sections};
use crate::domain::changes::ProjectChangeKind;
use crate::domain::project::PERSONAL_PROJECT_ID;
use crate::error::{ApiError, ApiResult, invalid_request};
use crate::runners::hosts::host_response;
use crate::threads::engine::ops;
use crate::threads::interactions::PluginInputRequest;
use crate::threads::thread_display::to_thread_list_entries;

pub fn create_plugin_host_deps(ctx: &Ctx) -> PluginHostDeps {
    let server = Arc::downgrade(ctx);
    Arc::new(move |plugin_id: &str| {
        Arc::new(PluginDeps { server: server.clone(), plugin_id: plugin_id.to_owned() })
            as Arc<dyn PluginOutward>
    })
}

pub struct PluginDeps {
    server: Weak<ServerContext>,
    plugin_id: String,
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> ApiResult<T> {
    serde_json::from_value(value).map_err(|error| invalid_request(error.to_string()))
}

fn encode<T: serde::Serialize>(value: &T) -> ApiResult<Value> {
    serde_json::to_value(value).map_err(ApiError::internal)
}

fn presentation(value: Option<Value>) -> Option<Value> {
    value.filter(|v| v.get("label").is_some() && v.get("icon").is_some())
}

impl PluginDeps {
    fn ctx(&self) -> ApiResult<Ctx> {
        self.server.upgrade().ok_or_else(|| ApiError::internal("The server has stopped"))
    }

    /// The runner of the thread's host and, for a relative path, the
    /// workspace root it resolves against.
    fn workspace(
        &self,
        ctx: &Ctx,
        thread_id: &str,
        path: &str,
    ) -> ApiResult<(bb_core::SharedRunner, Option<String>)> {
        let environment = ops::workspace_of(ctx, thread_id)?;
        let root_path = (!Path::new(path).is_absolute()).then_some(environment.path);
        Ok((ctx.runners.get(&environment.host_id)?, root_path))
    }
}

#[async_trait]
impl PluginOutward for PluginDeps {
    async fn threads_spawn(&self, request: Value) -> ApiResult<Value> {
        let ctx = self.ctx()?;
        let mut attributed = match request {
            Value::Object(fields) => fields,
            _ => serde_json::Map::new(),
        };
        attributed.insert("origin".into(), json!("plugin"));
        attributed.insert("originPluginId".into(), json!(self.plugin_id));
        let thread = ops::create(&ctx, decode(Value::Object(attributed))?).await?;
        encode(&thread)
    }

    async fn threads_send(&self, thread_id: &str, request: Value) -> ApiResult<Value> {
        let ctx = self.ctx()?;
        encode(&ops::send(&ctx, thread_id, decode(request)?).await?)
    }

    async fn threads_get(&self, thread_id: &str) -> ApiResult<Option<Value>> {
        let ctx = self.ctx()?;
        ops::get(&ctx, thread_id)?.map(|thread| encode(&thread)).transpose()
    }

    async fn threads_list(&self, query: Value) -> ApiResult<Value> {
        let ctx = self.ctx()?;
        let query: ThreadListQuery = match query {
            Value::Null => ThreadListQuery::default(),
            query => decode(query)?,
        };
        let rows = list_thread_rows(&ctx.db, &query)?;
        encode(&to_thread_list_entries(&ctx, &rows)?)
    }

    async fn threads_stop(&self, thread_id: &str) -> ApiResult<()> {
        ops::stop(&self.ctx()?, thread_id).await
    }

    async fn threads_update(&self, thread_id: &str, patch: Value) -> ApiResult<Value> {
        let ctx = self.ctx()?;
        encode(&ops::update(&ctx, thread_id, decode(patch)?).await?)
    }

    async fn threads_output(&self, thread_id: &str) -> ApiResult<Option<String>> {
        Ok(last_output(&self.ctx()?.db, thread_id)?)
    }

    async fn threads_events(
        &self,
        thread_id: &str,
        after_sequence: Option<i64>,
    ) -> ApiResult<Vec<Value>> {
        let ctx = self.ctx()?;
        let query = EventQuery {
            thread_id: thread_id.to_owned(),
            after: after_sequence,
            ..Default::default()
        };
        Ok(list_events(&ctx.db, &query)?.iter().map(decode_event).collect())
    }

    async fn projects_list(&self) -> ApiResult<Value> {
        encode(&list_standard_projects(&self.ctx()?.db)?)
    }

    async fn hosts_list(&self) -> ApiResult<Value> {
        let ctx = self.ctx()?;
        let filter = HostFilter { include_creating: false, ..Default::default() };
        let rows = list_hosts(&ctx.db, filter)?;
        encode(&rows.iter().map(|row| host_response(&ctx, row)).collect::<Vec<_>>())
    }

    async fn sections_list(&self) -> ApiResult<Value> {
        encode(&list_thread_sections(&self.ctx()?.db)?)
    }

    async fn sections_create(&self, name: &str) -> ApiResult<Value> {
        let ctx = self.ctx()?;
        let section = create_thread_section(&ctx.db, name.trim())?;
        ctx.hub.project(PERSONAL_PROJECT_ID, vec![ProjectChangeKind::ThreadsChanged]);
        encode(&section)
    }

    async fn files_read(&self, args: FileReadArgs) -> ApiResult<Option<FileRead>> {
        let ctx = self.ctx()?;
        let (runner, root_path) = self.workspace(&ctx, &args.thread_id, &args.path)?;
        let params = json!({ "path": args.path, "rootPath": root_path });
        let file = match runner.call("readFile", params).await {
            Ok(file) => file,
            Err(error) if error.code == RunnerErrorCode::PathNotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let (Some(content), Some(sha256)) = (
            file.get("content").and_then(Value::as_str),
            file.get("sha256").and_then(Value::as_str),
        ) else {
            return Ok(None);
        };
        let bytes = if file.get("contentEncoding").and_then(Value::as_str) == Some("base64") {
            STANDARD.decode(content).unwrap_or_default()
        } else {
            content.as_bytes().to_vec()
        };
        let content = if args.encoding.as_deref() == Some("base64") {
            STANDARD.encode(&bytes)
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        };
        Ok(Some(FileRead { content, sha256: sha256.to_owned() }))
    }

    async fn files_write(&self, args: FileWriteArgs) -> ApiResult<FileWriteOutcome> {
        let ctx = self.ctx()?;
        let (runner, root_path) = self.workspace(&ctx, &args.thread_id, &args.path)?;
        let mut params = json!({
            "path": args.path,
            "content": args.content,
            "rootPath": root_path,
            "createParents": true,
        });
        if let Some(encoding) = args.encoding {
            params["contentEncoding"] = json!(encoding);
        }
        if let Some(expected) = args.expected_sha256 {
            params["expectedSha256"] = json!(expected);
        }
        if let Some(mode) = args.mode {
            params["mode"] = json!(mode);
        }
        let result = runner.call("writeFile", params).await?;
        if result.get("outcome").and_then(Value::as_str) == Some("conflict") {
            return Ok(FileWriteOutcome::Conflict);
        }
        let sha256 = result.get("sha256").and_then(Value::as_str).unwrap_or_default();
        Ok(FileWriteOutcome::Written { sha256: sha256.to_owned() })
    }

    async fn request_input(&self, request: InputRequest) -> InputResult {
        let Ok(ctx) = self.ctx() else {
            return InputResult::Cancelled { reason: "The server has stopped".into() };
        };
        let signal = CancellationToken::new();
        let limits = {
            let signal = signal.clone();
            let caller = request.cancel.clone();
            let timeout = request.timeout_ms.map(Duration::from_millis);
            tokio::spawn(async move {
                let cancelled = async {
                    match caller {
                        Some(caller) => caller.cancelled().await,
                        None => std::future::pending().await,
                    }
                };
                let expired = async {
                    match timeout {
                        Some(timeout) => tokio::time::sleep(timeout).await,
                        None => std::future::pending().await,
                    }
                };
                tokio::select! {
                    _ = cancelled => {}
                    _ = expired => {}
                }
                signal.cancel();
            })
        };
        let form = PluginInputRequest {
            thread_id: request.thread_id,
            plugin_id: self.plugin_id.clone(),
            renderer_id: request.renderer_id,
            title: request.title,
            payload: request.payload,
            presentation: presentation(request.presentation),
            cancel: Some(signal),
            describe_submission: request.describe_submission,
        };
        let result = ops::request_input(&ctx, form).await;
        limits.abort();
        result.unwrap_or_else(|error| InputResult::Cancelled { reason: error.body.message })
    }
}
