use std::collections::VecDeque;
use std::sync::{Arc, Weak};
use std::time::Duration;

use bb_core::{RunnerEvent, RunnerEventBody, RunnerEventSink};
use parking_lot::Mutex;
use serde_json::Value;

const MAX_UNACKED: usize = 10_000;

fn flushes_immediately(event: &Value) -> bool {
    match event.get("type").and_then(Value::as_str) {
        Some("turn/started" | "turn/completed" | "item/completed" | "system/error") => true,
        Some("provider/error") => event.get("willRetry") != Some(&Value::Bool(true)),
        _ => false,
    }
}

#[derive(Default)]
struct State {
    seq: u64,
    acked: u64,
    unacked: VecDeque<RunnerEvent>,
    batch: Vec<(String, Vec<Value>)>,
    timer: Option<tokio::task::JoinHandle<()>>,
}

/// Sequences reliable events, batches thread events for `flush_ms`, and keeps
/// every sequenced event until it is acked so it can be re-sent.
pub struct Outbox {
    sink: RunnerEventSink,
    flush_ms: u64,
    this: Weak<Outbox>,
    state: Mutex<State>,
}

impl Outbox {
    pub fn new(sink: RunnerEventSink) -> Arc<Self> {
        Self::with_flush_ms(sink, 100)
    }

    pub fn with_flush_ms(sink: RunnerEventSink, flush_ms: u64) -> Arc<Self> {
        Arc::new_cyclic(|this| Self {
            sink,
            flush_ms,
            this: this.clone(),
            state: Mutex::new(State::default()),
        })
    }

    pub fn last_seq(&self) -> u64 {
        self.state.lock().seq
    }

    pub fn last_acked_seq(&self) -> u64 {
        self.state.lock().acked
    }

    pub fn thread_event(&self, thread_id: &str, event: Value) {
        let immediate = flushes_immediately(&event);
        {
            let mut state = self.state.lock();
            match state.batch.last_mut() {
                Some((tail, events)) if tail == thread_id => events.push(event),
                _ => state.batch.push((thread_id.to_owned(), vec![event])),
            }
            if !immediate && state.timer.is_none() {
                let this = self.this.clone();
                let delay = Duration::from_millis(self.flush_ms);
                state.timer = Some(tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    if let Some(outbox) = this.upgrade() {
                        outbox.state.lock().timer = None;
                        outbox.flush();
                    }
                }));
            }
        }
        if immediate {
            self.flush();
        }
    }

    pub fn emit(&self, body: RunnerEventBody) {
        let mut sent = self.take_batch();
        sent.push(self.deliver(body));
        self.send_all(sent);
    }

    pub fn flush(&self) {
        let sent = self.take_batch();
        self.send_all(sent);
    }

    pub fn ack(&self, seq: u64) {
        let mut state = self.state.lock();
        state.acked = state.acked.max(seq);
        state.unacked.retain(|event| event.seq.unwrap_or(0) > seq);
    }

    pub fn resend_after(&self, seq: u64) {
        let events: Vec<RunnerEvent> = {
            let state = self.state.lock();
            state.unacked.iter().filter(|event| event.seq.unwrap_or(0) > seq).cloned().collect()
        };
        self.send_all(events);
    }

    fn take_batch(&self) -> Vec<RunnerEvent> {
        let groups = {
            let mut state = self.state.lock();
            if let Some(timer) = state.timer.take() {
                timer.abort();
            }
            std::mem::take(&mut state.batch)
        };
        groups
            .into_iter()
            .map(|(thread_id, events)| {
                self.deliver(RunnerEventBody::ThreadEvents { thread_id, events })
            })
            .collect()
    }

    fn deliver(&self, body: RunnerEventBody) -> RunnerEvent {
        let mut state = self.state.lock();
        state.seq += 1;
        let event = RunnerEvent::reliable(state.seq, body);
        state.unacked.push_back(event.clone());
        if state.unacked.len() > MAX_UNACKED {
            state.unacked.pop_front();
        }
        event
    }

    fn send_all(&self, events: Vec<RunnerEvent>) {
        for event in events {
            (self.sink)(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn recording() -> (Arc<Mutex<Vec<RunnerEvent>>>, Arc<Outbox>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let into = seen.clone();
        let outbox = Outbox::new(Arc::new(move |event| into.lock().push(event)));
        (seen, outbox)
    }

    #[tokio::test(start_paused = true)]
    async fn batches_thread_events_and_flushes_on_boundaries() {
        let (seen, outbox) = recording();
        outbox.thread_event("thr_1", json!({"type": "item/delta"}));
        outbox.thread_event("thr_1", json!({"type": "item/delta"}));
        outbox.thread_event("thr_2", json!({"type": "provider/error", "willRetry": true}));
        assert!(seen.lock().is_empty());
        tokio::time::sleep(Duration::from_millis(101)).await;
        assert_eq!(seen.lock().len(), 2);
        outbox.thread_event("thr_1", json!({"type": "provider/error"}));
        assert_eq!(seen.lock().len(), 3);
        let wire = serde_json::to_value(&seen.lock()[0]).unwrap();
        assert_eq!(
            wire,
            json!({"lane": "reliable", "seq": 1, "kind": "thread.events", "threadId": "thr_1",
                "events": [{"type": "item/delta"}, {"type": "item/delta"}]})
        );
    }

    #[tokio::test]
    async fn emit_flushes_first_and_ack_trims_resends() {
        let (seen, outbox) = recording();
        outbox.thread_event("thr_1", json!({"type": "item/delta"}));
        outbox.emit(RunnerEventBody::ScriptOutput { operation_id: "op".into(), text: "x".into() });
        let seqs = |seen: &Mutex<Vec<RunnerEvent>>| -> Vec<u64> {
            seen.lock().iter().filter_map(|event| event.seq).collect()
        };
        assert_eq!(seqs(&seen), [1, 2]);
        assert_eq!(seen.lock()[0].body.kind(), "thread.events");
        outbox.ack(1);
        assert_eq!(outbox.last_acked_seq(), 1);
        outbox.resend_after(0);
        assert_eq!(seqs(&seen), [1, 2, 2]);
        outbox.ack(0);
        assert_eq!((outbox.last_acked_seq(), outbox.last_seq()), (1, 2));
    }
}
