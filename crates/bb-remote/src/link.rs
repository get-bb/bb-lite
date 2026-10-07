use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::{Notify, mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::protocol::{Frame, FrameDecoder, LEASE_MS, PING_INTERVAL_MS, encode_frame};
use crate::socket::{Received, WireSocket};

enum Outgoing {
    Text(String),
    Close(u16, String),
}

/// A socket carrying frames: queues writes (`buffered_amount` counts queued,
/// unwritten bytes), answers pings, and terminates after `LEASE_MS` of silence.
pub struct Link {
    queue: mpsc::UnboundedSender<Outgoing>,
    buffered: AtomicUsize,
    written: Notify,
    open: AtomicBool,
    stop: CancellationToken,
    closed: watch::Receiver<Option<Option<u16>>>,
}

impl Link {
    pub fn send(&self, frame: &Frame) {
        if !self.open.load(Ordering::SeqCst) {
            return;
        }
        for part in encode_frame(frame) {
            self.buffered.fetch_add(part.len(), Ordering::SeqCst);
            let _ = self.queue.send(Outgoing::Text(part));
        }
    }

    pub fn buffered_amount(&self) -> usize {
        self.buffered.load(Ordering::SeqCst)
    }

    /// Resolves after a queued frame is written; registered as soon as it is created.
    pub fn written(&self) -> tokio::sync::futures::Notified<'_> {
        self.written.notified()
    }

    pub fn close(&self, code: u16, reason: &str) {
        let _ = self.queue.send(Outgoing::Close(code, reason.to_owned()));
    }

    pub fn terminate(&self) {
        self.stop.cancel();
    }

    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    /// Resolves once the socket is closed, with the peer's close code if any.
    pub async fn closed(&self) -> Option<u16> {
        let mut closed = self.closed.clone();
        match closed.wait_for(Option::is_some).await {
            Ok(code) => code.flatten(),
            Err(_) => None,
        }
    }
}

pub fn link_frames(
    socket: WireSocket,
    pings: bool,
    on_frame: impl Fn(Frame) + Send + Sync + 'static,
    on_closed: impl FnOnce() + Send + 'static,
) -> Arc<Link> {
    let (queue, mut outgoing) = mpsc::unbounded_channel();
    let (closed_tx, closed) = watch::channel(None);
    let link = Arc::new(Link {
        queue,
        buffered: AtomicUsize::new(0),
        written: Notify::new(),
        open: AtomicBool::new(true),
        stop: CancellationToken::new(),
        closed,
    });
    let heard_at = Arc::new(Mutex::new(Instant::now()));
    let WireSocket { send: mut sender, recv: mut receiver } = socket;

    let writer = link.clone();
    tokio::spawn(async move {
        loop {
            let next = tokio::select! {
                _ = writer.stop.cancelled() => break,
                next = outgoing.recv() => next,
            };
            match next {
                Some(Outgoing::Text(text)) => {
                    let size = text.len();
                    let ok = tokio::select! {
                        _ = writer.stop.cancelled() => break,
                        ok = sender.send_text(text) => ok,
                    };
                    writer.buffered.fetch_sub(size, Ordering::SeqCst);
                    writer.written.notify_waiters();
                    if !ok {
                        writer.stop.cancel();
                        break;
                    }
                }
                Some(Outgoing::Close(code, reason)) => {
                    sender.close(code, reason).await;
                    break;
                }
                None => break,
            }
        }
        writer.written.notify_waiters();
    });

    let beat = link.clone();
    let beat_heard = heard_at.clone();
    tokio::spawn(async move {
        let period = Duration::from_millis(PING_INTERVAL_MS);
        let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        loop {
            tokio::select! {
                _ = beat.stop.cancelled() => break,
                _ = interval.tick() => {}
            }
            if beat_heard.lock().elapsed() > Duration::from_millis(LEASE_MS) {
                beat.stop.cancel();
            } else if pings {
                beat.send(&Frame::Ping);
            }
        }
    });

    let reader = link.clone();
    tokio::spawn(async move {
        let mut decoder = FrameDecoder::new();
        let code = loop {
            let received = tokio::select! {
                _ = reader.stop.cancelled() => break None,
                received = receiver.recv() => received,
            };
            let text = match received {
                Received::Text(text) => text,
                Received::Closed(code) => break code,
            };
            *heard_at.lock() = Instant::now();
            match decoder.decode(&text) {
                None | Some(Frame::Pong) => {}
                Some(Frame::Ping) => reader.send(&Frame::Pong),
                Some(frame) => on_frame(frame),
            }
        };
        reader.open.store(false, Ordering::SeqCst);
        reader.stop.cancel();
        on_closed();
        let _ = closed_tx.send(Some(code));
    });

    link
}
