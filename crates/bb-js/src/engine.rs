use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use base64::Engine as _;
use parking_lot::Mutex;
use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::module::Declared;
use rquickjs::{Context, Ctx, Error as QjsError, Function, Module, Object, Runtime, TypedArray};
use serde_json::{Value, json};

use crate::{Command, ConsoleFn, JsError, JsRuntimeOptions, Registry, Reply, Target};

const BOOTSTRAP: &str = include_str!("js/bootstrap.js");

#[derive(Default)]
struct Shared {
    settled: Mutex<Vec<(u64, bool, String)>>,
    timers: Mutex<HashMap<u64, Instant>>,
    rejections: AtomicBool,
}

struct Engine {
    ctx: Context,
    rt: Runtime,
    shared: Arc<Shared>,
    deadline: Arc<AtomicU64>,
    epoch: Instant,
    limit: Duration,
    console: Option<ConsoleFn>,
    pending: HashMap<u64, Reply>,
    next_call: u64,
}

pub(crate) fn spawn(
    options: JsRuntimeOptions,
    handle: tokio::runtime::Handle,
    registry: Arc<Registry>,
    tx: mpsc::Sender<Command>,
    rx: mpsc::Receiver<Command>,
) -> Result<(), JsError> {
    let (init_tx, init_rx) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("bb-js".into())
        .stack_size(16 << 20)
        .spawn(move || match Engine::new(options, handle, registry, tx) {
            Ok(engine) => {
                let _ = init_tx.send(Ok(()));
                engine.run(rx);
            }
            Err(e) => {
                let _ = init_tx.send(Err(e));
            }
        })
        .map_err(|e| JsError::new("Error", format!("cannot start the JavaScript thread: {e}")))?;
    init_rx.recv().map_err(|_| JsError::stopped())?
}

fn qjs_err(e: QjsError) -> JsError {
    JsError::new("Error", e.to_string())
}

fn js_error(ctx: &Ctx<'_>, e: QjsError) -> JsError {
    if !matches!(e, QjsError::Exception) {
        return qjs_err(e);
    }
    let value = ctx.catch();
    if let Some(obj) = value.as_object() {
        let get = |k: &str| obj.get::<_, Option<String>>(k).ok().flatten();
        return JsError {
            name: get("name").unwrap_or_else(|| "Error".into()),
            message: get("message").unwrap_or_default(),
            stack: get("stack").filter(|s| !s.is_empty()),
        };
    }
    let message = match value.as_string() {
        Some(s) => s.to_string().unwrap_or_default(),
        None => format!("{value:?}"),
    };
    JsError::new("Error", message)
}

impl Engine {
    fn new(
        options: JsRuntimeOptions,
        handle: tokio::runtime::Handle,
        registry: Arc<Registry>,
        tx: mpsc::Sender<Command>,
    ) -> Result<Self, JsError> {
        let rt = Runtime::new().map_err(qjs_err)?;
        if let Some(limit) = options.memory_limit {
            rt.set_memory_limit(limit);
        }
        rt.set_max_stack_size(8 << 20);
        let epoch = Instant::now();
        let deadline = Arc::new(AtomicU64::new(0));
        let flag = deadline.clone();
        rt.set_interrupt_handler(Some(Box::new(move || {
            let d = flag.load(Ordering::Relaxed);
            d != 0 && epoch.elapsed().as_micros() as u64 > d
        })));
        rt.set_loader(ModuleResolver(registry.clone()), ModuleLoader(registry.clone()));
        let ctx = Context::full(&rt).map_err(qjs_err)?;
        let shared = Arc::new(Shared::default());
        let tracked = shared.clone();
        rt.set_host_promise_rejection_tracker(Some(Box::new(
            move |ctx, promise, reason, handled| {
                let track = ctx
                    .globals()
                    .get::<_, Object>("__bb_internal")
                    .and_then(|internal| internal.get::<_, Function>("track"));
                if let Ok(track) = track
                    && track.call::<_, ()>((promise, reason, handled)).is_ok()
                {
                    tracked.rejections.store(true, Ordering::Relaxed);
                }
            },
        )));
        let console = options.console.clone();
        ctx.with(|ctx| {
            install_native(&ctx, &shared, registry, handle, tx, console.clone())
                .and_then(|()| ctx.eval::<(), _>(BOOTSTRAP))
                .map_err(|e| js_error(&ctx, e))
        })?;
        Ok(Self {
            ctx,
            rt,
            shared,
            deadline,
            epoch,
            limit: options.deadline,
            console,
            pending: HashMap::new(),
            next_call: 1,
        })
    }

    fn run(mut self, rx: mpsc::Receiver<Command>) {
        let mut done = None;
        'outer: loop {
            let wait = self
                .next_timer()
                .map(|t| t.saturating_duration_since(Instant::now()))
                .unwrap_or(Duration::from_secs(3600));
            let mut next = match rx.recv_timeout(wait) {
                Ok(cmd) => Some(cmd),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            while let Some(cmd) = next {
                if let Command::Shutdown(reply) = cmd {
                    done = reply;
                    break 'outer;
                }
                self.handle(cmd);
                self.pump();
                next = rx.try_recv().ok();
            }
            self.fire_timers();
            self.pump();
            self.flush_settled();
        }
        self.pending.clear();
        drop(self);
        if let Some(done) = done {
            let _ = done.send(());
        }
    }

    fn arm(&self) {
        let until = self.epoch.elapsed() + self.limit;
        self.deadline.store((until.as_micros() as u64).max(1), Ordering::Relaxed);
    }

    fn enter<R>(
        &self,
        f: impl for<'js> FnOnce(Object<'js>) -> rquickjs::Result<R>,
    ) -> Result<R, JsError> {
        self.arm();
        let result = self.ctx.with(|ctx| {
            ctx.globals()
                .get::<_, Object>("__bb_internal")
                .and_then(f)
                .map_err(|e| js_error(&ctx, e))
        });
        self.deadline.store(0, Ordering::Relaxed);
        result
    }

    fn handle(&mut self, cmd: Command) {
        match cmd {
            Command::Call { target, arg, reply } => {
                let id = self.next_call;
                self.next_call += 1;
                self.pending.insert(id, reply);
                let call_id = id as f64;
                let result = self.enter(move |internal| match target {
                    Target::Load(name) => {
                        internal.get::<_, Function>("load")?.call::<_, ()>((call_id, name))
                    }
                    Target::Handler(handler) => internal
                        .get::<_, Function>("invoke")?
                        .call::<_, ()>((call_id, handler, arg)),
                    Target::Export(module, export) => internal
                        .get::<_, Function>("callExport")?
                        .call::<_, ()>((call_id, module, export, arg)),
                });
                if let Err(e) = result
                    && let Some(reply) = self.pending.remove(&id)
                {
                    let _ = reply.send(Err(e));
                }
            }
            Command::OpDone { id, result } => {
                let (ok, payload) = match result {
                    Ok(v) => (true, v.to_string()),
                    Err(message) => (false, message),
                };
                let result = self.enter(move |internal| {
                    internal.get::<_, Function>("opDone")?.call::<_, ()>((id as f64, ok, payload))
                });
                if let Err(e) = result {
                    self.uncaught(e);
                }
            }
            Command::Shutdown(_) => {}
        }
    }

    fn uncaught(&mut self, e: JsError) {
        self.report(&e);
        if e.name == "InternalError" && e.message == "interrupted" {
            for (_, reply) in self.pending.drain() {
                let _ = reply.send(Err(e.clone()));
            }
        }
    }

    fn report(&self, e: &JsError) {
        if let Some(console) = &self.console {
            let text = match &e.stack {
                Some(stack) => format!("Uncaught {e}\n{stack}"),
                None => format!("Uncaught {e}"),
            };
            console("error", &text);
        }
    }

    fn next_timer(&self) -> Option<Instant> {
        self.shared.timers.lock().values().min().copied()
    }

    fn fire_timers(&mut self) {
        let now = Instant::now();
        let mut due: Vec<(Instant, u64)> = {
            let timers = self.shared.timers.lock();
            timers.iter().filter(|(_, at)| **at <= now).map(|(id, at)| (*at, *id)).collect()
        };
        due.sort();
        for (at, id) in due {
            let still_due = {
                let mut timers = self.shared.timers.lock();
                let same = timers.get(&id) == Some(&at);
                if same {
                    timers.remove(&id);
                }
                same
            };
            if !still_due {
                continue;
            }
            let result = self.enter(move |internal| {
                internal.get::<_, Function>("fireTimer")?.call::<_, ()>((id as f64,))
            });
            if let Err(e) = result {
                self.uncaught(e);
            }
            self.pump();
        }
    }

    fn pump(&mut self) {
        self.arm();
        loop {
            match self.rt.execute_pending_job() {
                Ok(true) => {}
                Ok(false) => break,
                Err(ex) => {
                    let e = ex.0.with(|ctx| js_error(&ctx, QjsError::Exception));
                    self.uncaught(e);
                    self.arm();
                }
            }
        }
        self.deadline.store(0, Ordering::Relaxed);
        if self.shared.rejections.swap(false, Ordering::Relaxed) {
            let result = self
                .enter(|internal| internal.get::<_, Function>("flushUnhandled")?.call::<_, ()>(()));
            if let Err(e) = result {
                self.report(&e);
            }
        }
    }

    fn flush_settled(&mut self) {
        let settled = std::mem::take(&mut *self.shared.settled.lock());
        for (id, ok, json) in settled {
            let Some(reply) = self.pending.remove(&id) else { continue };
            let result = if ok {
                serde_json::from_str(&json).map_err(|e| JsError::new("TypeError", e.to_string()))
            } else {
                Err(serde_json::from_str(&json).unwrap_or_else(|_| JsError::new("Error", json)))
            };
            let _ = reply.send(result);
        }
    }
}

fn install_native<'js>(
    ctx: &Ctx<'js>,
    shared: &Arc<Shared>,
    registry: Arc<Registry>,
    handle: tokio::runtime::Handle,
    tx: mpsc::Sender<Command>,
    console: Option<ConsoleFn>,
) -> rquickjs::Result<()> {
    let native = Object::new(ctx.clone())?;
    native.set(
        "log",
        Function::new(ctx.clone(), move |level: String, message: String| {
            if let Some(console) = &console {
                console(&level, &message);
            }
        })?,
    )?;
    let reg = registry.clone();
    native.set(
        "op",
        Function::new(ctx.clone(), move |name: String, arg: String| -> String {
            let op = reg.sync_ops.lock().get(&name).cloned();
            let result = match op {
                Some(op) => op(serde_json::from_str(&arg).unwrap_or(Value::Null)),
                None => Err(format!("unknown op \"{name}\"")),
            };
            match result {
                Ok(v) => json!({ "ok": v }).to_string(),
                Err(e) => json!({ "err": e }).to_string(),
            }
        })?,
    )?;
    native.set(
        "opAsync",
        Function::new(ctx.clone(), move |id: f64, name: String, arg: String| {
            let op = registry.async_ops.lock().get(&name).cloned();
            let arg = serde_json::from_str(&arg).unwrap_or(Value::Null);
            let tx = tx.clone();
            let id = id as u64;
            handle.spawn(async move {
                let result = match op {
                    Some(op) => op(arg).await,
                    None => Err(format!("unknown op \"{name}\"")),
                };
                let _ = tx.send(Command::OpDone { id, result });
            });
        })?,
    )?;
    let timers = shared.clone();
    native.set(
        "setTimer",
        Function::new(ctx.clone(), move |id: f64, ms: f64| {
            let at = Instant::now() + Duration::from_millis(ms.clamp(0.0, 2_147_483_647.0) as u64);
            timers.timers.lock().insert(id as u64, at);
        })?,
    )?;
    let timers = shared.clone();
    native.set(
        "clearTimer",
        Function::new(ctx.clone(), move |id: f64| {
            timers.timers.lock().remove(&(id as u64));
        })?,
    )?;
    let settled = shared.clone();
    native.set(
        "settle",
        Function::new(ctx.clone(), move |id: f64, ok: bool, json: String| {
            settled.settled.lock().push((id as u64, ok, json));
        })?,
    )?;
    native.set(
        "urlParse",
        Function::new(ctx.clone(), |input: String, base: Option<String>| -> String {
            let parsed = match base {
                Some(base) => url::Url::parse(&base).and_then(|b| b.join(&input)),
                None => url::Url::parse(&input),
            };
            match parsed {
                Ok(u) => url_json(&u),
                Err(e) => json!({ "error": e.to_string() }).to_string(),
            }
        })?,
    )?;
    native.set(
        "urlSet",
        Function::new(ctx.clone(), |href: String, prop: String, value: String| -> String {
            use url::quirks;
            let Ok(mut u) = url::Url::parse(&href) else {
                return json!({ "error": "invalid URL" }).to_string();
            };
            match prop.as_str() {
                "protocol" => drop(quirks::set_protocol(&mut u, &value)),
                "username" => drop(quirks::set_username(&mut u, &value)),
                "password" => drop(quirks::set_password(&mut u, &value)),
                "host" => drop(quirks::set_host(&mut u, &value)),
                "hostname" => drop(quirks::set_hostname(&mut u, &value)),
                "port" => drop(quirks::set_port(&mut u, &value)),
                "pathname" => quirks::set_pathname(&mut u, &value),
                "search" => quirks::set_search(&mut u, &value),
                "hash" => quirks::set_hash(&mut u, &value),
                _ => {}
            }
            url_json(&u)
        })?,
    )?;
    native.set(
        "randomHex",
        Function::new(ctx.clone(), |n: f64| -> String {
            (0..n.max(0.0) as usize).map(|_| format!("{:02x}", rand::random::<u8>())).collect()
        })?,
    )?;
    // Base64 of request/response bodies and `Buffer` runs natively: a
    // JavaScript loop over a 25 MB upload outlives the run deadline.
    native.set(
        "base64Encode",
        Function::new(ctx.clone(), |bytes: TypedArray<'js, u8>| -> String {
            // SAFETY: the bytes are encoded before any JavaScript runs again,
            // so the buffer cannot be detached or resized while borrowed.
            BASE64_FORGIVING.encode(unsafe { bytes.as_bytes() }.unwrap_or_default())
        })?,
    )?;
    native.set(
        "base64Decode",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'js>, input: String| -> rquickjs::Result<Option<TypedArray<'js, u8>>> {
                let clean: Vec<u8> = input
                    .bytes()
                    .filter(|b| !matches!(b, b'\t' | b'\n' | b'\x0c' | b'\r' | b' '))
                    .collect();
                match BASE64_FORGIVING.decode(clean) {
                    Ok(bytes) => TypedArray::new(ctx, bytes).map(Some),
                    Err(_) => Ok(None),
                }
            },
        )?,
    )?;
    ctx.globals().set("__bb_native", native)
}

/// `atob` semantics: padding optional, non-zero trailing bits allowed.
const BASE64_FORGIVING: base64::engine::GeneralPurpose = base64::engine::GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    base64::engine::GeneralPurposeConfig::new()
        .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

fn url_json(u: &url::Url) -> String {
    use url::quirks as q;
    json!({
        "href": q::href(u),
        "origin": q::origin(u),
        "protocol": q::protocol(u),
        "username": q::username(u),
        "password": q::password(u),
        "host": q::host(u),
        "hostname": q::hostname(u),
        "port": q::port(u),
        "pathname": q::pathname(u),
        "search": q::search(u),
        "hash": q::hash(u),
    })
    .to_string()
}

struct ModuleResolver(Arc<Registry>);

impl Resolver for ModuleResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        if self.0.modules.lock().contains_key(name) {
            Ok(name.to_owned())
        } else {
            Err(QjsError::new_resolving(base, name))
        }
    }
}

struct ModuleLoader(Arc<Registry>);

impl Loader for ModuleLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js, Declared>> {
        let source = self.0.modules.lock().get(name).cloned();
        let source = source.ok_or_else(|| QjsError::new_loading(name))?;
        Module::declare(ctx.clone(), name, source)
    }
}
