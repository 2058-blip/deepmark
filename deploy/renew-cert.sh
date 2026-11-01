#!/bin/sh
set -eu
RUNTIME_DIR=${1:?runtime directory required}
DEEPMARK_ROOT=${2:?repository directory required}
export RUNTIME_DIR DEEPMARK_ROOT
. "$DEEPMARK_ROOT/deploy/common.sh"
[ -x "$CERTBOT_BIN" ] && [ -d "$ACME_CONFIG_DIR" ] || exit 1
umask 077
mkdir -p "$RUNTIME_DIR/logs" "$ACME_WORK_DIR" "$ACME_LOG_DIR"
child=''
stop_child() {
    if [ -n "$child" ] && pid_alive "$child" && [ "$(awk '/^PPid:/ {print $2}' "/proc/$child/status")" = "$$" ]; then
        kill -TERM "$child" 2>/dev/null || true
        wait "$child" 2>/dev/null || true
    fi
    exit 0
}
trap stop_child TERM INT HUP
certificate_state() {
    if [ -n "${TLS_CERT:-}" ] && [ -s "$TLS_CERT" ]; then cksum < "$TLS_CERT"; fi
}
while [ ! -e "$RUNTIME_DIR/stop-requested" ]; do
    before=$(certificate_state)
    # No --force-renewal: the first normal run only checks the existing due date.
    "$CERTBOT_BIN" renew --non-interactive --no-random-sleep-on-renew \
        --config-dir "$ACME_CONFIG_DIR" --work-dir "$ACME_WORK_DIR" --logs-dir "$ACME_LOG_DIR" \
        >"$ACME_LOG_DIR/renewal-run.log" 2>&1 &
    child=$!
    set +e
    wait "$child"
    code=$?
    set -e
    child=''
    if [ "$code" = 0 ]; then
        after=$(certificate_state)
        if [ -n "$after" ] && [ "$before" != "$after" ]; then
            if pid=$(read_pid "$NGINX_PID") && nginx_matches "$pid"; then
                if "$NGINX_BIN" -t -p "$PROXY_DIR/" -c "$PROXY_DIR/nginx.conf" >/dev/null 2>&1; then
                    # Recheck identity immediately before signalling this deployment.
                    if nginx_matches "$pid"; then
                        kill -HUP "$pid"
                        printf '%s certificate renewed; matching nginx reloaded\n' "$(date -u +%FT%TZ)"
                    fi
                else
                    printf '%s certificate renewed; nginx configuration check failed\n' "$(date -u +%FT%TZ)"
                fi
            else
                printf '%s certificate renewed; no matching nginx available\n' "$(date -u +%FT%TZ)"
            fi
        else
            printf '%s certificate check succeeded; certificate not due or unchanged\n' "$(date -u +%FT%TZ)"
        fi
    else
        printf '%s certificate check failed with exit status %s; details remain in private ACME logs\n' "$(date -u +%FT%TZ)" "$code"
        if grep -Eq 'Max retries exceeded|requests\.exceptions\.|urllib3\.exceptions\.|Temporary failure in name resolution|NameResolutionError|Connection reset by peer|Failed to establish a new connection|HTTPError:' "$ACME_LOG_DIR/renewal-run.log"; then
            printf '%s network failure; retrying immediately\n' "$(date -u +%FT%TZ)"
            continue
        fi
    fi
    [ ! -e "$RUNTIME_DIR/stop-requested" ] || break
    sleep 43200 &
    child=$!
    wait "$child"
    child=''
done
