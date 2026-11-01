#!/bin/sh
set -eu
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/common.sh"
umask 077
[ -f "$SERVER_JAR" ] || { printf 'Build backend first: %s\n' "$SERVER_JAR" >&2; exit 1; }
[ -d "$DEEPMARK_ROOT/dist" ] || { printf 'Build frontend first: npm run build\n' >&2; exit 1; }
[ -n "$NGINX_BIN" ] || { printf 'nginx is required\n' >&2; exit 1; }
command -v "$JAVA_BIN" >/dev/null 2>&1 || { printf 'Java is unavailable\n' >&2; exit 1; }
case "$BACKEND_PORT:$HTTPS_PORT" in *[!0-9:]*|:*|*:) printf 'Invalid ports\n' >&2; exit 1;; esac
mkdir -p "$RUNTIME_DIR/logs" "$RUNTIME_DIR/state" "$RUNTIME_DIR/datasets" "$RUNTIME_DIR/tls" "$PROXY_DIR/logs" "$PROXY_DIR/client_temp" "$PROXY_DIR/proxy_temp"
# Only nginx temp directories need worker access; application data remains private.
chmod 711 "$RUNTIME_DIR" "$PROXY_DIR"
if [ "$(id -u)" = 0 ]; then
    chown www-data "$PROXY_DIR/client_temp" "$PROXY_DIR/proxy_temp"
fi
TLS_CERT=${TLS_CERT:-$RUNTIME_DIR/tls/deepmark.crt}
TLS_KEY=${TLS_KEY:-$RUNTIME_DIR/tls/deepmark.key}
if [ ! -s "$TLS_CERT" ] || [ ! -s "$TLS_KEY" ]; then
    printf 'Generating a self-signed certificate for this independent HTTPS endpoint.\n'
    openssl req -x509 -newkey rsa:3072 -sha256 -days 365 -nodes -keyout "$TLS_KEY" -out "$TLS_CERT" \
        -subj /CN=ddns.984797.xyz -addext 'subjectAltName=DNS:ddns.984797.xyz,DNS:localhost,IP:127.0.0.1' >/dev/null 2>&1
fi
chmod 600 "$TLS_KEY"
export PROXY_DIR TLS_CERT TLS_KEY HTTPS_PORT
python3 - "$DEEPMARK_ROOT/deploy/nginx.conf.template" "$PROXY_DIR/nginx.conf" <<'PY'
import os, pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text()
for name in ('PROXY_DIR', 'TLS_CERT', 'TLS_KEY', 'HTTPS_PORT', 'BACKEND_PORT'):
    value = os.environ[name]
    if any(c in value for c in '\r\n"'):
        raise SystemExit('Unsupported character in configuration value')
    text = text.replace('@' + name + '@', value)
pathlib.Path(sys.argv[2]).write_text(text)
PY
"$NGINX_BIN" -t -p "$PROXY_DIR/" -c "$PROXY_DIR/nginx.conf"
rm -f "$RUNTIME_DIR/stop-requested"
if pid=$(read_pid "$SUPERVISOR_PID") && supervisor_matches "$pid"; then
    printf 'Backend supervisor already running: %s\n' "$pid"
else
    if pid=$(read_pid "$BACKEND_PID") && backend_matches "$pid"; then
        printf 'Existing backend has no matching supervisor; run deploy/stop.sh before restarting.\n' >&2
        exit 1
    fi
    nohup "$DEEPMARK_ROOT/deploy/run-backend.sh" "$RUNTIME_DIR" "$DEEPMARK_ROOT" >>"$RUNTIME_DIR/logs/supervisor.log" 2>&1 </dev/null &
    printf '%s\n' "$!" > "$SUPERVISOR_PID"
fi
if pid=$(read_pid "$NGINX_PID") && nginx_matches "$pid"; then
    kill -HUP "$pid"
    printf 'Independent nginx reloaded: %s\n' "$pid"
else
    "$NGINX_BIN" -p "$PROXY_DIR/" -c "$PROXY_DIR/nginx.conf"
fi
if [ -x "$CERTBOT_BIN" ] && [ -d "$ACME_CONFIG_DIR" ]; then
    if pid=$(read_pid "$RENEWAL_PID") && renewal_matches "$pid"; then
        printf 'Certificate renewal loop already running: %s\n' "$pid"
    else
        nohup "$DEEPMARK_ROOT/deploy/renew-cert.sh" "$RUNTIME_DIR" "$DEEPMARK_ROOT" >>"$RUNTIME_DIR/logs/cert-renewal.log" 2>&1 </dev/null &
        printf '%s\n' "$!" > "$RENEWAL_PID"
    fi
fi
printf 'Started DeepMark. Backend: 127.0.0.1:%s, HTTPS listener: %s\n' "$BACKEND_PORT" "$HTTPS_PORT"
printf 'TLS certificate: %s. External reachability must be checked separately.\n' "$TLS_CERT"
"$DEEPMARK_ROOT/deploy/status.sh" || true
