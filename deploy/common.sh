#!/bin/sh
set -eu

DEEPMARK_ROOT=${DEEPMARK_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
RUNTIME_DIR=${RUNTIME_DIR:-/home/deepmark/runtime}
DEPLOY_ENV=${DEPLOY_ENV:-$RUNTIME_DIR/deploy.env}
# This is a controlled local shell file, kept outside the Git checkout.
if [ -r "$DEPLOY_ENV" ]; then . "$DEPLOY_ENV"; fi
TOOLS_ENV=${TOOLS_ENV:-/home/deepmark/tools/env.sh}
if [ -r "$TOOLS_ENV" ]; then . "$TOOLS_ENV"; fi
JAVA_BIN=${JAVA_BIN:-${JAVA_HOME:+$JAVA_HOME/bin/}java}
NGINX_BIN=${NGINX_BIN:-$(command -v nginx || true)}
BACKEND_PORT=${BACKEND_PORT:-8787}
HTTPS_PORT=${HTTPS_PORT:-8443}
SERVER_JAR=${SERVER_JAR:-$DEEPMARK_ROOT/backend/target/deepmark-server.jar}
PROXY_DIR=$RUNTIME_DIR/proxy
BACKEND_PID=$RUNTIME_DIR/backend.pid
SUPERVISOR_PID=$RUNTIME_DIR/supervisor.pid
NGINX_PID=$PROXY_DIR/nginx.pid
RENEWAL_PID=$RUNTIME_DIR/cert-renewal.pid
CERTBOT_BIN=${CERTBOT_BIN:-}
ACME_CONFIG_DIR=${ACME_CONFIG_DIR:-}
ACME_WORK_DIR=${ACME_WORK_DIR:-$RUNTIME_DIR/acme/work}
ACME_LOG_DIR=${ACME_LOG_DIR:-$RUNTIME_DIR/acme/logs}
export DEEPMARK_ROOT RUNTIME_DIR DEPLOY_ENV TOOLS_ENV JAVA_BIN BACKEND_PORT SERVER_JAR
export CERTBOT_BIN ACME_CONFIG_DIR ACME_WORK_DIR ACME_LOG_DIR

read_pid() {
    [ -r "$1" ] || return 1
    candidate=$(cat "$1")
    case "$candidate" in ''|*[!0-9]*) return 1;; esac
    [ "$candidate" -gt 1 ] || return 1
    printf '%s\n' "$candidate"
}

pid_alive() {
    kill -0 "$1" 2>/dev/null || return 1
    [ -r "/proc/$1/status" ] || return 1
    ! grep -q '^State:.*Z' "/proc/$1/status"
}

arg_present() {
    tr '\000' '\n' < "/proc/$1/cmdline" | grep -Fqx -- "$2"
}

backend_matches() {
    pid_alive "$1" && arg_present "$1" "-Ddeepmark.runtime=$RUNTIME_DIR" && arg_present "$1" "$SERVER_JAR"
}

supervisor_matches() {
    pid_alive "$1" && arg_present "$1" "$DEEPMARK_ROOT/deploy/run-backend.sh" && arg_present "$1" "$RUNTIME_DIR"
}

renewal_matches() {
    pid_alive "$1" && arg_present "$1" "$DEEPMARK_ROOT/deploy/renew-cert.sh" && arg_present "$1" "$RUNTIME_DIR"
}

nginx_matches() {
    pid_alive "$1" || return 1
    [ -n "$NGINX_BIN" ] || return 1
    [ "$(readlink -f "/proc/$1/exe")" = "$(readlink -f "$NGINX_BIN")" ] || return 1
    tr '\000' ' ' < "/proc/$1/cmdline" | grep -Fq -- "-p $PROXY_DIR/ -c $PROXY_DIR/nginx.conf"
}
