use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Received {
    Text(String),
    /// The socket closed, with the peer's close code if it sent one.
    Closed(Option<u16>),
}

/// The sending half of a WebSocket. `send_text` resolves once the frame is
/// written; `false` means the socket is gone.
#[async_trait]
pub trait SocketSend: Send + 'static {
    async fn send_text(&mut self, text: String) -> bool;
    async fn close(&mut self, code: u16, reason: String);
}

/// The receiving half of a WebSocket. After `Received::Closed` it is not polled again.
#[async_trait]
pub trait SocketRecv: Send + 'static {
    async fn recv(&mut self) -> Received;
}

pub struct WireSocket {
    pub send: Box<dyn SocketSend>,
    pub recv: Box<dyn SocketRecv>,
}

impl WireSocket {
    pub fn new(send: impl SocketSend, recv: impl SocketRecv) -> Self {
        Self { send: Box::new(send), recv: Box::new(recv) }
    }

    pub fn from_tungstenite<S>(stream: WebSocketStream<S>) -> Self
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (sink, stream) = stream.split();
        Self::new(TungsteniteSend(sink), TungsteniteRecv(stream))
    }
}

struct TungsteniteSend<S>(futures::stream::SplitSink<WebSocketStream<S>, Message>);
struct TungsteniteRecv<S>(futures::stream::SplitStream<WebSocketStream<S>>);

#[async_trait]
impl<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> SocketSend for TungsteniteSend<S> {
    async fn send_text(&mut self, text: String) -> bool {
        self.0.send(Message::Text(text.into())).await.is_ok()
    }

    async fn close(&mut self, code: u16, reason: String) {
        let frame = CloseFrame { code: CloseCode::from(code), reason: reason.into() };
        let _ = self.0.send(Message::Close(Some(frame))).await;
    }
}

#[async_trait]
impl<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> SocketRecv for TungsteniteRecv<S> {
    async fn recv(&mut self) -> Received {
        loop {
            match self.0.next().await {
                Some(Ok(Message::Text(text))) => return Received::Text(text.as_str().to_owned()),
                Some(Ok(Message::Binary(data))) => {
                    return Received::Text(String::from_utf8_lossy(&data).into_owned());
                }
                Some(Ok(Message::Close(frame))) => {
                    return Received::Closed(frame.map(|frame| u16::from(frame.code)));
                }
                Some(Ok(_)) => continue,
                Some(Err(_)) | None => return Received::Closed(None),
            }
        }
    }
}

enum MemoryMessage {
    Text(String),
    Close(u16),
}

struct MemorySend(Option<mpsc::Sender<MemoryMessage>>);

struct MemoryRecv {
    inbox: mpsc::Receiver<MemoryMessage>,
    paused: watch::Receiver<bool>,
}

#[async_trait]
impl SocketSend for MemorySend {
    async fn send_text(&mut self, text: String) -> bool {
        match &self.0 {
            Some(tx) => tx.send(MemoryMessage::Text(text)).await.is_ok(),
            None => false,
        }
    }

    async fn close(&mut self, code: u16, _reason: String) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(MemoryMessage::Close(code)).await;
        }
    }
}

#[async_trait]
impl SocketRecv for MemoryRecv {
    async fn recv(&mut self) -> Received {
        if self.paused.wait_for(|paused| !paused).await.is_err() {
            return Received::Closed(None);
        }
        match self.inbox.recv().await {
            Some(MemoryMessage::Text(text)) => Received::Text(text),
            Some(MemoryMessage::Close(code)) => Received::Closed(Some(code)),
            None => Received::Closed(None),
        }
    }
}

/// One end of an in-memory socket pair; `pause` stops this end reading so the
/// peer's writes back up, as `ws`'s `socket.pause()` does.
pub struct MemoryEnd {
    pub socket: WireSocket,
    pub pause: watch::Sender<bool>,
}

/// Two connected in-memory sockets with a small per-direction buffer.
pub fn memory_pair() -> (MemoryEnd, MemoryEnd) {
    let (a_tx, a_rx) = mpsc::channel(4);
    let (b_tx, b_rx) = mpsc::channel(4);
    let (a_pause, a_paused) = watch::channel(false);
    let (b_pause, b_paused) = watch::channel(false);
    let a = WireSocket::new(MemorySend(Some(b_tx)), MemoryRecv { inbox: a_rx, paused: a_paused });
    let b = WireSocket::new(MemorySend(Some(a_tx)), MemoryRecv { inbox: b_rx, paused: b_paused });
    (MemoryEnd { socket: a, pause: a_pause }, MemoryEnd { socket: b, pause: b_pause })
}
