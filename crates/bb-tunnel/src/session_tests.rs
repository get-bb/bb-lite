use super::*;

use std::convert::Infallible;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

use crate::contract::{decode_frame, encode_frame};

struct MemSocket {
    incoming: mpsc::UnboundedReceiver<TunnelMessage>,
    outgoing: mpsc::UnboundedSender<TunnelMessage>,
}

#[async_trait]
impl TunnelSocket for MemSocket {
    async fn send_binary(&mut self, data: Vec<u8>) -> std::io::Result<()> {
        let _ = self.outgoing.send(TunnelMessage::Binary(data));
        Ok(())
    }

    async fn send_text(&mut self, text: String) -> std::io::Result<()> {
        let _ = self.outgoing.send(TunnelMessage::Text(text));
        Ok(())
    }

    async fn recv(&mut self) -> Option<TunnelMessage> {
        self.incoming.recv().await
    }

    async fn close(&mut self) {
        self.incoming.close();
    }
}

#[derive(Default)]
struct RecLog(Mutex<Vec<String>>);

impl TunnelLog for RecLog {
    fn warn(&self, message: &str) {
        self.0.lock().push(message.to_owned());
    }
}

struct Gate {
    tx: mpsc::UnboundedSender<TunnelMessage>,
    rx: mpsc::UnboundedReceiver<TunnelMessage>,
    log: Arc<RecLog>,
    session: TunnelSession,
}

impl Gate {
    fn start(origin: String, heartbeat: Option<Heartbeat>) -> Gate {
        let (tx, incoming) = mpsc::unbounded_channel();
        let (outgoing, rx) = mpsc::unbounded_channel();
        let log = Arc::new(RecLog::default());
        let resolve_origin: ResolveOrigin = Arc::new(move |target| match target {
            None => StreamOriginResult::Ok(ResolvedStreamOrigin {
                origin: origin.clone(),
                public_origin: "https://pub.example".to_owned(),
                host: None,
            }),
            Some(_) => StreamOriginResult::Unregistered,
        });
        let options = TunnelSessionOptions { log: log.clone(), resolve_origin, heartbeat };
        let session = TunnelSession::start(MemSocket { incoming, outgoing }, options);
        Gate { tx, rx, log, session }
    }

    fn send(&self, frame: Frame) {
        let bytes = encode_frame(&frame).unwrap();
        self.tx.send(TunnelMessage::Binary(bytes)).unwrap();
    }

    async fn next(&mut self) -> TunnelMessage {
        tokio::time::timeout(Duration::from_secs(5), self.rx.recv())
            .await
            .expect("timed out waiting for the tunnel")
            .expect("tunnel closed")
    }

    async fn frame(&mut self) -> Frame {
        loop {
            if let TunnelMessage::Binary(data) = self.next().await {
                return decode_frame(&data).unwrap();
            }
        }
    }

    async fn response(&mut self, stream_id: u32) -> (u16, Vec<HeaderPair>, String) {
        let Frame::RespHead { stream_id: id, status, headers } = self.frame().await else {
            panic!("expected resp-head");
        };
        assert_eq!(id, stream_id);
        let mut body = Vec::new();
        loop {
            match self.frame().await {
                Frame::BodyChunk { data, .. } => body.extend_from_slice(&data),
                Frame::BodyEnd { stream_id: id } => {
                    assert_eq!(id, stream_id);
                    break;
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        (status, headers, String::from_utf8(body).unwrap())
    }
}

async fn echo_http_origin() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { return };
            tokio::spawn(async move {
                let service = service_fn(|req: hyper::Request<hyper::body::Incoming>| async move {
                    let mut text = format!("{} {}\n", req.method(), req.uri());
                    for (name, value) in req.headers() {
                        text.push_str(&format!("{name}: {}\n", value.to_str().unwrap()));
                    }
                    let body = req.into_body().collect().await.unwrap().to_bytes();
                    text.push('\n');
                    text.push_str(std::str::from_utf8(&body).unwrap());
                    let response = hyper::Response::builder()
                        .status(201)
                        .header("x-test", "yes")
                        .body(Full::new(Bytes::from(text)))
                        .unwrap();
                    Ok::<_, Infallible>(response)
                });
                let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
            });
        }
    });
    format!("http://{addr}/")
}

fn open_http(stream_id: u32, method: &str, path: &str, headers: Vec<HeaderPair>) -> Frame {
    Frame::OpenHttp(OpenHttpFrame {
        stream_id,
        method: method.to_owned(),
        path: path.to_owned(),
        headers,
        has_body: method == "POST",
        target: None,
    })
}

fn h(name: &str, value: &str) -> HeaderPair {
    (name.to_owned(), value.to_owned())
}

#[tokio::test]
async fn relays_an_http_stream_to_the_origin() {
    let origin = echo_http_origin().await;
    let mut gate = Gate::start(origin, None);
    gate.send(open_http(3, "POST", "/echo?q=1", vec![h("content-type", "text/plain")]));
    for part in ["hello", "world"] {
        gate.send(Frame::BodyChunk { stream_id: 3, data: part.as_bytes().to_vec() });
    }
    gate.send(Frame::BodyEnd { stream_id: 3 });
    let (status, headers, body) = gate.response(3).await;
    assert_eq!(status, 201);
    assert!(headers.contains(&h("x-test", "yes")));
    assert!(body.starts_with("POST /echo?q=1\n"), "{body}");
    assert!(body.contains("content-length: 10\n"), "{body}");
    assert!(body.ends_with("\n\nhelloworld"), "{body}");

    gate.send(open_http(4, "GET", "/", vec![]));
    let (status, _, body) = gate.response(4).await;
    assert_eq!(status, 201);
    assert!(body.starts_with("GET /\n"), "{body}");
    assert!(gate.log.0.lock().is_empty());
}

#[tokio::test]
async fn marks_requests_as_via_tunnel_and_strips_inbound_markers() {
    let origin = echo_http_origin().await;
    let loopback = origin.trim_end_matches('/').to_owned();
    let mut gate = Gate::start(origin, None);
    let headers = vec![
        h("X-BB-Via-Tunnel", "0"),
        h("x-bb-via-tunnel", "spoofed"),
        h("Origin", "https://pub.example"),
        h("Host", "pub.example"),
        h("Connection", "close"),
        h("x-other", "kept"),
    ];
    gate.send(open_http(5, "GET", "/via", headers));
    let (_, _, body) = gate.response(5).await;
    let via: Vec<&str> =
        body.lines().filter(|line| line.to_lowercase().starts_with("x-bb-via-tunnel")).collect();
    assert_eq!(via, vec!["x-bb-via-tunnel: 1"]);
    assert!(body.contains(&format!("origin: {loopback}\n")), "{body}");
    assert!(body.contains(&format!("host: {}\n", &loopback[7..])), "{body}");
    assert!(body.contains("x-other: kept\n"), "{body}");

    let target = ResolvedStreamOrigin {
        origin: "http://127.0.0.1:8000".to_owned(),
        public_origin: "https://p.example".to_owned(),
        host: Some("127.0.0.1:8000".to_owned()),
    };
    let forwarded = headers_for_loopback_request(
        &[
            h("x-bb-via-tunnel", "1"),
            h("origin", "https://p.example"),
            h("Origin", "https://elsewhere.example"),
            h("content-length", "3"),
        ],
        &target,
    );
    assert_eq!(
        forwarded,
        vec![
            h("origin", "http://127.0.0.1:8000"),
            h("Origin", "https://elsewhere.example"),
            h("x-bb-via-tunnel", "1"),
            h("Host", "127.0.0.1:8000"),
        ]
    );
}

#[tokio::test]
async fn answers_unregistered_ports_and_origin_failures() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let mut gate = Gate::start(dead, None);
    let mut frame = open_http(6, "GET", "/x", vec![]);
    if let Frame::OpenHttp(f) = &mut frame {
        f.target = Some("9999".to_owned());
    }
    gate.send(frame);
    let (status, headers, body) = gate.response(6).await;
    assert_eq!(status, 404);
    assert_eq!(headers, vec![h("content-type", "text/plain; charset=utf-8")]);
    assert_eq!(body, "this port is not shared");

    gate.send(open_http(7, "GET", "/down?secret=1", vec![]));
    let Frame::CloseStream { stream_id, code, .. } = gate.frame().await else {
        panic!("expected close-stream");
    };
    assert_eq!((stream_id, code), (7, 1011));
    let warning = gate.log.0.lock()[0].clone();
    assert!(warning.starts_with("origin http error on GET /down: Error: "), "{warning}");

    gate.tx.send(TunnelMessage::Binary(vec![9, 0, 0, 0, 1])).unwrap();
    gate.send(Frame::BodyEnd { stream_id: 77 });
    gate.send(open_http(8, "GET", "/", vec![]));
    let _ = gate.frame().await;
    assert_eq!(
        gate.log.0.lock()[1],
        "tunnel bad frame: Error: tunnel-contract: unknown frame type 9"
    );
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn relays_a_websocket_stream() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen_by_server = seen.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let callback = |req: &Request, mut res: Response| {
            for (name, value) in req.headers() {
                seen_by_server.lock().push(format!("{name}: {}", value.to_str().unwrap()));
            }
            res.headers_mut().insert("sec-websocket-protocol", "bb.v1".parse().unwrap());
            Ok(res)
        };
        let mut ws = tokio_tungstenite::accept_hdr_async(stream, callback).await.unwrap();
        while let Some(Ok(message)) = ws.next().await {
            match message {
                Message::Text(text) if text.as_str() == "bye" => {
                    let frame = CloseFrame { code: 4000.into(), reason: "done".into() };
                    let _ = ws.close(Some(frame)).await;
                }
                Message::Text(_) | Message::Binary(_) => ws.send(message).await.unwrap(),
                _ => {}
            }
        }
    });
    let mut gate = Gate::start(origin, None);
    gate.send(Frame::OpenWs(OpenWsFrame {
        stream_id: 9,
        path: "/socket?x=1".to_owned(),
        headers: vec![h("x-bb-via-tunnel", "0"), h("sec-websocket-key", "inbound")],
        protocols: vec!["bb.v1".to_owned()],
        target: None,
    }));
    gate.send(Frame::WsData { stream_id: 9, is_binary: false, data: b"early".to_vec() });
    assert_eq!(
        gate.frame().await,
        Frame::WsOpenAck { stream_id: 9, protocol: Some("bb.v1".to_owned()) }
    );
    let text = |data: &[u8]| Frame::WsData { stream_id: 9, is_binary: false, data: data.to_vec() };
    assert_eq!(gate.frame().await, text(b"early"));
    gate.send(Frame::WsData { stream_id: 9, is_binary: true, data: vec![0, 1, 255] });
    assert_eq!(
        gate.frame().await,
        Frame::WsData { stream_id: 9, is_binary: true, data: vec![0, 1, 255] }
    );
    gate.send(text(b"bye"));
    assert_eq!(
        gate.frame().await,
        Frame::CloseStream { stream_id: 9, code: 4000, reason: "done".to_owned() }
    );
    let seen = seen.lock().clone();
    assert!(seen.contains(&"x-bb-via-tunnel: 1".to_owned()), "{seen:?}");
    assert_eq!(seen.iter().filter(|l| l.starts_with("x-bb-via-tunnel")).count(), 1);
    assert!(!seen.contains(&"sec-websocket-key: inbound".to_owned()), "{seen:?}");
    assert!(seen.contains(&"sec-websocket-protocol: bb.v1".to_owned()), "{seen:?}");

    gate.send(Frame::OpenWs(OpenWsFrame {
        stream_id: 10,
        path: "/".to_owned(),
        headers: vec![],
        protocols: vec![],
        target: Some("1".to_owned()),
    }));
    assert_eq!(
        gate.frame().await,
        Frame::CloseStream {
            stream_id: 10,
            code: 1008,
            reason: "this port is not shared".to_owned()
        }
    );
}

#[tokio::test]
async fn sends_heartbeats_and_ends_when_they_go_unanswered() {
    let heartbeat =
        Heartbeat { interval: Duration::from_millis(40), deadline: Duration::from_millis(150) };
    let mut gate = Gate::start("http://127.0.0.1:1".to_owned(), Some(heartbeat));
    assert_eq!(gate.next().await, TunnelMessage::Text("bbt:hb".to_owned()));
    gate.tx.send(TunnelMessage::Text("bbt:hb-ack".to_owned())).unwrap();
    tokio::time::timeout(Duration::from_secs(5), gate.session.closed())
        .await
        .expect("session should end after a missed heartbeat");
    assert!(gate.log.0.lock().contains(&"tunnel heartbeat missed; reconnecting".to_owned()));
}

#[tokio::test]
async fn dispose_ends_the_session() {
    let gate = Gate::start("http://127.0.0.1:1".to_owned(), None);
    gate.session.dispose();
    tokio::time::timeout(Duration::from_secs(5), gate.session.closed())
        .await
        .expect("dispose should end the session");
}
