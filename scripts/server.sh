#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/server.sh <command> [--build] [--force]

  node      Stop the running server and start the TypeScript one
  rust      Stop the running server and start the Rust one
  stop      Stop the running server
  status    Show which server is running
  logs      Follow the server log

  --build   Rebuild the web app (and, for rust, the bb binary) before starting
  --force   Replace a server that uses a different data directory

Both servers read the same settings and the same data directory, so switching
keeps threads and settings. Settings come from the environment and from
.env.server at the repository root (KEY=value lines), for example:

  BB_DATA_DIR=/home/me/.bb-150k
  BB_SERVER_PORT=48886
  BB_SERVER_ALLOWED_HOSTS=my-host,my-host.example.ts.net
EOF
}

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${BB_SERVER_ENV_FILE:-$root/.env.server}
if [ -f "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi

command=${1:-}
shift || true
build=false
force=false
for option in "$@"; do
  case $option in
    --build) build=true ;;
    --force) force=true ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

port=${BB_SERVER_PORT:-48886}
data_dir=${BB_DATA_DIR:-$HOME/.bb-150k}
case $data_dir in
  /*) ;;
  *) data_dir=$PWD/$data_dir ;;
esac
data_dir=${data_dir%/}
app_dir=${BB_APP_DIR:-$root/apps/app/dist}
bind_host=${BB_SERVER_BIND_HOST:-127.0.0.1}
case $bind_host in
  0.0.0.0 | ::) bind_host=127.0.0.1 ;;
esac
url=http://$bind_host:$port
log=${BB_SERVER_LOG:-$root/.tmp/server-$port.log}
binary=${CARGO_TARGET_DIR:-$root/target}/release/bb

die() {
  echo "server.sh: $*" >&2
  exit 1
}

listener_pid() {
  local pids
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  else
    pids=$(ss -ltnpH "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' || true)
  fi
  echo "$pids" | head -n 1
}

kind_of() {
  case $(ps -o command= -p "$1" 2>/dev/null) in
    *"bb server"*) echo rust ;;
    *"apps/server/src/main.ts"* | *"src/main.ts"*) echo node ;;
    *) echo unknown ;;
  esac
}

healthy() {
  curl -fsS -m 2 "$url/health" >/dev/null 2>&1
}

running_data_dir() {
  local config
  config=$(curl -fsS -m 5 "$url/api/v1/system/config" 2>/dev/null || true)
  echo "$config" | sed -n 's/.*"dataDir":"\([^"]*\)".*/\1/p'
}

describe() {
  local pid
  pid=$(listener_pid)
  if [ -z "$pid" ]; then
    echo "No server is listening on port $port."
    return
  fi
  local state=starting
  if healthy; then state=healthy; fi
  echo "$(kind_of "$pid") server on $url (pid $pid, $state)"
  echo "  data: $(running_data_dir)"
  echo "  log:  $log"
}

stop_server() {
  local pid kind
  pid=$(listener_pid)
  [ -n "$pid" ] || return 0
  kind=$(kind_of "$pid")
  [ "$kind" != unknown ] ||
    die "port $port is held by pid $pid, which is not a bb server: $(ps -o command= -p "$pid")"
  local used
  used=$(running_data_dir)
  if [ -n "$used" ] && [ "${used%/}" != "$data_dir" ] && [ "$force" = false ]; then
    die "the $kind server on port $port uses $used, but this script is set to $data_dir.
Set BB_DATA_DIR (or .env.server) to match, or pass --force to replace it anyway."
  fi
  echo "Stopping the $kind server (pid $pid)…"
  kill -TERM "$pid"
  for _ in $(seq 1 100); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  die "pid $pid did not stop within 20 seconds; stop it yourself and run this again."
}

build_app() {
  [ -d "$root/node_modules" ] || die "node_modules is missing; run pnpm install first."
  if [ "$build" = true ] || [ ! -f "$app_dir/index.html" ]; then
    [ "$app_dir" = "$root/apps/app/dist" ] || die "$app_dir has no index.html."
    echo "Building the web app…"
    (cd "$root/apps/app" && pnpm build)
  fi
}

build_binary() {
  if [ "$build" = false ] && [ -x "$binary" ]; then
    return
  fi
  if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  fi
  command -v cargo >/dev/null 2>&1 || die "cargo was not found; install Rust with rustup."
  echo "Building the bb binary…"
  (cd "$root" && cargo build --release -p bb-cli)
}

start_server() {
  local kind=$1
  build_app
  if [ "$kind" = rust ]; then build_binary; fi
  stop_server
  mkdir -p "$(dirname "$log")"
  export BB_DATA_DIR=$data_dir BB_SERVER_PORT=$port BB_APP_DIR=$app_dir
  local detach=()
  if command -v setsid >/dev/null 2>&1; then detach=(setsid); fi
  cd "$root"
  echo "--- $(date -u +%Y-%m-%dT%H:%M:%SZ) starting the $kind server ---" >>"$log"
  if [ "$kind" = rust ]; then
    ${detach[@]+"${detach[@]}"} nohup "$binary" server >>"$log" 2>&1 &
  else
    ${detach[@]+"${detach[@]}"} nohup node --conditions=source --import tsx apps/server/src/main.ts >>"$log" 2>&1 &
  fi
  local started=$!
  for _ in $(seq 1 150); do
    if healthy; then
      describe
      return
    fi
    if ! kill -0 "$started" 2>/dev/null && [ -z "$(listener_pid)" ]; then
      tail -n 20 "$log" >&2
      die "the $kind server exited while starting; the end of $log is above."
    fi
    sleep 0.2
  done
  tail -n 20 "$log" >&2
  die "the $kind server did not answer on $url within 30 seconds."
}

case $command in
  node | rust) start_server "$command" ;;
  stop)
    stop_server
    describe
    ;;
  status) describe ;;
  logs) exec tail -n 50 -f "$log" ;;
  -h | --help | help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
