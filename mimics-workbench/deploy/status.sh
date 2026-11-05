#!/bin/sh
set -eu
MIMICS_RUNTIME=${1:-${MIMICS_RUNTIME:-/home/deepmark/mimics-runtime}}
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/common.sh"
result=0
if pid=$(read_pid "$MIMICS_SUPERVISOR_PID") && supervisor_matches "$pid"; then
    printf 'Mimics supervisor running (PID %s)\n' "$pid"
else
    printf 'Mimics supervisor stopped\n'; result=1
fi
if pid=$(read_pid "$MIMICS_NODE_PID") && node_matches "$pid"; then
    printf 'Mimics Node running (PID %s)\n' "$pid"
else
    printf 'Mimics Node stopped\n'; result=1
fi
if health_ready; then printf 'Mimics health: ok\n'; else printf 'Mimics health: unavailable\n'; result=1; fi
printf 'Runtime: %s\nRelease: %s\n' "$MIMICS_RUNTIME" "$(readlink -f "$MIMICS_CURRENT" || true)"
exit "$result"
