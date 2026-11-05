#!/bin/sh
# Shared by the standalone Mimics service scripts. Does not change the main site.
set -eu

MIMICS_DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MIMICS_RUNTIME=${MIMICS_RUNTIME:-/home/deepmark/mimics-runtime}
case "$MIMICS_RUNTIME" in
    /|''|[!/]*) printf 'MIMICS_RUNTIME must be an absolute, dedicated directory.\n' >&2; exit 1 ;;
esac
MIMICS_RUNTIME=${MIMICS_RUNTIME%/}
MIMICS_ENV=$MIMICS_RUNTIME/service.env
# This optional file is controlled by the operator and must not be public.
if [ -r "$MIMICS_ENV" ]; then . "$MIMICS_ENV"; fi
MIMICS_NODE_BIN=${MIMICS_NODE_BIN:-/home/deepmark/tools/node-24/bin/node}
MIMICS_PORT=${MIMICS_PORT:-8788}
case "$MIMICS_PORT" in ''|*[!0-9]*) printf 'Invalid MIMICS_PORT.\n' >&2; exit 1 ;; esac
[ "$MIMICS_PORT" -ge 1 ] && [ "$MIMICS_PORT" -le 65535 ] || { printf 'Invalid MIMICS_PORT.\n' >&2; exit 1; }
MIMICS_CURRENT=$MIMICS_RUNTIME/current
MIMICS_SERVER=$MIMICS_CURRENT/server/server.mjs
MIMICS_SUPERVISOR_PID=$MIMICS_RUNTIME/supervisor.pid
MIMICS_NODE_PID=$MIMICS_RUNTIME/node.pid
MIMICS_STOP=$MIMICS_RUNTIME/stop-requested
export MIMICS_RUNTIME MIMICS_NODE_BIN MIMICS_PORT
export HOST=127.0.0.1 PORT=$MIMICS_PORT
export DATASET_DIR=$MIMICS_RUNTIME/datasets STATE_DIR=$MIMICS_RUNTIME/state
export COOKIE_NAME=deepmark_mimics_session COOKIE_PATH=/mimics/
export PUBLIC_BASE_PATH=/mimics/ COOKIE_SECURE=1

read_pid() {
    [ -r "$1" ] || return 1
    candidate=$(cat "$1")
    case "$candidate" in ''|*[!0-9]*) return 1 ;; esac
    [ "$candidate" -gt 1 ] || return 1
    printf '%s\n' "$candidate"
}
pid_alive() {
    kill -0 "$1" 2>/dev/null || return 1
    [ -r "/proc/$1/status" ] || return 1
    ! grep -q '^State:.*Z' "/proc/$1/status"
}
arg_present() {
    [ -r "/proc/$1/cmdline" ] || return 1
    tr '\000' '\n' < "/proc/$1/cmdline" | grep -Fqx -- "$2"
}
node_matches() {
    pid_alive "$1" && arg_present "$1" "$MIMICS_SERVER" || return 1
    [ "$(readlink -f "/proc/$1/exe")" = "$(readlink -f "$MIMICS_NODE_BIN")" ]
}
supervisor_matches() {
    pid_alive "$1" && arg_present "$1" "$MIMICS_DEPLOY_DIR/run-service.sh" && arg_present "$1" "$MIMICS_RUNTIME"
}
write_pid() {
    printf '%s\n' "$2" > "$1.$$"
    mv -f "$1.$$" "$1"
}
remove_own_pid() {
    if recorded=$(read_pid "$1") && [ "$recorded" = "$2" ]; then rm -f "$1"; fi
}
health_ready() {
    expected_pid=$(read_pid "$MIMICS_NODE_PID") && node_matches "$expected_pid" || return 1
    health=$(curl --noproxy '*' --fail --silent --max-time 2 "http://127.0.0.1:$MIMICS_PORT/api/health" 2>/dev/null) || return 1
    "$MIMICS_NODE_BIN" -e 'try{const value=JSON.parse(process.argv[2]);if(value?.status!=="ok"||value.backend!=="node"||value.pid!==Number(process.argv[1]))process.exit(1);}catch{process.exit(1);}' "$expected_pid" "$health" || return 1
    current_pid=$(read_pid "$MIMICS_NODE_PID") && [ "$current_pid" = "$expected_pid" ] && node_matches "$current_pid"
}
