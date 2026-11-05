#!/bin/sh
set -eu
MIMICS_RUNTIME=${1:-${MIMICS_RUNTIME:-/home/deepmark/mimics-runtime}}
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/common.sh"
umask 077
[ -d "$MIMICS_RUNTIME" ] || { printf 'Mimics runtime does not exist.\n'; exit 0; }
exec 9>"$MIMICS_RUNTIME/control.lock"
flock -x 9
: > "$MIMICS_STOP"
supervisor=''
node=''
if pid=$(read_pid "$MIMICS_SUPERVISOR_PID") && supervisor_matches "$pid"; then supervisor=$pid; fi
if pid=$(read_pid "$MIMICS_NODE_PID") && node_matches "$pid"; then node=$pid; fi
if [ -n "$supervisor" ]; then kill -TERM "$supervisor" 2>/dev/null || true; fi
# Covers a service whose supervisor has already exited, without touching any other app.
if [ -n "$node" ] && node_matches "$node"; then kill -TERM "$node" 2>/dev/null || true; fi
attempt=0
while [ "$attempt" -lt 15 ]; do
    alive=false
    if [ -n "$supervisor" ] && supervisor_matches "$supervisor"; then alive=true; fi
    if [ -n "$node" ] && node_matches "$node"; then alive=true; fi
    if [ "$alive" = false ]; then
        if [ -n "$supervisor" ]; then remove_own_pid "$MIMICS_SUPERVISOR_PID" "$supervisor"; fi
        if [ -n "$node" ]; then remove_own_pid "$MIMICS_NODE_PID" "$node"; fi
        printf 'Mimics service stopped. Main site and proxy remain running.\n'
        exit 0
    fi
    attempt=$((attempt+1))
    sleep 1
done
printf 'Mimics did not stop within 15 seconds; inspect the exact process before retrying.\n' >&2
exit 1
