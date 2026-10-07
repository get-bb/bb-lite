#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/server.sh <command> [--build] [--force]

  start     Stop the running server and start it again (alias: node)
  stop      Stop the running server
  status    Show whether the server is running
  logs      Follow the server log

  --build   Rebuild the web app and the native bb CLI before starting
  --force   Replace a server that uses a different data directory

A setting is taken from the first of these that has it:

  1. the environment
  2. .env.server at the repository root (KEY=value lines)
  3. the bb server now listening on the port (so a restart keeps its settings)
  4. the settings of the last start on that port (.tmp/server-<port>.env)
  5. the server's own defaults

The port itself comes from BB_SERVER_PORT (1 or 2), else 48886. Example .env.server:

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
log=${BB_SERVER_LOG:-$root/.tmp/server-$port.log}
remembered=$root/.tmp/server-$port.env
inherited="BB_DATA_DIR BB_SERVER_BIND_HOST BB_SERVER_ALLOWED_HOSTS BB_APP_DIR BB_LOG_LEVEL"
inherited="$inherited BB_DEV_PROVIDERS BB_CONNECT_BASE_URL BB_CLAUDE_CODE_EXECUTABLE"
explicit_data_dir=${BB_DATA_DIR:-}
adopted=""
adopted_from=""

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
    *"bb server"* | *"apps/server/src/main.ts"* | *"src/main.ts"* | *"dist/bb.mjs server"*) echo bb ;;
    *) echo unknown ;;
  esac
}

server_url() {
  local host=${BB_SERVER_BIND_HOST:-127.0.0.1}
  case $host in
    0.0.0.0 | ::) host=127.0.0.1 ;;
  esac
  echo "http://$host:$port"
}

healthy() {
  curl -fsS -m 2 "$(server_url)/health" >/dev/null 2>&1
}

running_data_dir() {
  local config
  config=$(curl -fsS -m 5 "$(server_url)/api/v1/system/config" 2>/dev/null || true)
  echo "$config" | sed -n 's/.*"dataDir":"\([^"]*\)".*/\1/p'
}

adopt() {
  local line key
  while IFS= read -r line; do
    key=${line%%=*}
    case " $inherited " in
      *" $key "*) ;;
      *) continue ;;
    esac
    [ -z "${!key+set}" ] || continue
    export "$key=${line#*=}"
    adopted="$adopted $key"
  done
}

adopt_settings() {
  local pid used
  pid=$(listener_pid)
  if [ -n "$pid" ] && [ "$(kind_of "$pid")" != unknown ]; then
    adopted_from="the running server"
    if [ -r "/proc/$pid/environ" ]; then
      adopt < <(tr '\0' '\n' <"/proc/$pid/environ")
    fi
    if [ -z "${BB_DATA_DIR+set}" ]; then
      used=$(running_data_dir)
      if [ -n "$used" ]; then
        export BB_DATA_DIR=$used
        adopted="$adopted BB_DATA_DIR"
      fi
    fi
  elif [ -f "$remembered" ]; then
    adopted_from="the last start on port $port"
    adopt <"$remembered"
  fi
}

remember_settings() {
  local key
  mkdir -p "$(dirname "$remembered")"
  : >"$remembered"
  for key in $inherited; do
    [ -z "${!key+set}" ] || printf '%s=%s\n' "$key" "${!key}" >>"$remembered"
  done
}

adopt_settings
data_dir=${BB_DATA_DIR:-$HOME/.bb-150k}
case $data_dir in
  /*) ;;
  *) data_dir=$PWD/$data_dir ;;
esac
data_dir=${data_dir%/}
app_dir=${BB_APP_DIR:-$root/apps/app/dist}
url=$(server_url)

describe() {
  local pid
  pid=$(listener_pid)
  if [ -z "$pid" ]; then
    echo "No server is listening on port $port."
    return
  fi
  local state=starting
  if healthy; then state=healthy; fi
  echo "bb server on $url (pid $pid, $state)"
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
  if [ -n "$explicit_data_dir" ] && [ -n "$used" ] && [ "${used%/}" != "$data_dir" ] &&
    [ "$force" = false ]; then
    die "the server on port $port uses $used, but BB_DATA_DIR is set to $data_dir.
Unset it (or fix .env.server) to keep the running server's data directory, or pass --force
to start on $data_dir instead."
  fi
  remember_settings
  echo "Stopping the server (pid $pid)…"
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

build_native_cli() {
  if [ "$build" = false ]; then
    return
  fi
  if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo was not found; agents will use the Node bb CLI."
    return
  fi
  echo "Building the native bb CLI…"
  (cd "$root" && cargo build --release -p bb-cli)
}

start_server() {
  if [ -n "$adopted" ]; then
    echo "Settings kept from $adopted_from:$adopted"
  fi
  build_app
  build_native_cli
  stop_server
  mkdir -p "$(dirname "$log")"
  export BB_DATA_DIR=$data_dir BB_SERVER_PORT=$port BB_APP_DIR=$app_dir
  remember_settings
  local detach=()
  if command -v setsid >/dev/null 2>&1; then detach=(setsid); fi
  cd "$root"
  echo "--- $(date -u +%Y-%m-%dT%H:%M:%SZ) starting the server ---" >>"$log"
  ${detach[@]+"${detach[@]}"} nohup node --conditions=source --import tsx apps/server/src/main.ts >>"$log" 2>&1 &
  local started=$!
  for _ in $(seq 1 150); do
    if healthy; then
      describe
      return
    fi
    if ! kill -0 "$started" 2>/dev/null && [ -z "$(listener_pid)" ]; then
      tail -n 20 "$log" >&2
      die "the server exited while starting; the end of $log is above."
    fi
    sleep 0.2
  done
  tail -n 20 "$log" >&2
  die "the server did not answer on $url within 30 seconds."
}

case $command in
  start | node) start_server ;;
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
