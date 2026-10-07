use std::hash::Hash;
use std::sync::Arc;

use bb_core::ids::random_hex;
use indexmap::{IndexMap, IndexSet};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::provider::Presentation;

pub type EventSink = Arc<dyn Fn(Value) + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

const SEP: &str = "\u{1f}";
const MAX_TRACKED: usize = 1024;
const MAX_GUARDED: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TextChannel {
    AgentMessage,
    Plan,
    ReasoningText,
    ReasoningSummary,
}

impl TextChannel {
    fn item_type(self) -> &'static str {
        match self {
            Self::AgentMessage => "agentMessage",
            Self::Plan => "plan",
            Self::ReasoningText | Self::ReasoningSummary => "reasoning",
        }
    }

    fn event_type(self) -> &'static str {
        match self {
            Self::AgentMessage => "item/agentMessage/delta",
            Self::Plan => "item/plan/delta",
            Self::ReasoningText => "item/reasoning/textDelta",
            Self::ReasoningSummary => "item/reasoning/summaryTextDelta",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DeltaChannel {
    Text(TextChannel),
    Command,
    FileChange,
}

impl From<TextChannel> for DeltaChannel {
    fn from(channel: TextChannel) -> Self {
        Self::Text(channel)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ItemKey {
    pub provider_item_id: Option<String>,
    pub channel: Option<String>,
    pub parent_ref: Option<String>,
}

impl ItemKey {
    pub fn provider(provider_item_id: impl Into<String>) -> Self {
        Self { provider_item_id: Some(provider_item_id.into()), ..Self::default() }
    }

    pub fn with_channel(mut self, channel: impl Into<String>) -> Self {
        self.channel = Some(channel.into());
        self
    }

    pub fn with_parent_ref(mut self, parent_ref: Option<impl Into<String>>) -> Self {
        self.parent_ref = parent_ref.map(Into::into);
        self
    }

    fn joined(&self) -> String {
        let part = |value: &Option<String>| value.clone().unwrap_or_default();
        [part(&self.provider_item_id), part(&self.channel), part(&self.parent_ref)].join(SEP)
    }
}

#[derive(Clone, Debug, Default)]
pub struct ItemOptions {
    pub turn: Option<String>,
    pub presentation: Option<Presentation>,
}

#[derive(Clone, Debug)]
pub struct CloseOptions {
    pub turn: Option<String>,
    pub status: String,
    pub presentation: Option<Presentation>,
    pub denied: bool,
}

impl CloseOptions {
    pub fn new(status: impl Into<String>) -> Self {
        Self { turn: None, status: status.into(), presentation: None, denied: false }
    }
}

#[derive(Clone, Debug)]
pub struct BackgroundSnapshot {
    pub shape: Value,
    pub status: String,
}

#[derive(Clone, Debug, Default)]
pub struct ProgressOptions {
    pub turn: Option<String>,
    pub message: Option<String>,
    pub flush: bool,
    pub snapshot: Option<BackgroundSnapshot>,
}

#[derive(Clone, Debug, Default)]
pub struct ErrorOptions {
    pub turn: Option<String>,
    pub settles_turn: bool,
    pub thread_scoped: bool,
}

#[derive(Clone)]
pub struct EventBuilderOptions {
    pub emit: EventSink,
    pub text_flush_ms: i64,
    pub progress_throttle_ms: i64,
    pub now: Clock,
}

impl EventBuilderOptions {
    pub fn new(emit: EventSink) -> Self {
        Self { emit, text_flush_ms: 100, progress_throttle_ms: 500, now: Arc::new(bb_core::now_ms) }
    }
}

#[derive(Clone)]
struct OpenItem {
    id: String,
    key: ItemKey,
    shape: Value,
    presentation: Option<Value>,
    parent: Option<String>,
    turn_id: String,
    text: String,
    summary: String,
}

fn trim_map<K: Hash + Eq, V>(map: &mut IndexMap<K, V>, max: usize) {
    while map.len() > max {
        map.shift_remove_index(0);
    }
}

fn trim_set<K: Hash + Eq>(set: &mut IndexSet<K>, max: usize) {
    while set.len() > max {
        set.shift_remove_index(0);
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

fn type_of(value: &Value) -> &str {
    value.get("type").and_then(Value::as_str).unwrap_or("")
}

fn spread(target: &mut Map<String, Value>, source: &Value) {
    if let Some(object) = source.as_object() {
        for (key, value) in object {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn put(target: &mut Map<String, Value>, key: &str, value: Option<impl Into<Value>>) {
    if let Some(value) = value {
        target.insert(key.to_owned(), value.into());
    }
}

fn typed(kind: &str) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::from(kind));
    map
}

fn is_thread_attached(shape: &Value) -> bool {
    let kind = type_of(shape);
    kind == "backgroundTask" || (kind == "delegation" && truthy(shape.get("background")))
}

fn is_text_item_type(kind: &str) -> bool {
    matches!(kind, "agentMessage" | "plan" | "reasoning")
}

fn text_shape(kind: &str, text: &str, summary: &str) -> Value {
    if kind == "reasoning" {
        let list = |part: &str| if part.is_empty() { json!([]) } else { json!([part]) };
        json!({ "type": kind, "summary": list(summary), "content": list(text) })
    } else {
        json!({ "type": kind, "text": text })
    }
}

fn build_item(
    shape: &Value,
    id: &str,
    status: &str,
    presentation: Option<Value>,
    parent: Option<String>,
    denied: bool,
) -> Value {
    let mut item = Map::new();
    spread(&mut item, shape);
    item.insert("id".to_owned(), Value::from(id));
    put(&mut item, "presentation", presentation);
    put(&mut item, "parentToolCallId", parent);
    match type_of(shape) {
        "commandExecution" | "fileChange" => {
            item.insert("status".to_owned(), Value::from(status));
            let approval = if denied { Value::from("denied") } else { Value::Null };
            item.insert("approvalStatus".to_owned(), approval);
        }
        "toolCall" | "fileRead" | "search" | "delegation" | "planSteps" | "imageGeneration"
        | "backgroundTask" => {
            item.insert("status".to_owned(), Value::from(status));
        }
        _ => {}
    }
    Value::Object(item)
}

fn random_uuid() -> String {
    let hex = random_hex(16);
    let variant = ["8", "9", "a", "b"][usize::from(hex.as_bytes()[16]) % 4];
    format!(
        "{}-{}-4{}-{}{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        variant,
        &hex[17..20],
        &hex[20..32]
    )
}

fn presentation_value(presentation: Option<Presentation>) -> Option<Value> {
    presentation.map(|presentation| presentation.to_value())
}

struct State {
    prefix: String,
    text_flush_ms: i64,
    progress_ms: i64,
    now: Clock,
    turn_counter: u64,
    item_counter: u64,
    identity_id: Option<String>,
    held: Vec<Value>,
    root_turn: Option<String>,
    last_root_turn: Option<String>,
    accepted: Vec<String>,
    open: IndexMap<String, OpenItem>,
    bb_items: IndexMap<String, String>,
    bb_turns: IndexMap<String, String>,
    provider_turns: IndexMap<String, String>,
    progress_at: IndexMap<String, i64>,
    pending_progress: IndexMap<String, Value>,
    text_at: IndexMap<String, i64>,
    pending_text: IndexMap<String, Value>,
    live_turns: IndexSet<String>,
    done_turns: IndexSet<String>,
    live_items: IndexSet<String>,
    done_items: IndexSet<String>,
    outbox: Vec<Value>,
}

/// The only place turn and item ids are minted and the only producer of canonical thread events.
/// Events reach the sink after the internal lock is released, in the order they were produced.
pub struct EventBuilder {
    emit: EventSink,
    state: Mutex<State>,
}

impl EventBuilder {
    pub fn new(emit: EventSink) -> Self {
        Self::with_options(EventBuilderOptions::new(emit))
    }

    pub fn with_options(options: EventBuilderOptions) -> Self {
        let state = State {
            prefix: format!("da{}", random_hex(4)),
            text_flush_ms: options.text_flush_ms,
            progress_ms: options.progress_throttle_ms,
            now: options.now,
            turn_counter: 0,
            item_counter: 0,
            identity_id: None,
            held: Vec::new(),
            root_turn: None,
            last_root_turn: None,
            accepted: Vec::new(),
            open: IndexMap::new(),
            bb_items: IndexMap::new(),
            bb_turns: IndexMap::new(),
            provider_turns: IndexMap::new(),
            progress_at: IndexMap::new(),
            pending_progress: IndexMap::new(),
            text_at: IndexMap::new(),
            pending_text: IndexMap::new(),
            live_turns: IndexSet::new(),
            done_turns: IndexSet::new(),
            live_items: IndexSet::new(),
            done_items: IndexSet::new(),
            outbox: Vec::new(),
        };
        Self { emit: options.emit, state: Mutex::new(state) }
    }

    fn run<R>(&self, action: impl FnOnce(&mut State) -> R) -> R {
        let (result, events) = {
            let mut state = self.state.lock();
            let result = action(&mut state);
            (result, std::mem::take(&mut state.outbox))
        };
        for event in events {
            (self.emit)(event);
        }
        result
    }

    pub fn active_turn_id(&self) -> Option<String> {
        self.state.lock().root_turn.clone()
    }

    pub fn has_open_background_work(&self) -> bool {
        let state = self.state.lock();
        state
            .open
            .values()
            .any(|item| matches!(type_of(&item.shape), "backgroundTask" | "delegation"))
    }

    pub fn bb_item_id(&self, provider_item_id: &str) -> Option<String> {
        self.state.lock().bb_items.get(provider_item_id).cloned()
    }

    pub fn bb_turn_id(&self, provider_turn_id: &str) -> Option<String> {
        self.state.lock().bb_turns.get(provider_turn_id).cloned()
    }

    pub fn provider_turn_id(&self, bb_turn_id: &str) -> Option<String> {
        self.state.lock().provider_turns.get(bb_turn_id).cloned()
    }

    pub fn identity(&self, provider_thread_id: &str) {
        self.run(|s| {
            s.flush();
            let first = s.identity_id.is_none();
            s.identity_id = Some(provider_thread_id.to_owned());
            s.outbox.push(json!({
                "type": "thread/identity",
                "providerThreadId": provider_thread_id,
                "scope": { "kind": "thread" },
            }));
            if !first {
                return;
            }
            for event in std::mem::take(&mut s.held) {
                let stamped = s.stamp(event);
                s.outbox.push(stamped);
            }
        })
    }

    pub fn started(&self) {
        self.run(|s| s.push(json!({ "type": "thread/started", "scope": { "kind": "thread" } })))
    }

    pub fn name(&self, thread_name: &str) {
        self.run(|s| {
            let mut draft = typed("thread/name/updated");
            draft.insert("threadName".to_owned(), Value::from(thread_name));
            s.send(None, draft)
        })
    }

    pub fn extension_state(&self, kind: &str, payload: Value) {
        self.run(|s| {
            let mut draft = typed("thread/extensionState/updated");
            draft.insert("kind".to_owned(), Value::from(kind));
            draft.insert("payload".to_owned(), payload);
            s.send(None, draft)
        })
    }

    pub fn accept_input(&self, client_request_id: &str, turn: Option<&str>) {
        self.run(|s| match s.target(turn, false) {
            None => s.accepted.push(client_request_id.to_owned()),
            Some(turn_id) => s.send_accepted(&turn_id, client_request_id),
        })
    }

    pub fn retract_input(&self, client_request_id: &str) {
        self.state.lock().accepted.retain(|id| id != client_request_id);
    }

    pub fn open_turn(&self, turn: Option<&str>, parent_ref: Option<&str>) -> String {
        self.run(|s| s.open_turn(turn, parent_ref))
    }

    pub fn close_turn(
        &self,
        turn: Option<&str>,
        status: &str,
        error: Option<&str>,
        checkpoint_id: Option<&str>,
    ) {
        self.run(|s| {
            if let Some(turn_id) = s.target(turn, false) {
                s.send_turn_completed(&turn_id, status, error, checkpoint_id);
            }
        })
    }

    pub fn open_item(&self, key: &ItemKey, shape: Value, options: ItemOptions) -> Option<String> {
        self.run(|s| {
            let turn_id = s.target(options.turn.as_deref(), false)?;
            if type_of(&shape) != "contextCompaction" {
                s.detach_assistant(key);
            }
            let id = s.resolve_item_id(key, None);
            let parent = s.parent_of(key.parent_ref.as_deref());
            let presentation = presentation_value(options.presentation);
            let k = key.joined();
            let open = OpenItem {
                id: id.clone(),
                key: key.clone(),
                shape: shape.clone(),
                presentation: presentation.clone(),
                parent: parent.clone(),
                turn_id: turn_id.clone(),
                text: String::new(),
                summary: String::new(),
            };
            s.open.insert(k.clone(), open);
            trim_map(&mut s.open, MAX_TRACKED);
            let now = (s.now)();
            s.progress_at.insert(k, now);
            trim_map(&mut s.progress_at, MAX_TRACKED);
            let item = build_item(&shape, &id, "pending", presentation, parent, false);
            s.send_item(&turn_id, "item/started", item);
            Some(id)
        })
    }

    pub fn close_item(&self, key: &ItemKey, shape: Value, options: CloseOptions) {
        self.run(|s| {
            let thread_scoped = is_thread_attached(&shape);
            let turn_id =
                if thread_scoped { None } else { s.target(options.turn.as_deref(), false) };
            if !thread_scoped && turn_id.is_none() {
                return;
            }
            let k = key.joined();
            let open = s.open.get(&k).cloned();
            let stale = open
                .as_ref()
                .filter(|open| !thread_scoped && type_of(&open.shape) != type_of(&shape))
                .cloned();
            let id = s.resolve_item_id(key, open.as_ref());
            let presentation = match &stale {
                Some(stale) => stale.presentation.clone(),
                None => presentation_value(options.presentation)
                    .or_else(|| open.as_ref().and_then(|open| open.presentation.clone())),
            };
            let parent = s
                .parent_of(key.parent_ref.as_deref())
                .or_else(|| open.as_ref().and_then(|open| open.parent.clone()));
            let built_shape = stale.as_ref().map_or(&shape, |stale| &stale.shape);
            let item =
                build_item(built_shape, &id, &options.status, presentation, parent, options.denied);
            s.forget(&k);
            let kind = type_of(&item).to_owned();
            if kind == "backgroundTask" {
                let mut draft = typed("item/backgroundTask/completed");
                draft.insert("item".to_owned(), item);
                s.send(None, draft);
            } else if kind == "delegation" && truthy(item.get("background")) {
                let mut draft = typed("item/delegation/completed");
                draft.insert("item".to_owned(), item);
                s.send(None, draft);
            } else if let Some(turn_id) = turn_id {
                s.send_item(&turn_id, "item/completed", item);
            }
        })
    }

    pub fn progress(&self, key: &ItemKey, options: ProgressOptions) {
        self.run(|s| {
            let k = key.joined();
            s.pending_progress.shift_remove(&k);
            let item_id = match s.open.get(&k) {
                Some(open) => Some(open.id.clone()),
                None => s.known_item_id(key),
            };
            let turn_id = match options.snapshot {
                Some(_) => None,
                None => s.target(options.turn.as_deref(), false),
            };
            let Some(item_id) = item_id else { return };
            if options.snapshot.is_none() && turn_id.is_none() {
                return;
            }
            let parent = s.parent_of(key.parent_ref.as_deref());
            let draft = match &options.snapshot {
                Some(snapshot) => {
                    let mut item = Map::new();
                    spread(&mut item, &snapshot.shape);
                    item.insert("id".to_owned(), Value::from(item_id));
                    item.insert("status".to_owned(), Value::from(snapshot.status.as_str()));
                    put(&mut item, "parentToolCallId", parent);
                    let mut draft = typed("item/backgroundTask/progress");
                    draft.insert("item".to_owned(), Value::Object(item));
                    draft
                }
                None => {
                    let mut draft = typed("item/toolCall/progress");
                    draft.insert("itemId".to_owned(), Value::from(item_id));
                    put(&mut draft, "message", options.message);
                    put(&mut draft, "parentToolCallId", parent);
                    draft
                }
            };
            let event = s.draft(turn_id.as_deref(), draft);
            let now = (s.now)();
            let throttled = s.progress_at.get(&k).is_some_and(|at| now - at < s.progress_ms);
            if throttled && !options.flush {
                s.pending_progress.insert(k, event);
                return;
            }
            s.progress_at.insert(k, now);
            s.push(event);
        })
    }

    pub fn model_fallback(&self, fallback: Value) {
        self.run(|s| {
            let turn_id = s.target(None, true);
            let mut draft = typed("provider/modelFallback");
            spread(&mut draft, &fallback);
            s.send(turn_id.as_deref(), draft)
        })
    }

    pub fn delta(&self, key: &ItemKey, channel: DeltaChannel, delta: &str, turn: Option<&str>) {
        self.run(|s| s.delta(key, channel, delta, turn))
    }

    pub fn text_close(
        &self,
        key: &ItemKey,
        channel: TextChannel,
        text: Option<&str>,
        turn: Option<&str>,
    ) {
        self.run(|s| s.text_close(key, channel, text, turn))
    }

    pub fn usage(&self, token_usage: Value, turn: Option<&str>) {
        self.run(|s| {
            if let Some(turn_id) = s.target(turn, true) {
                let mut draft = typed("thread/tokenUsage/updated");
                draft.insert("tokenUsage".to_owned(), token_usage);
                s.send(Some(&turn_id), draft);
            }
        })
    }

    pub fn context_window(&self, usage: Value, turn: Option<&str>, open_only: bool) {
        self.run(|s| {
            let turn_id = s.target(turn, !open_only);
            let mut draft = typed("thread/contextWindowUsage/updated");
            draft.insert("contextWindowUsage".to_owned(), usage);
            s.send(turn_id.as_deref(), draft)
        })
    }

    pub fn compacted(&self, turn: Option<&str>) {
        self.run(|s| {
            if let Some(turn_id) = s.target(turn, true) {
                s.send(Some(&turn_id), typed("thread/compacted"));
            }
        })
    }

    pub fn cleared(&self) {
        self.run(|s| {
            if let Some(turn_id) = s.target(None, true).filter(|id| !id.is_empty()) {
                s.send(Some(&turn_id), typed("thread/context/cleared"));
            }
        })
    }

    pub fn error(&self, report: Value, options: ErrorOptions) {
        self.run(|s| {
            let in_thread = options.thread_scoped && options.turn.is_none();
            let claim = !in_thread && !s.accepted.is_empty();
            let turn_id = if in_thread {
                None
            } else {
                s.target(options.turn.as_deref(), false)
                    .or_else(|| claim.then(|| s.open_turn(None, None)))
            };
            let message = report
                .get("message")
                .filter(|message| !message.is_null())
                .cloned()
                .unwrap_or_else(|| Value::from("Provider error"));
            let mut draft = typed("provider/error");
            spread(&mut draft, &report);
            draft.insert("message".to_owned(), message);
            s.send(turn_id.as_deref(), draft);
            if let Some(turn_id) = turn_id.filter(|id| options.settles_turn && !id.is_empty()) {
                s.send_turn_completed(&turn_id, "failed", None, None);
            }
        })
    }

    pub fn warning(&self, warning: Value) {
        self.run(|s| {
            let category = warning
                .get("category")
                .filter(|category| !category.is_null())
                .cloned()
                .unwrap_or_else(|| Value::from("general"));
            let mut draft = typed("provider/warning");
            spread(&mut draft, &warning);
            draft.insert("category".to_owned(), category);
            s.send(None, draft)
        })
    }

    pub fn settle(&self, status: &str, error: Option<&str>) {
        self.run(|s| s.settle(status, error))
    }

    pub fn flush(&self) {
        self.run(State::flush)
    }
}

impl State {
    fn mint(&mut self, kind: char) -> String {
        let counter = if kind == 't' { &mut self.turn_counter } else { &mut self.item_counter };
        *counter += 1;
        format!("{}-{kind}{counter}", self.prefix)
    }

    fn target(&mut self, turn: Option<&str>, or_last: bool) -> Option<String> {
        if let Some(turn) = turn {
            return Some(self.turn_id(turn));
        }
        self.root_turn.clone().or_else(|| if or_last { self.last_root_turn.clone() } else { None })
    }

    fn turn_id(&mut self, provider_turn_id: &str) -> String {
        if let Some(known) = self.bb_turns.get(provider_turn_id) {
            return known.clone();
        }
        let turn_id = self.mint('t');
        self.bb_turns.insert(provider_turn_id.to_owned(), turn_id.clone());
        self.provider_turns.insert(turn_id.clone(), provider_turn_id.to_owned());
        trim_map(&mut self.bb_turns, MAX_TRACKED);
        trim_map(&mut self.provider_turns, MAX_TRACKED);
        turn_id
    }

    fn known_item_id(&self, key: &ItemKey) -> Option<String> {
        let provider_item_id = key.provider_item_id.as_deref().filter(|id| !id.is_empty())?;
        self.bb_items.get(provider_item_id).cloned()
    }

    fn resolve_item_id(&mut self, key: &ItemKey, open: Option<&OpenItem>) -> String {
        let id = match open {
            Some(open) => open.id.clone(),
            None => match self.known_item_id(key) {
                Some(id) => id,
                None => self.mint('i'),
            },
        };
        if let Some(provider_item_id) = &key.provider_item_id {
            self.register(provider_item_id, &id);
        }
        id
    }

    fn register(&mut self, provider_item_id: &str, id: &str) {
        self.bb_items.insert(provider_item_id.to_owned(), id.to_owned());
        trim_map(&mut self.bb_items, MAX_TRACKED);
    }

    fn parent_of(&mut self, parent_ref: Option<&str>) -> Option<String> {
        let parent_ref = parent_ref?;
        if let Some(existing) = self.bb_items.get(parent_ref) {
            return Some(existing.clone());
        }
        let id = self.mint('i');
        self.register(parent_ref, &id);
        Some(id)
    }

    fn detach_assistant(&mut self, key: &ItemKey) {
        self.open.retain(|_, item| {
            let anonymous = item.key.provider_item_id.is_none();
            let same_parent = item.key.parent_ref == key.parent_ref;
            let assistant = type_of(&item.shape) == "agentMessage";
            !(anonymous && same_parent && assistant)
        });
    }

    fn forget(&mut self, k: &str) {
        self.open.shift_remove(k);
        self.pending_progress.shift_remove(k);
        self.progress_at.shift_remove(k);
    }

    fn open_turn(&mut self, turn: Option<&str>, parent_ref: Option<&str>) -> String {
        let parent = self.parent_of(parent_ref);
        let turn_id = match turn {
            Some(turn) => self.turn_id(turn),
            None => self.turn_id(&random_uuid()),
        };
        let mut draft = typed("turn/started");
        put(&mut draft, "parentToolCallId", parent.clone());
        self.send(Some(&turn_id), draft);
        if parent.is_some() {
            return turn_id;
        }
        for client_request_id in std::mem::take(&mut self.accepted) {
            self.send_accepted(&turn_id, &client_request_id);
        }
        turn_id
    }

    fn send_accepted(&mut self, turn_id: &str, client_request_id: &str) {
        let mut draft = typed("turn/input/accepted");
        draft.insert("clientRequestId".to_owned(), Value::from(client_request_id));
        self.send(Some(turn_id), draft);
    }

    fn send_item(&mut self, turn_id: &str, kind: &str, item: Value) {
        let mut draft = typed(kind);
        draft.insert("item".to_owned(), item);
        self.send(Some(turn_id), draft);
    }

    fn send_turn_completed(
        &mut self,
        turn_id: &str,
        status: &str,
        message: Option<&str>,
        provider_checkpoint_id: Option<&str>,
    ) {
        let mut draft = typed("turn/completed");
        draft.insert("status".to_owned(), Value::from(status));
        let error = message.filter(|message| !message.is_empty());
        put(&mut draft, "error", error.map(|message| json!({ "message": message })));
        put(&mut draft, "providerCheckpointId", provider_checkpoint_id);
        self.send(Some(turn_id), draft);
        let ended: Vec<String> = self
            .open
            .iter()
            .filter(|(_, item)| item.turn_id == turn_id && !is_thread_attached(&item.shape))
            .map(|(k, _)| k.clone())
            .collect();
        for k in ended {
            self.forget(&k);
        }
    }

    fn delta(&mut self, key: &ItemKey, channel: DeltaChannel, delta: &str, turn: Option<&str>) {
        let Some(turn_id) = self.target(turn, false) else { return };
        let k = key.joined();
        let parent = self.parent_of(key.parent_ref.as_deref());
        let mut item_id = match self.open.get(&k) {
            Some(open) => Some(open.id.clone()),
            None => self.known_item_id(key),
        };
        let text_channel = match channel {
            DeltaChannel::Text(text_channel) => text_channel,
            DeltaChannel::Command | DeltaChannel::FileChange => {
                let Some(item_id) = item_id else { return };
                let kind = if channel == DeltaChannel::Command {
                    "item/commandExecution/outputDelta"
                } else {
                    "item/fileChange/outputDelta"
                };
                self.send_delta(&turn_id, kind, item_id, delta, parent);
                return;
            }
        };
        if item_id.is_none() {
            let id = self.resolve_item_id(key, None);
            let shape = text_shape(text_channel.item_type(), "", "");
            let open = OpenItem {
                id: id.clone(),
                key: key.clone(),
                shape: shape.clone(),
                presentation: None,
                parent: parent.clone(),
                turn_id: turn_id.clone(),
                text: String::new(),
                summary: String::new(),
            };
            self.open.insert(k.clone(), open);
            let item = build_item(&shape, &id, "pending", None, parent.clone(), false);
            self.send_item(&turn_id, "item/started", item);
            item_id = Some(id);
        }
        if let Some(open) = self.open.get_mut(&k) {
            if text_channel == TextChannel::ReasoningSummary {
                open.summary.push_str(delta);
            } else {
                open.text.push_str(delta);
            }
        }
        let item_id = item_id.unwrap_or_default();
        self.send_delta(&turn_id, text_channel.event_type(), item_id, delta, parent);
    }

    fn send_delta(
        &mut self,
        turn_id: &str,
        kind: &str,
        item_id: String,
        delta: &str,
        parent: Option<String>,
    ) {
        let mut draft = typed(kind);
        draft.insert("itemId".to_owned(), Value::from(item_id));
        draft.insert("delta".to_owned(), Value::from(delta));
        put(&mut draft, "parentToolCallId", parent);
        self.send(Some(turn_id), draft);
    }

    fn text_close(
        &mut self,
        key: &ItemKey,
        channel: TextChannel,
        text: Option<&str>,
        turn: Option<&str>,
    ) {
        let Some(turn_id) = self.target(turn, false) else { return };
        let k = key.joined();
        let open = self.open.shift_remove(&k);
        let summary_channel = channel == TextChannel::ReasoningSummary;
        let final_text = match text {
            Some(text) => Some(text.to_owned()),
            None => {
                open.as_ref().map(|o| if summary_channel { &o.summary } else { &o.text }.clone())
            }
        };
        let Some(final_text) = final_text.filter(|t| !t.is_empty()) else { return };
        if text.is_none() && final_text.trim().is_empty() {
            return;
        }
        let open_type = open.as_ref().map_or("", |open| type_of(&open.shape));
        let kind = if is_text_item_type(open_type) { open_type } else { channel.item_type() };
        let open_text = open.as_ref().map_or("", |open| open.text.as_str());
        let open_summary = open.as_ref().map_or("", |open| open.summary.as_str());
        let shape = if summary_channel {
            text_shape(kind, open_text, &final_text)
        } else {
            text_shape(kind, &final_text, open_summary)
        };
        let id = self.resolve_item_id(key, open.as_ref());
        let parent = self
            .parent_of(key.parent_ref.as_deref())
            .or_else(|| open.as_ref().and_then(|open| open.parent.clone()));
        let presentation = open.as_ref().and_then(|open| open.presentation.clone());
        let item = build_item(&shape, &id, "completed", presentation, parent, false);
        self.send_item(&turn_id, "item/completed", item);
    }

    fn settle(&mut self, status: &str, error: Option<&str>) {
        self.flush();
        if self.live_turns.is_empty() && !self.accepted.is_empty() {
            self.open_turn(None, None);
        }
        let keys: Vec<String> = self.open.keys().cloned().collect();
        for k in keys {
            let Some(open) = self.open.get(&k).cloned() else { continue };
            if is_thread_attached(&open.shape) || !self.live_turns.contains(&open.turn_id) {
                continue;
            }
            self.open.shift_remove(&k);
            let streamed = !open.text.is_empty() || !open.summary.is_empty();
            let kind = type_of(&open.shape);
            let settled = if streamed && is_text_item_type(kind) {
                text_shape(kind, &open.text, &open.summary)
            } else {
                open.shape.clone()
            };
            let item =
                build_item(&settled, &open.id, status, open.presentation, open.parent, false);
            self.send_item(&open.turn_id, "item/completed", item);
        }
        let live: Vec<String> = self.live_turns.iter().rev().cloned().collect();
        for turn_id in live {
            self.send_turn_completed(&turn_id, status, error, None);
        }
    }

    fn flush(&mut self) {
        if self.pending_text.is_empty() {
            return;
        }
        for (stream, event) in std::mem::take(&mut self.pending_text) {
            self.out(event);
            let now = (self.now)();
            self.text_at.insert(stream, now);
        }
    }

    fn draft(&self, turn_id: Option<&str>, mut draft: Map<String, Value>) -> Value {
        let scope = match turn_id {
            None => json!({ "kind": "thread" }),
            Some(turn_id) => json!({ "kind": "turn", "turnId": turn_id }),
        };
        draft.insert("providerThreadId".to_owned(), Value::from(""));
        draft.insert("scope".to_owned(), scope);
        Value::Object(draft)
    }

    fn send(&mut self, turn_id: Option<&str>, draft: Map<String, Value>) {
        let event = self.draft(turn_id, draft);
        self.push(event);
    }

    fn push(&mut self, event: Value) {
        self.flush_due();
        if self.text_flush_ms > 0 && event.get("delta").is_some() {
            return self.buffer_text(event);
        }
        self.flush();
        self.out(event);
    }

    fn flush_due(&mut self) {
        let now = (self.now)();
        let text_due = self.pending_text.keys().any(|stream| {
            self.text_at.get(stream).is_none_or(|last| now - last >= self.text_flush_ms)
        });
        if text_due {
            self.flush();
        }
        let due: Vec<String> = self
            .pending_progress
            .keys()
            .filter(|k| self.progress_at.get(*k).is_none_or(|at| now - at >= self.progress_ms))
            .cloned()
            .collect();
        let mut events = Vec::with_capacity(due.len());
        for k in due {
            if let Some(event) = self.pending_progress.shift_remove(&k) {
                events.push(event);
            }
            self.progress_at.insert(k, now);
        }
        for event in events {
            self.push(event);
        }
    }

    fn buffer_text(&mut self, event: Value) {
        let item_id = event.get("itemId").and_then(Value::as_str).unwrap_or("");
        let stream = format!("{}{SEP}{item_id}", type_of(&event));
        let Some(last_emit) = self.text_at.get(&stream).copied() else {
            self.flush();
            self.out(event);
            let now = (self.now)();
            self.text_at.insert(stream, now);
            trim_map(&mut self.text_at, MAX_TRACKED);
            return;
        };
        let text =
            |event: &Value| event.get("delta").and_then(Value::as_str).unwrap_or("").to_owned();
        let pending = self.pending_text.get(&stream).cloned();
        let delta = pending.as_ref().map(text).unwrap_or_default() + &text(&event);
        let mut merged = pending.unwrap_or(event);
        if let Some(object) = merged.as_object_mut() {
            object.insert("delta".to_owned(), Value::from(delta));
        }
        self.pending_text.insert(stream, merged);
        if (self.now)() - last_emit >= self.text_flush_ms {
            self.flush();
        }
    }

    fn out(&mut self, event: Value) {
        if !self.allowed(&event) {
            return;
        }
        if self.identity_id.is_none() {
            self.held.push(event);
        } else {
            let stamped = self.stamp(event);
            self.outbox.push(stamped);
        }
    }

    fn stamp(&self, mut event: Value) -> Value {
        let Some(identity) = self.identity_id.as_deref().filter(|id| !id.is_empty()) else {
            return event;
        };
        if let Some(slot) = event.get_mut("providerThreadId")
            && !truthy(Some(slot))
        {
            *slot = Value::from(identity);
        }
        event
    }

    fn allowed(&mut self, event: &Value) -> bool {
        let scope = event.get("scope");
        let turn_id = match scope.and_then(|scope| scope.get("kind")).and_then(Value::as_str) {
            Some("turn") => {
                scope.and_then(|scope| scope.get("turnId")).and_then(Value::as_str).unwrap_or("")
            }
            _ => "",
        }
        .to_owned();
        let item_id = event
            .get("item")
            .and_then(|item| item.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        match type_of(event) {
            "turn/started" => {
                if self.live_turns.contains(&turn_id) || self.done_turns.contains(&turn_id) {
                    return false;
                }
                self.live_turns.insert(turn_id.clone());
                if event.get("parentToolCallId").is_none() {
                    self.root_turn = Some(turn_id);
                }
                true
            }
            "turn/completed" => {
                if !self.live_turns.shift_remove(&turn_id) {
                    return false;
                }
                self.done_turns.insert(turn_id.clone());
                trim_set(&mut self.done_turns, MAX_GUARDED);
                if self.root_turn.as_deref() != Some(turn_id.as_str()) {
                    return true;
                }
                self.root_turn = None;
                self.last_root_turn = Some(turn_id);
                true
            }
            "item/started" => {
                self.done_items.shift_remove(&item_id);
                self.live_items.insert(item_id);
                trim_set(&mut self.live_items, MAX_GUARDED);
                true
            }
            "item/completed" | "item/backgroundTask/completed" | "item/delegation/completed" => {
                if self.done_items.contains(&item_id) {
                    return false;
                }
                self.live_items.shift_remove(&item_id);
                self.done_items.insert(item_id);
                trim_set(&mut self.done_items, MAX_GUARDED);
                true
            }
            "item/backgroundTask/progress" => self.live_items.contains(&item_id),
            _ => match event.get("itemId") {
                None => true,
                Some(id) => id.as_str().is_some_and(|id| self.live_items.contains(id)),
            },
        }
    }
}
