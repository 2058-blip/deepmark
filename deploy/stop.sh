#!/bin/sh
set -eu
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/common.sh"
mkdir -p "$RUNTIME_DIR"
touch "$RUNTIME_DIR/stop-requested"
stop_one() {
    file=$1
    matcher=$2
    signal=$3
    label=$4
    if pid=$(read_pid "$file"); then
        if "$matcher" "$pid"; then
            kill "-$signal" "$pid"
            printf 'Sent %s to %s PID %s\n' "$signal" "$label" "$pid"
            deadline=$(( $(date +%s) + 30 ))
            while "$matcher" "$pid"; do
                if [ "$(date +%s)" -ge "$deadline" ]; then
                    printf '%s PID %s is still shutting down; inspect logs before restarting.\n' "$label" "$pid" >&2
                    return 1
                fi
                sleep 0.1
            done
        else
            printf 'Ignoring stale or unrelated %s PID %s\n' "$label" "$pid"
        fi
    fi
}
stop_one "$RENEWAL_PID" renewal_matches TERM certificate-renewal
stop_one "$SUPERVISOR_PID" supervisor_matches TERM supervisor
stop_one "$BACKEND_PID" backend_matches TERM backend
stop_one "$NGINX_PID" nginx_matches QUIT nginx
