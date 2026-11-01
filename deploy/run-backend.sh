#!/bin/sh
set -eu
RUNTIME_DIR=${1:?runtime directory required}
DEEPMARK_ROOT=${2:?repository directory required}
export RUNTIME_DIR DEEPMARK_ROOT
. "$DEEPMARK_ROOT/deploy/common.sh"
umask 077
mkdir -p "$RUNTIME_DIR/logs" "$RUNTIME_DIR/state" "$RUNTIME_DIR/datasets"
export HOST=127.0.0.1 PORT=$BACKEND_PORT
export STATE_DIR=${STATE_DIR:-$RUNTIME_DIR/state}
export DATASET_DIR=${DATASET_DIR:-$RUNTIME_DIR/datasets}
export DIST_DIR=${DIST_DIR:-$DEEPMARK_ROOT/dist}
child=''
stop_child() {
    if [ -n "$child" ] && backend_matches "$child"; then
        kill -TERM "$child" 2>/dev/null || true
        wait "$child" 2>/dev/null || true
    fi
    exit 0
}
trap stop_child TERM INT HUP
cd "$DEEPMARK_ROOT"
while [ ! -e "$RUNTIME_DIR/stop-requested" ]; do
    "$JAVA_BIN" "-Ddeepmark.runtime=$RUNTIME_DIR" -jar "$SERVER_JAR" >>"$RUNTIME_DIR/logs/backend.log" 2>&1 &
    child=$!
    printf '%s\n' "$child" > "$BACKEND_PID"
    set +e
    wait "$child"
    code=$?
    set -e
    printf '%s backend exited with status %s\n' "$(date -u +%FT%TZ)" "$code"
    child=''
    [ ! -e "$RUNTIME_DIR/stop-requested" ] || break
    sleep 2
done
