#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use bb_cli::call::{Call, CliEnv, CliResult};
use bb_cli::engine::{Resolution, parse_invocation, resolve_command};
use bb_cli::table::table;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub body: Option<Value>,
}

/// A canned answer: method, path without the query, status and JSON body.
pub type Route = (&'static str, String, u16, Value);

pub struct FakeServer {
    pub url: String,
    pub requests: Arc<Mutex<Vec<Request>>>,
    /// The `x-bb-thread-id` header of every request, in order.
    pub thread_ids: Arc<Mutex<Vec<Option<String>>>>,
}

impl FakeServer {
    pub fn start(routes: Vec<Route>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let thread_ids = Arc::new(Mutex::new(Vec::new()));
        let named = thread_ids.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let target = parts.next().unwrap_or("").to_string();
                let mut length = 0;
                let mut thread_id = None;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header.trim().is_empty() {
                        break;
                    }
                    let lower = header.to_lowercase();
                    if let Some(value) = lower.strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap_or(0);
                    }
                    if lower.starts_with("x-bb-thread-id:") {
                        thread_id = header.split_once(':').map(|(_, id)| id.trim().to_string());
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let body = (length > 0).then(|| serde_json::from_slice(&body).unwrap());
                let path = target.strip_prefix("/api/v1").unwrap_or(&target).to_string();
                let bare = path.split('?').next().unwrap_or("").to_string();
                named.lock().unwrap().push(thread_id);
                recorded.lock().unwrap().push(Request { method: method.clone(), path, body });
                let found = routes.iter().find(|(m, p, _, _)| *m == method && *p == bare);
                let (status, answer) = match found {
                    Some((_, _, status, answer)) => (*status, answer.to_string()),
                    None => (404, r#"{"error":{"message":"no route"}}"#.to_string()),
                };
                let head = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    answer.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(answer.as_bytes());
            }
        });
        FakeServer { url, requests, thread_ids }
    }

    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}

pub fn route(method: &'static str, path: &str, body: Value) -> Route {
    (method, path.to_string(), 200, body)
}

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Runs `bb <words>` against `server` and returns what it printed, or the error.
pub fn run(server: &FakeServer, words: &[&str], env: CliEnv) -> (CliResult<()>, String) {
    let table = table().unwrap();
    let argv: Vec<String> = words.iter().map(|w| w.to_string()).collect();
    let Resolution::Command { spec, argv } = resolve_command(table, &argv) else {
        panic!("{words:?} is not a command");
    };
    let invocation = match parse_invocation(spec, &argv) {
        Ok(invocation) => invocation,
        Err(error) => return (Err(error), String::new()),
    };
    let env = CliEnv { server_url: server.url.clone(), ..env };
    let captured = Captured::default();
    let mut call = Call::new(table, spec, invocation, env);
    call.stdout = Box::new(captured.clone());
    let result = (spec.run)(&mut call).and_then(|output| call.emit(output));
    let printed = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    (result, printed)
}
