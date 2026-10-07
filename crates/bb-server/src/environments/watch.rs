use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Weak};
use std::time::Duration;

use bb_core::RunnerEventBody;
use futures::FutureExt;
use parking_lot::Mutex;
use serde_json::json;
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::context::{Ctx, ServerContext};
use crate::db::environments::get_environment;
use crate::domain::changes::{ChangedMessage, EnvironmentChangeKind, RealtimeSubscriptionTarget};
use crate::domain::environment::{Environment, EnvironmentStatus};
use crate::environments::workspace::{ready_path, refresh_workspace_metadata};
use crate::runners::registry::Registration;
use crate::ws::hub::ListenerGuard;

const SYNC_DELAY: Duration = Duration::from_millis(100);
const RETARGETING_CHANGES: [&str; 8] = [
    "environment-created",
    "environment-deleted",
    "metadata-changed",
    "status-changed",
    "archived-changed",
    "environment-changed",
    "thread-created",
    "thread-deleted",
];

type EnvironmentIdsByPath = HashMap<String, Vec<String>>;

struct Sent {
    fingerprint: Vec<String>,
    set: EnvironmentIdsByPath,
}

#[derive(Default)]
struct State {
    targets: HashMap<String, String>,
    sent: HashMap<String, Sent>,
    generation: i64,
    scheduled: bool,
}

struct Watch {
    ctx: Weak<ServerContext>,
    state: Mutex<State>,
    stop: CancellationToken,
}

/// Stops the workspace watch when dropped.
pub struct WorkspaceWatch {
    _listeners: Vec<ListenerGuard>,
    _registrations: Vec<Registration>,
    _stop: DropGuard,
}

fn ready(environment: Option<Environment>) -> Option<Environment> {
    environment
        .filter(|found| found.status == EnvironmentStatus::Ready && !ready_path(found).is_empty())
}

impl Watch {
    fn wanted_by_host(&self, ctx: &Ctx, ids: Vec<String>) -> HashMap<String, EnvironmentIdsByPath> {
        let mut wanted: HashMap<String, EnvironmentIdsByPath> = HashMap::new();
        for environment_id in ids {
            let Some(found) = ready(get_environment(&ctx.db, &environment_id).ok().flatten())
            else {
                continue;
            };
            let paths = wanted.entry(found.host_id.clone()).or_default();
            paths.entry(ready_path(&found).to_owned()).or_default().push(found.id);
        }
        wanted
    }

    fn schedule(self: &Arc<Self>) {
        {
            let mut state = self.state.lock();
            if state.scheduled {
                return;
            }
            state.scheduled = true;
        }
        let watch = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                () = watch.stop.cancelled() => {}
                () = tokio::time::sleep(SYNC_DELAY) => watch.sync(),
            }
        });
    }

    fn sync(self: &Arc<Self>) {
        let Some(ctx) = self.ctx.upgrade() else { return };
        let ids: Vec<String> = {
            let mut state = self.state.lock();
            state.scheduled = false;
            state.targets.values().cloned().collect()
        };
        let mut wanted = self.wanted_by_host(&ctx, ids);
        let mut state = self.state.lock();
        let hosts: BTreeSet<String> = wanted.keys().chain(state.sent.keys()).cloned().collect();
        for host_id in hosts {
            let set = wanted.remove(&host_id);
            let is_wanted = set.is_some();
            let set = set.unwrap_or_default();
            let workspaces: Vec<String> =
                set.keys().cloned().collect::<BTreeSet<_>>().into_iter().collect();
            let unchanged =
                state.sent.get(&host_id).is_some_and(|sent| sent.fingerprint == workspaces);
            if !ctx.runners.is_connected(&host_id) {
                continue;
            }
            if is_wanted {
                state.sent.insert(host_id.clone(), Sent { fingerprint: workspaces.clone(), set });
            } else {
                state.sent.remove(&host_id);
            }
            if unchanged {
                continue;
            }
            state.generation = ctx.now().max(state.generation + 1);
            let params = json!({ "generation": state.generation, "workspaces": workspaces, "directories": [] });
            let Ok(runner) = ctx.runners.get(&host_id) else { continue };
            let watch = self.clone();
            let log = ctx.log.clone();
            tokio::spawn(async move {
                if let Err(error) = runner.call("setWatchedPaths", params).await {
                    watch.state.lock().sent.remove(&host_id);
                    let fields = json!({ "err": error.message, "hostId": host_id });
                    log.warn("Could not update watched paths", fields);
                }
            });
        }
    }

    fn refresh_metadata(ctx: &Ctx, environment_id: &str, refs: bool) {
        let Some(found) = ready(get_environment(&ctx.db, environment_id).ok().flatten()) else {
            return;
        };
        if !refs && found.is_git_repo {
            return;
        }
        let ctx = ctx.clone();
        let environment_id = environment_id.to_owned();
        tokio::spawn(async move {
            if let Err(error) = refresh_workspace_metadata(&ctx, &found).await {
                let fields = json!({ "err": error.to_string(), "environmentId": environment_id });
                ctx.log.warn("Could not refresh workspace metadata", fields);
            }
        });
    }
}

/// Keeps each connected machine's watched paths in step with the environments that have
/// realtime subscribers and turns `workspace.changed` events into environment notifications.
pub fn start_workspace_watch(ctx: &Ctx) -> WorkspaceWatch {
    let stop = CancellationToken::new();
    let watch =
        Arc::new(Watch { ctx: Arc::downgrade(ctx), state: Mutex::default(), stop: stop.clone() });
    let on_subscription = {
        let watch = watch.clone();
        ctx.hub.on_subscription_change(move |target, subscribed| {
            let RealtimeSubscriptionTarget::EnvironmentDetail { environment_id } = target else {
                return;
            };
            {
                let mut state = watch.state.lock();
                if subscribed {
                    state.targets.insert(target.key(), environment_id.clone());
                } else {
                    state.targets.remove(&target.key());
                }
            }
            watch.schedule();
        })
    };
    let on_changed = {
        let watch = watch.clone();
        ctx.hub.on_changed(move |message| {
            let kinds: Vec<&str> = match message {
                ChangedMessage::Thread { changes, .. } => {
                    changes.iter().map(|kind| kind.as_str()).collect()
                }
                ChangedMessage::Environment { changes, .. } => {
                    changes.iter().map(|kind| kind.as_str()).collect()
                }
                _ => return,
            };
            let retargets = kinds.iter().any(|kind| RETARGETING_CHANGES.contains(kind));
            if retargets && !watch.state.lock().targets.is_empty() {
                watch.schedule();
            }
        })
    };
    let on_connected = {
        let watch = watch.clone();
        ctx.runners.on_connected(Arc::new(move |host_id: &str| {
            watch.state.lock().sent.remove(host_id);
            watch.schedule();
        }))
    };
    let on_disconnected = {
        let watch = watch.clone();
        ctx.runners.on_disconnected(Arc::new(move |host_id: &str| {
            watch.state.lock().sent.remove(host_id);
        }))
    };
    let on_event = {
        let watch = watch.clone();
        ctx.runners.on_event(
            "workspace.changed",
            Arc::new(move |event, host_id| {
                let watch = watch.clone();
                async move {
                    let RunnerEventBody::WorkspaceChanged { path, change } = event.body else {
                        return Ok(());
                    };
                    let (kind, refs) = match change.as_str() {
                        "status" => (EnvironmentChangeKind::WorkStatusChanged, false),
                        "refs" => (EnvironmentChangeKind::GitRefsChanged, true),
                        _ => return Ok(()),
                    };
                    let Some(ctx) = watch.ctx.upgrade() else { return Ok(()) };
                    let ids = watch
                        .state
                        .lock()
                        .sent
                        .get(&host_id)
                        .and_then(|sent| sent.set.get(&path).cloned())
                        .unwrap_or_default();
                    for environment_id in ids {
                        ctx.hub.environment(&environment_id, vec![kind]);
                        Watch::refresh_metadata(&ctx, &environment_id, refs);
                    }
                    Ok(())
                }
                .boxed()
            }),
        )
    };
    WorkspaceWatch {
        _listeners: vec![on_subscription, on_changed],
        _registrations: vec![on_connected, on_disconnected, on_event],
        _stop: stop.drop_guard(),
    }
}
