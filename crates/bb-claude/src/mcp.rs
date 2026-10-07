use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::{Map, Value, json};

pub const MCP_SERVER_VERSION: &str = "1.0.0";
pub const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";

#[derive(Debug, Clone, PartialEq)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct McpToolResult {
    pub content: Vec<Value>,
    pub is_error: bool,
}

/// `(tool name, arguments, tool use id from `_meta["claudecode/toolUseId"]`)`.
pub type McpCallTool =
    Arc<dyn Fn(String, Value, Option<String>) -> BoxFuture<'static, McpToolResult> + Send + Sync>;

/// An in-process ("sdk") MCP server reached through `mcp_message` control requests.
pub struct McpServer {
    name: String,
    tools: Vec<McpTool>,
    call_tool: McpCallTool,
}

impl std::fmt::Debug for McpServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpServer").field("name", &self.name).field("tools", &self.tools).finish()
    }
}

fn error_response(id: Value, code: i64, message: String) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

impl McpServer {
    pub fn new(name: impl Into<String>, tools: Vec<McpTool>, call_tool: McpCallTool) -> Self {
        Self { name: name.into(), tools, call_tool }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn tools(&self) -> &[McpTool] {
        &self.tools
    }

    /// Answers one JSON-RPC message with the value that goes into `{mcp_response: ...}`.
    /// Notifications are acknowledged with `{"jsonrpc":"2.0","result":{},"id":0}`.
    pub async fn handle(&self, message: Value) -> Value {
        let method = message.get("method").and_then(Value::as_str).unwrap_or_default();
        let Some(id) = message.get("id").cloned().filter(|id| !id.is_null()) else {
            return json!({"jsonrpc": "2.0", "result": {}, "id": 0});
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let result = match method {
            "initialize" => {
                let version = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or(LATEST_PROTOCOL_VERSION);
                json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": self.name, "version": MCP_SERVER_VERSION},
                })
            }
            "ping" => json!({}),
            "tools/list" => {
                let tools: Vec<Value> = self
                    .tools
                    .iter()
                    .map(|tool| {
                        json!({
                            "name": tool.name,
                            "description": tool.description,
                            "inputSchema": tool.input_schema,
                        })
                    })
                    .collect();
                json!({"tools": tools})
            }
            "tools/call" => self.call(&params).await,
            _ => return error_response(id, -32601, "Method not found".to_owned()),
        };
        json!({"result": result, "jsonrpc": "2.0", "id": id})
    }

    async fn call(&self, params: &Value) -> Value {
        let name = params.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
        if !self.tools.iter().any(|tool| tool.name == name) {
            let text = format!("MCP error -32602: Tool {name} not found");
            return json!({"content": [{"type": "text", "text": text}], "isError": true});
        }
        let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
        let tool_use_id = params
            .get("_meta")
            .and_then(|meta| meta.get("claudecode/toolUseId"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let result = (self.call_tool)(name, arguments, tool_use_id).await;
        let mut object = Map::new();
        object.insert("content".to_owned(), Value::Array(result.content));
        if result.is_error {
            object.insert("isError".to_owned(), Value::Bool(true));
        }
        Value::Object(object)
    }
}
