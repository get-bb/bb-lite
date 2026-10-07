use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Weak, mpsc};
use std::time::Duration;

use base64::Engine;
use base64::alphabet;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use bb_core::env::EnvMap;
use bb_core::exec::{Ctx, require_absolute};
use bb_core::{RunnerError, RunnerErrorCode, RunnerEvent, RunnerEventBody, RunnerResult, fail};
use indexmap::IndexMap;
use parking_lot::Mutex;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc as channel;
use tokio::task::AbortHandle;
use tokio::time::Instant;

use crate::is_executable;
use crate::lines::Utf8Decoder;

pub const TERMINAL_REPLAY_MAX_BYTES: usize = 512 * 1024;
const SCROLLBACK_MAX_BYTES: usize = 4 * 1024 * 1024;
const SCROLLBACK_MAX_CHUNKS: usize = 10_000;
const OUTPUT_CHUNK_MAX_BYTES: usize = 64 * 1024;
const OUTPUT_BATCH_DELAY_MS: u64 = 4;
const CLOSE_GRACE_MS: u64 = 2_000;
const EXITED_RETENTION_MS: u64 = 30 * 60 * 1000;
const EXITED_MAX_TERMINALS: usize = 32;
const EXITED_SCROLLBACK_MAX_BYTES: usize = 512 * 1024;
const TITLE_MAX_LENGTH: usize = 80;
const DEVICE_ATTRIBUTES_QUERIES: [&str; 2] = ["\u{1b}[0c", "\u{1b}[c"];
const DEVICE_ATTRIBUTES_PARTIALS: [&str; 3] = ["\u{1b}[0", "\u{1b}[", "\u{1b}"];
const DEVICE_ATTRIBUTES_REPLY: &str = "\u{1b}[?1;2c";
const DEVICE_ATTRIBUTES_MAX_REPLIES: usize = 8;
const LENIENT_BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);
const READER_DRAIN_MS: u64 = 250;
const TERMINAL_ENV: [(&str, &str); 5] = [
    ("COLORTERM", "truecolor"),
    ("DISABLE_AUTO_TITLE", "true"),
    ("FORCE_HYPERLINK", "1"),
    ("PROMPT_EOL_MARK", ""),
    ("TERM", "xterm-256color"),
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum TerminalStart {
    Shell,
    Command { command: String },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTerminalArgs {
    pub terminal_id: String,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub start: TerminalStart,
    pub env: EnvMap,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpened {
    pub shell: String,
    pub title: String,
    pub initial_cwd: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachTerminalArgs {
    pub terminal_id: String,
    pub since_seq: u64,
    pub tail_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputChunk {
    pub seq: u64,
    pub data_base64: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub exit_code: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReplay {
    pub chunks: Vec<TerminalOutputChunk>,
    pub replay_start_seq: u64,
    pub next_seq: u64,
    pub exited: Option<TerminalExit>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteTerminalArgs {
    pub terminal_id: String,
    pub data_base64: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeTerminalArgs {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRef {
    pub terminal_id: String,
}

enum Output {
    Data(String),
    Exit(Option<i32>),
}

#[derive(Default)]
struct State {
    next_seq: u64,
    scrollback: VecDeque<(TerminalOutputChunk, usize)>,
    scrollback_bytes: usize,
    pending: Vec<u8>,
    flush_at: Option<Instant>,
    partial_query: String,
    close_timer: Option<AbortHandle>,
    exited: Option<TerminalExit>,
    cols: u16,
    rows: u16,
}

struct Terminal {
    id: String,
    state: Mutex<State>,
    input: mpsc::Sender<Vec<u8>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
}

struct Inner {
    ctx: Ctx,
    terminals: Mutex<IndexMap<String, Arc<Terminal>>>,
}

/// The PTY sessions of one machine, with their replay buffers.
#[derive(Clone)]
pub struct Terminals {
    inner: Arc<Inner>,
}

fn pty_error(error: impl std::fmt::Display) -> RunnerError {
    RunnerError::failed(error.to_string())
}

fn resolve_shell() -> String {
    let from_env = std::env::var("SHELL").ok().filter(|shell| !shell.is_empty());
    let candidates = from_env.into_iter().chain(["/bin/zsh".into(), "/bin/bash".into()]);
    candidates
        .into_iter()
        .find(|shell| is_executable(Path::new(shell)))
        .unwrap_or_else(|| "/bin/sh".into())
}

fn title_for(start: &TerminalStart, shell: &str) -> String {
    let command = match start {
        TerminalStart::Shell => {
            let name = Path::new(shell).file_name().map(|name| name.to_string_lossy());
            return name.filter(|name| !name.is_empty()).map_or("Terminal".into(), |n| n.into());
        }
        TerminalStart::Command { command } => command.split_whitespace().collect::<Vec<_>>(),
    };
    let command = command.join(" ");
    if command.chars().count() <= TITLE_MAX_LENGTH {
        return command;
    }
    let head: String = command.chars().take(TITLE_MAX_LENGTH - 3).collect();
    format!("{head}...")
}

fn strip_device_attribute_queries(text: &str) -> (String, usize) {
    let (mut output, mut queries, mut rest) = (String::with_capacity(text.len()), 0, text);
    while let Some(at) = rest.find('\u{1b}') {
        output.push_str(&rest[..at]);
        rest = &rest[at..];
        match DEVICE_ATTRIBUTES_QUERIES.iter().find(|query| rest.starts_with(**query)) {
            Some(query) => {
                queries += 1;
                rest = &rest[query.len()..];
            }
            None => {
                output.push('\u{1b}');
                rest = &rest[1..];
            }
        }
    }
    output.push_str(rest);
    (output, queries)
}

fn trim_scrollback(state: &mut State, max_bytes: usize) {
    while state.scrollback.len() > 1
        && (state.scrollback_bytes > max_bytes || state.scrollback.len() > SCROLLBACK_MAX_CHUNKS)
    {
        if let Some((_, bytes)) = state.scrollback.pop_front() {
            state.scrollback_bytes -= bytes;
        }
    }
}

fn flush(terminal: &Terminal, state: &mut State) -> Vec<RunnerEvent> {
    state.flush_at = None;
    let output = std::mem::take(&mut state.pending);
    let mut events = Vec::new();
    for bytes in output.chunks(OUTPUT_CHUNK_MAX_BYTES) {
        let chunk = TerminalOutputChunk { seq: state.next_seq, data_base64: BASE64.encode(bytes) };
        state.next_seq += 1;
        state.scrollback.push_back((chunk.clone(), bytes.len()));
        state.scrollback_bytes += bytes.len();
        trim_scrollback(state, SCROLLBACK_MAX_BYTES);
        events.push(RunnerEvent::terminal_output(
            terminal.id.clone(),
            chunk.seq,
            chunk.data_base64,
        ));
    }
    events
}

fn kill(terminal: &Terminal, signal: libc::c_int) {
    if !crate::signal_group(terminal.pid, signal) {
        let _ = terminal.killer.lock().kill();
    }
}

impl Terminals {
    pub fn new(ctx: Ctx) -> Self {
        Self { inner: Arc::new(Inner { ctx, terminals: Mutex::default() }) }
    }

    fn emit(&self, events: Vec<RunnerEvent>) {
        events.into_iter().for_each(|event| (self.inner.ctx.sink)(event));
    }

    fn find(&self, terminal_id: &str, live: bool) -> RunnerResult<Arc<Terminal>> {
        let terminal = self.inner.terminals.lock().get(terminal_id).cloned();
        match terminal {
            Some(terminal) if !live || terminal.state.lock().exited.is_none() => Ok(terminal),
            _ => fail(
                RunnerErrorCode::TerminalNotFound,
                format!("Terminal is not open: {terminal_id}"),
            ),
        }
    }

    fn forget(&self, terminal: &Arc<Terminal>) {
        let mut terminals = self.inner.terminals.lock();
        if terminals.get(&terminal.id).is_some_and(|current| Arc::ptr_eq(current, terminal)) {
            terminals.shift_remove(&terminal.id);
        }
    }

    fn receive(&self, terminal: &Arc<Terminal>, data: &str) -> Option<Instant> {
        let mut state = terminal.state.lock();
        if state.exited.is_some() {
            return None;
        }
        let input = std::mem::take(&mut state.partial_query) + data;
        let held = DEVICE_ATTRIBUTES_PARTIALS.iter().find(|partial| input.ends_with(**partial));
        let held = held.map_or("", |partial| *partial);
        let complete = &input[..input.len() - held.len()];
        state.partial_query = held.to_owned();
        let (output, queries) = strip_device_attribute_queries(complete);
        if queries > 0 {
            let replies = queries.min(DEVICE_ATTRIBUTES_MAX_REPLIES);
            let _ = terminal.input.send(DEVICE_ATTRIBUTES_REPLY.repeat(replies).into_bytes());
        }
        state.pending.extend_from_slice(output.as_bytes());
        if state.pending.len() >= OUTPUT_CHUNK_MAX_BYTES {
            let events = flush(terminal, &mut state);
            drop(state);
            self.emit(events);
            return None;
        }
        let delay = Duration::from_millis(OUTPUT_BATCH_DELAY_MS);
        Some(*state.flush_at.get_or_insert_with(|| Instant::now() + delay))
    }

    fn flush_due(&self, terminal: &Arc<Terminal>) {
        let mut state = terminal.state.lock();
        if state.flush_at.is_some_and(|at| at <= Instant::now()) {
            let events = flush(terminal, &mut state);
            drop(state);
            self.emit(events);
        }
    }

    fn finish(&self, terminal: &Arc<Terminal>, exit_code: Option<i32>) {
        let mut state = terminal.state.lock();
        if state.exited.is_some() {
            return;
        }
        let partial = std::mem::take(&mut state.partial_query);
        state.pending.extend_from_slice(partial.as_bytes());
        let mut events = flush(terminal, &mut state);
        if let Some(timer) = &state.close_timer {
            timer.abort();
        }
        state.exited = Some(TerminalExit { exit_code });
        trim_scrollback(&mut state, EXITED_SCROLLBACK_MAX_BYTES);
        drop(state);
        let weak = Arc::downgrade(&self.inner);
        let retained = Arc::downgrade(terminal);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                tokio::time::sleep(Duration::from_millis(EXITED_RETENTION_MS)).await;
                if let (Some(inner), Some(terminal)) = (weak.upgrade(), retained.upgrade()) {
                    Terminals { inner }.forget(&terminal);
                }
            });
        }
        let all: Vec<Arc<Terminal>> = self.inner.terminals.lock().values().cloned().collect();
        let exited: Vec<_> = all.into_iter().filter(|t| t.state.lock().exited.is_some()).collect();
        let excess = exited.len().saturating_sub(EXITED_MAX_TERMINALS);
        exited[..excess].iter().for_each(|old| self.forget(old));
        let terminal_id = terminal.id.clone();
        events.push(RunnerEvent::unsequenced(RunnerEventBody::TerminalExited {
            terminal_id,
            exit_code,
        }));
        self.emit(events);
    }

    fn pump(&self, terminal: Arc<Terminal>, mut output: channel::UnboundedReceiver<Output>) {
        let weak: Weak<Inner> = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            let mut flush_at: Option<Instant> = None;
            loop {
                let wake = async {
                    match flush_at {
                        Some(at) => tokio::time::sleep_until(at).await,
                        None => std::future::pending().await,
                    }
                };
                let received = tokio::select! {
                    received = output.recv() => Some(received),
                    () = wake => None,
                };
                let Some(inner) = weak.upgrade() else { return };
                let terminals = Terminals { inner };
                match received {
                    None => {
                        flush_at = None;
                        terminals.flush_due(&terminal);
                    }
                    Some(Some(Output::Data(text))) => {
                        flush_at = terminals.receive(&terminal, &text)
                    }
                    Some(Some(Output::Exit(code))) => return terminals.finish(&terminal, code),
                    Some(None) => return,
                }
            }
        });
    }

    async fn open_now(&self, args: OpenTerminalArgs) -> RunnerResult<TerminalOpened> {
        let previous = self.inner.terminals.lock().get(&args.terminal_id).cloned();
        if previous.is_some_and(|previous| previous.state.lock().exited.is_none()) {
            return fail(RunnerErrorCode::Conflict, "Terminal session is already open");
        }
        if cfg!(windows) {
            return fail(
                RunnerErrorCode::Unavailable,
                "Native Windows terminals are not supported",
            );
        }
        let home = std::env::home_dir().map(|home| home.display().to_string()).unwrap_or_default();
        let cwd =
            require_absolute(args.cwd.as_deref().unwrap_or(&home), "Terminal cwd")?.to_owned();
        if !tokio::fs::metadata(&cwd).await?.is_dir() {
            let message = format!("Terminal cwd is not a directory: {cwd}");
            return fail(RunnerErrorCode::InvalidPath, message);
        }
        let shell = resolve_shell();
        let mut env = (self.inner.ctx.env)().await;
        env.extend(
            TERMINAL_ENV.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())),
        );
        env.insert("BB_TERMINAL_SESSION_ID".into(), args.terminal_id.clone());
        env.extend(args.env.clone());
        let mut command = CommandBuilder::new(&shell);
        match &args.start {
            TerminalStart::Shell => command.arg("-l"),
            TerminalStart::Command { command: line } => command.args(["-lc", line]),
        }
        command.cwd(&cwd);
        command.env_clear();
        env.iter().for_each(|(key, value)| command.env(key, value));
        let (cols, rows) = (args.cols, args.rows);
        let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
        let pair = native_pty_system().openpty(size).map_err(pty_error)?;
        let mut child = pair.slave.spawn_command(command).map_err(pty_error)?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(pty_error)?;
        let writer = pair.master.take_writer().map_err(pty_error)?;
        let (input, inputs) = mpsc::channel::<Vec<u8>>();
        let terminal = Arc::new(Terminal {
            id: args.terminal_id.clone(),
            state: Mutex::new(State { cols, rows, ..State::default() }),
            input,
            master: Mutex::new(pair.master),
            killer: Mutex::new(child.clone_killer()),
            pid: child.process_id(),
        });
        self.inner.terminals.lock().insert(terminal.id.clone(), terminal.clone());
        let (output, outputs) = channel::unbounded_channel();
        let (read_done, reader_finished) = mpsc::channel::<()>();
        spawn_writer(writer, inputs);
        spawn_reader(reader, output.clone(), read_done);
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code() as i32);
            let _ = reader_finished.recv_timeout(Duration::from_millis(READER_DRAIN_MS));
            let _ = output.send(Output::Exit(code));
        });
        self.pump(terminal, outputs);
        let title = title_for(&args.start, &shell);
        Ok(TerminalOpened { shell, title, initial_cwd: cwd, cols, rows })
    }

    pub async fn open(&self, args: OpenTerminalArgs) -> RunnerResult<TerminalOpened> {
        let key = format!("terminal:{}", args.terminal_id);
        self.inner.ctx.lock.run(&key, self.open_now(args)).await
    }

    pub async fn attach(&self, args: AttachTerminalArgs) -> RunnerResult<TerminalReplay> {
        let terminal = self.find(&args.terminal_id, false)?;
        let mut state = terminal.state.lock();
        let events = flush(&terminal, &mut state);
        let mut window: VecDeque<&(TerminalOutputChunk, usize)> =
            state.scrollback.iter().filter(|(chunk, _)| chunk.seq >= args.since_seq).collect();
        let mut bytes: usize = window.iter().map(|(_, bytes)| bytes).sum();
        while window.len() > 1 && bytes > args.tail_bytes {
            bytes -= window.pop_front().map_or(0, |(_, bytes)| *bytes);
        }
        while window.len() > 1 && bytes > TERMINAL_REPLAY_MAX_BYTES {
            bytes -= window.pop_back().map_or(0, |(_, bytes)| *bytes);
        }
        let replay = TerminalReplay {
            replay_start_seq: window.front().map_or(state.next_seq, |(chunk, _)| chunk.seq),
            chunks: window.into_iter().map(|(chunk, _)| chunk.clone()).collect(),
            next_seq: state.next_seq,
            exited: state.exited,
        };
        drop(state);
        self.emit(events);
        Ok(replay)
    }

    pub async fn write(&self, args: WriteTerminalArgs) -> RunnerResult<()> {
        let terminal = self.find(&args.terminal_id, true)?;
        let bytes = LENIENT_BASE64.decode(args.data_base64.trim()).unwrap_or_default();
        let _ = terminal.input.send(bytes);
        Ok(())
    }

    pub async fn resize(&self, args: ResizeTerminalArgs) -> RunnerResult<()> {
        let terminal = self.find(&args.terminal_id, true)?;
        let mut state = terminal.state.lock();
        if state.cols != args.cols || state.rows != args.rows {
            (state.cols, state.rows) = (args.cols, args.rows);
            let size =
                PtySize { rows: args.rows, cols: args.cols, pixel_width: 0, pixel_height: 0 };
            terminal.master.lock().resize(size).map_err(pty_error)?;
        }
        Ok(())
    }

    pub async fn close(&self, args: TerminalRef) -> RunnerResult<()> {
        let Some(terminal) = self.inner.terminals.lock().get(&args.terminal_id).cloned() else {
            return Ok(());
        };
        let mut state = terminal.state.lock();
        if state.exited.is_some() || state.close_timer.is_some() {
            return Ok(());
        }
        let (this, target) = (self.clone(), terminal.clone());
        let timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(CLOSE_GRACE_MS)).await;
            kill(&target, libc::SIGKILL);
            this.finish(&target, None);
        });
        state.close_timer = Some(timer.abort_handle());
        drop(state);
        kill(&terminal, libc::SIGHUP);
        Ok(())
    }

    pub fn live_ids(&self) -> Vec<String> {
        let terminals = self.inner.terminals.lock();
        let live = terminals.values().filter(|terminal| terminal.state.lock().exited.is_none());
        live.map(|terminal| terminal.id.clone()).collect()
    }

    pub fn dispose(&self) {
        let all: Vec<Arc<Terminal>> = self.inner.terminals.lock().values().cloned().collect();
        for terminal in all {
            if terminal.state.lock().exited.is_none() {
                kill(&terminal, libc::SIGKILL);
                self.finish(&terminal, None);
            }
            self.forget(&terminal);
        }
    }
}

fn spawn_writer(mut writer: Box<dyn Write + Send>, inputs: mpsc::Receiver<Vec<u8>>) {
    std::thread::spawn(move || {
        for bytes in inputs {
            if writer.write_all(&bytes).and_then(|()| writer.flush()).is_err() {
                return;
            }
        }
    });
}

fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    output: channel::UnboundedSender<Output>,
    done: mpsc::Sender<()>,
) {
    std::thread::spawn(move || {
        let mut decoder = Utf8Decoder::default();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let text = decoder.push(&buffer[..read]);
                    if !text.is_empty() && output.send(Output::Data(text)).is_err() {
                        return;
                    }
                }
            }
        }
        let rest = decoder.finish();
        if !rest.is_empty() {
            let _ = output.send(Output::Data(rest));
        }
        let _ = done.send(());
    });
}
