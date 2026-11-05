#!/bin/sh
set -eu
MIMICS_RUNTIME=${1:-${MIMICS_RUNTIME:-/home/deepmark/mimics-runtime}}
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/common.sh"
umask 077
mkdir -p "$MIMICS_RUNTIME/logs" "$STATE_DIR" "$DATASET_DIR"
# Only one supervisor may own this runtime. Do not pass its lock to Node.
exec 8>"$MIMICS_RUNTIME/supervisor.lock"
flock -n 8 || exit 0
write_pid "$MIMICS_SUPERVISOR_PID" "$$"
child=''
stopping=0
finish() {
    trap - TERM INT HUP EXIT
    if [ -n "$child" ] && node_matches "$child"; then
        kill -TERM "$child" 2>/dev/null || true
        wait "$child" 2>/dev/null || true
    fi
    if [ -n "$child" ]; then remove_own_pid "$MIMICS_NODE_PID" "$child"; fi
    remove_own_pid "$MIMICS_SUPERVISOR_PID" "$$"
    exit 0
}
request_stop() {
    stopping=1
    : > "$MIMICS_STOP"
    if [ -n "$child" ] && node_matches "$child"; then kill -TERM "$child" 2>/dev/null || true; fi
}
# A signal between fork and child=$! must not leave an unregistered Node alive.
trap request_stop TERM INT HUP
trap finish EXIT
while [ ! -e "$MIMICS_STOP" ]; do
    if existing=$(read_pid "$MIMICS_NODE_PID") && node_matches "$existing"; then
        printf '%s refusing to start a second Node process (PID %s)\n' "$(date -u +%FT%TZ)" "$existing" >&2
        exit 1
    fi
    "$MIMICS_NODE_BIN" --preserve-symlinks-main "$MIMICS_SERVER" 8>&- >>"$MIMICS_RUNTIME/logs/node.log" 2>&1 &
    child=$!
    write_pid "$MIMICS_NODE_PID" "$child"
    [ "$stopping" -eq 0 ] || finish
    set +e
    wait "$child"
    code=$?
    set -e
    [ "$stopping" -eq 0 ] || finish
    remove_own_pid "$MIMICS_NODE_PID" "$child"
    printf '%s Mimics Node exited with status %s\n' "$(date -u +%FT%TZ)" "$code"
    child=''
    [ ! -e "$MIMICS_STOP" ] || break
    sleep 2 8>&-
done
