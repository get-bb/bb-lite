#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use bb_cli::call::{Call, CliEnv, CliError};
use bb_cli::engine::{Resolution, parse_invocation, resolve_command};
use serde_json::Value;

/// One request the fake server received; `path` excludes the query, `query` is the raw string.
#[derive(Debug, Clone, PartialEq)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub query: String,
    pub body: Option<Value>,
}

type Route = dyn Fn(&Recorded) -> (u16, String) + Send + Sync;

/// A tiny HTTP/1.1 server on port 0 that answers each request through `route` and records it.
pub struct Fake {
    pub url: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
}

impl Fake {
    pub fn start(route: impl Fn(&Recorded) -> (u16, String) + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("addr"));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let route: Arc<Route> = Arc::new(route);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (seen, route) = (seen.clone(), route.clone());
                std::thread::spawn(move || serve(stream, &seen, &*route));
            }
        });
        Fake { url, requests }
    }

    /// Answers every request with the same JSON.
    pub fn json(body: Value) -> Self {
        Fake::start(move |_| (200, body.to_string()))
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().expect("lock").clone()
    }

    pub fn only(&self) -> Recorded {
        let all = self.requests();
        assert_eq!(all.len(), 1, "expected one request, got {all:#?}");
        all[0].clone()
    }
}

fn serve(stream: TcpStream, seen: &Mutex<Vec<Recorded>>, route: &Route) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let mut length = 0;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse().unwrap_or(0);
        }
    }
    let mut raw = vec![0; length];
    let _ = reader.read_exact(&mut raw);
    let text = || Value::String(String::from_utf8_lossy(&raw).into_owned());
    let body = (!raw.is_empty()).then(|| serde_json::from_slice(&raw).unwrap_or_else(|_| text()));
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let path = path.strip_prefix("/api/v1").unwrap_or(path).to_string();
    let recorded = Recorded { method, path, query: query.to_string(), body };
    seen.lock().expect("lock").push(recorded.clone());
    let (status, answer) = route(&recorded);
    let mut stream = stream;
    let head = format!(
        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\
         connection: close\r\n\r\n",
        answer.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(answer.as_bytes());
}

#[derive(Clone, Default)]
struct Shared(Arc<Mutex<Vec<u8>>>);

impl Write for Shared {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("lock").extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Runs `bb <argv>` against `url` with BB_THREAD_ID set to `thread_id`; returns the result and stdout.
pub fn run(url: &str, thread_id: Option<&str>, argv: &[&str]) -> (Result<(), CliError>, String) {
    let table = bb_cli::table::table().expect("table");
    let argv: Vec<String> = argv.iter().map(|a| a.to_string()).collect();
    let Resolution::Command { spec, argv } = resolve_command(table, &argv) else {
        panic!("not a command: {argv:?}");
    };
    let env = CliEnv {
        server_url: url.to_string(),
        thread_id: thread_id.map(String::from),
        ..CliEnv::default()
    };
    let out = Shared::default();
    let result = parse_invocation(spec, &argv).and_then(|invocation| {
        let mut call = Call::new(table, spec, invocation, env);
        call.stdout = Box::new(out.clone());
        (spec.run)(&mut call).and_then(|output| call.emit(output))
    });
    let text = String::from_utf8(out.0.lock().expect("lock").clone()).expect("utf8");
    (result, text)
}

/// `run` that must succeed; returns stdout.
pub fn ok(url: &str, thread_id: Option<&str>, argv: &[&str]) -> String {
    let (result, out) = run(url, thread_id, argv);
    if let Err(error) = result {
        panic!("bb {argv:?} failed: {error:?}");
    }
    out
}

/// `run` that must fail; returns the error.
pub fn fail(url: &str, thread_id: Option<&str>, argv: &[&str]) -> CliError {
    match run(url, thread_id, argv).0 {
        Err(error) => error,
        Ok(()) => panic!("bb {argv:?} succeeded"),
    }
}
