#!/bin/sh
set -eu
MIMICS_RUNTIME=${1:-${MIMICS_RUNTIME:-/home/deepmark/mimics-runtime}}
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/common.sh"
umask 077
command -v flock >/dev/null 2>&1 || { printf 'flock is required.\n' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { printf 'curl is required.\n' >&2; exit 1; }
[ -x "$MIMICS_NODE_BIN" ] || { printf 'Node.js 24+ is required: %s\n' "$MIMICS_NODE_BIN" >&2; exit 1; }
"$MIMICS_NODE_BIN" -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || { printf 'Node.js 24+ is required.\n' >&2; exit 1; }
[ -f "$MIMICS_SERVER" ] && [ -s "$MIMICS_CURRENT/dist/index.html" ] || { printf 'Install a complete release at %s first.\n' "$MIMICS_CURRENT" >&2; exit 1; }
mkdir -p "$MIMICS_RUNTIME/logs" "$STATE_DIR" "$DATASET_DIR"
exec 9>"$MIMICS_RUNTIME/control.lock"
flock -x 9
if pid=$(read_pid "$MIMICS_SUPERVISOR_PID") && supervisor_matches "$pid"; then
    printf 'Mimics supervisor already running (PID %s).\n' "$pid"
else
    if pid=$(read_pid "$MIMICS_NODE_PID") && node_matches "$pid"; then
        printf 'Mimics Node has no matching supervisor (PID %s); run this service stop.sh before restarting.\n' "$pid" >&2
        exit 1
    fi
    rm -f "$MIMICS_STOP"
    nohup "$MIMICS_DEPLOY_DIR/run-service.sh" "$MIMICS_RUNTIME" 9>&- >>"$MIMICS_RUNTIME/logs/supervisor.log" 2>&1 </dev/null &
fi
attempt=0
while [ "$attempt" -lt 30 ]; do
    if node_pid=$(read_pid "$MIMICS_NODE_PID") && node_matches "$node_pid" && health_ready; then
        printf 'Mimics ready at 127.0.0.1:%s (PID %s).\n' "$MIMICS_PORT" "$node_pid"
        exit 0
    fi
    attempt=$((attempt+1))
    sleep 1
done
printf 'Mimics did not become healthy; inspect %s/logs/.\n' "$MIMICS_RUNTIME" >&2
exit 1
