#!/bin/sh
set -eu
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/common.sh"
result=0
check() {
    file=$1
    matcher=$2
    label=$3
    if pid=$(read_pid "$file") && "$matcher" "$pid"; then
        printf '%s running (PID %s)\n' "$label" "$pid"
    else
        printf '%s stopped or PID does not match this deployment\n' "$label"
        result=1
    fi
}
check "$SUPERVISOR_PID" supervisor_matches supervisor
check "$BACKEND_PID" backend_matches backend
check "$NGINX_PID" nginx_matches nginx
if [ -x "$CERTBOT_BIN" ] && [ -d "$ACME_CONFIG_DIR" ]; then
    check "$RENEWAL_PID" renewal_matches certificate-renewal
else
    printf 'certificate-renewal not configured\n'
fi
printf 'Repository: %s\nRuntime: %s\n' "$DEEPMARK_ROOT" "$RUNTIME_DIR"
exit "$result"
