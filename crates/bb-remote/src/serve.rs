use std::collections::VecDeque;
use std::sync::Arc;

use bb_core::{Lane, RunnerError, RunnerEvent, SharedRunner};
use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::link::{Link, link_frames};
use crate::outbox::Outbox;
use crate::protocol::{Frame, Hello, is_runner_method, to_wire_error};
use crate::socket::WireSocket;

pub const LIVE_HIGH_WATER_BYTES: usize = 1024 * 1024;
pub const LIVE_OUTPUT_KEEP_NEWEST: usize = 32;

struct Held {
    frame: Frame,
    terminal_output: bool,
}

struct Shared {
    link: Arc<Link>,
    held: Mutex<VecDeque<Held>>,
    welcomed: std::sync::atomic::AtomicBool,
}

impl Shared {
    fn pump(&self) {
        let mut held = self.held.lock();
        while self.link.buffered_amount() <= LIVE_HIGH_WATER_BYTES {
            let Some(next) = held.pop_front() else { return };
            self.link.send(&next.frame);
        }
    }

    fn hold_live(&self, event: RunnerEvent) {
        let terminal_output = event.body.kind() == "terminal.output";
        {
            let mut held = self.held.lock();
            held.push_back(Held { frame: Frame::Evt { event }, terminal_output });
            let outputs = held.iter().filter(|entry| entry.terminal_output).count();
            if outputs > LIVE_OUTPUT_KEEP_NEWEST
                && let Some(oldest) = held.iter().position(|entry| entry.terminal_output)
            {
                held.remove(oldest);
            }
        }
        self.pump();
    }
}

/// The machine's end of a runner socket. Hand every runner event to `deliver`.
#[derive(Clone)]
pub struct RunnerServing {
    shared: Arc<Shared>,
}

impl RunnerServing {
    pub fn deliver(&self, event: RunnerEvent) {
        if !self.shared.welcomed.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        if event.lane == Lane::Reliable {
            self.shared.link.send(&Frame::Evt { event });
            self.shared.pump();
        } else {
            self.shared.hold_live(event);
        }
    }

    pub fn link(&self) -> &Arc<Link> {
        &self.shared.link
    }
}

async fn answer(
    runner: SharedRunner,
    outbox: Arc<Outbox>,
    link: Arc<Link>,
    id: u64,
    method: String,
    params: Option<Value>,
) {
    let result = if is_runner_method(&method) {
        runner.call(&method, params.unwrap_or(Value::Null)).await
    } else {
        Err(RunnerError::failed(format!("Runner method \"{method}\" cannot be called remotely")))
    };
    outbox.flush();
    let frame = match result {
        Ok(result) => Frame::Res { id, ok: true, result: Some(result), error: None },
        Err(error) => {
            Frame::Res { id, ok: false, result: None, error: Some(to_wire_error(&error)) }
        }
    };
    link.send(&frame);
}

pub fn serve_runner(
    runner: SharedRunner,
    outbox: Arc<Outbox>,
    socket: WireSocket,
) -> RunnerServing {
    let slot: Arc<Mutex<Option<Arc<Shared>>>> = Arc::default();
    let frames_slot = slot.clone();
    let frames_runner = runner.clone();
    let frames_outbox = outbox.clone();
    let on_frame = move |frame: Frame| {
        let Some(shared) = frames_slot.lock().clone() else { return };
        match frame {
            Frame::Req { id, method, params } => {
                let task = answer(
                    frames_runner.clone(),
                    frames_outbox.clone(),
                    shared.link.clone(),
                    id,
                    method,
                    params,
                );
                tokio::spawn(task);
            }
            Frame::Ack { seq } => frames_outbox.ack(seq),
            Frame::Welcome { last_seq } => {
                shared.welcomed.store(true, std::sync::atomic::Ordering::SeqCst);
                frames_outbox.resend_after(last_seq);
            }
            _ => {}
        }
    };
    let closed_slot = slot.clone();
    let on_closed = move || {
        if let Some(shared) = closed_slot.lock().as_ref() {
            shared.held.lock().clear();
        }
    };
    let link = link_frames(socket, false, on_frame, on_closed);
    let shared = Arc::new(Shared {
        link: link.clone(),
        held: Mutex::default(),
        welcomed: std::sync::atomic::AtomicBool::new(false),
    });
    *slot.lock() = Some(shared.clone());

    let pumping = shared.clone();
    tokio::spawn(async move {
        loop {
            let written = pumping.link.written();
            pumping.pump();
            tokio::select! {
                _ = written => {}
                _ = pumping.link.closed() => break,
            }
        }
    });

    let last_acked_seq = Some(outbox.last_acked_seq());
    let greeting = link.clone();
    tokio::spawn(async move {
        if let Ok(info) = runner.call("describe", json!({})).await {
            let text = |key: &str| info.get(key).and_then(Value::as_str).unwrap_or("").to_owned();
            let hello =
                Hello { instance_id: text("instanceId"), version: text("version"), last_acked_seq };
            greeting.send(&Frame::Hello(hello));
        }
    });

    RunnerServing { shared }
}
