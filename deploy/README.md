# Independent DeepMark deployment

This deployment runs the Java HTTP/WebSocket backend on `127.0.0.1:8787` and a separate nginx process on HTTPS port `8443`. It does not replace the system nginx configuration or existing listeners on ports 81/444.

Build from the repository root:

```sh
. /home/deepmark/tools/env.sh
npm ci --no-audit --no-fund
npm run build
mvn -f backend/pom.xml package
chmod +x deploy/*.sh
./deploy/start.sh
./deploy/status.sh
```

Use `./deploy/stop.sh` before replacing the backend JAR, then run `./deploy/start.sh` again. The scripts verify each PID's command line against this deployment before sending signals; they never use a global process name to stop services.

Configuration can be supplied through environment variables:

| Variable | Default |
| --- | --- |
| `DEEPMARK_ROOT` | Repository directory containing `deploy/` |
| `RUNTIME_DIR` | `/home/deepmark/runtime` |
| `DEPLOY_ENV` | `$RUNTIME_DIR/deploy.env`, sourced when readable |
| `TOOLS_ENV` | `/home/deepmark/tools/env.sh` |
| `JAVA_BIN` | `$JAVA_HOME/bin/java`, otherwise `java` |
| `BACKEND_PORT` | `8787` (always loopback) |
| `HTTPS_PORT` | `8443` |
| `STATE_DIR` | `$RUNTIME_DIR/state` |
| `DATASET_DIR` | `$RUNTIME_DIR/datasets` |
| `DIST_DIR` | `$DEEPMARK_ROOT/dist` |
| `TLS_CERT` | `$RUNTIME_DIR/tls/deepmark.crt` |
| `TLS_KEY` | `$RUNTIME_DIR/tls/deepmark.key` |
| `CERTBOT_BIN` | Unset; an executable path enables the renewal loop |
| `ACME_CONFIG_DIR` | Unset; existing Certbot configuration directory |
| `ACME_WORK_DIR` | `$RUNTIME_DIR/acme/work` |
| `ACME_LOG_DIR` | `$RUNTIME_DIR/acme/logs` |

For persistent TLS configuration, keep a root-controlled mode-600 shell file at `$RUNTIME_DIR/deploy.env`, outside the repository. For example, after obtaining a certificate:

```sh
TLS_CERT=/home/deepmark/runtime/acme/config/live/ddns.984797.xyz/fullchain.pem
TLS_KEY=/home/deepmark/runtime/acme/config/live/ddns.984797.xyz/privkey.pem
CERTBOT_BIN=/home/deepmark/tools/certbot/bin/certbot
ACME_CONFIG_DIR=/home/deepmark/runtime/acme/config
ACME_WORK_DIR=/home/deepmark/runtime/acme/work
ACME_LOG_DIR=/home/deepmark/runtime/acme/logs
```

The start, stop, and status scripts source this controlled file, so ordinary restarts keep using the selected certificate. It is shell code and must not be writable by untrusted accounts or committed to Git.

When Certbot and its existing configuration are available, `start.sh` also launches this application's renewal loop. It checks immediately without forcing renewal, then checks every 12 hours. A successful renewal reloads nginx only when the certificate changed, its configuration passes validation, and its PID matches this deployment. The loop has a separately verified PID, is reported by `status.sh`, and is stopped by `stop.sh`. Detailed Certbot output stays in the private ACME log directory; the supervisor log contains status messages. Standalone HTTP-01 renewal requires port 80 to remain externally reachable and free when a due certificate is renewed.

The backend supervisor restarts the Java process after unexpected exits and survives the SSH session ending. Runtime state, datasets, logs, and TLS files live outside the Git checkout. The independent nginx configuration allows 512 MiB HTTP uploads and long-lived WebSocket connections; the Java application defines its own message limits as well.

The current server uses `bash` as PID 1, without systemd or an available container startup hook. These scripts do **not** guarantee restart after the container or host reboots. Configure the container's startup command or a host-managed task to run `deploy/start.sh` if automatic boot recovery is required.

The default certificate is self-signed with SANs for `ddns.984797.xyz`, `localhost`, and `127.0.0.1`. For normal browser trust, install a valid certificate through `TLS_CERT`/`TLS_KEY` or explicitly trust this certificate in the test environment. Keep TLS verification enabled; a local diagnostic can use `curl --cacert /home/deepmark/runtime/tls/deepmark.crt https://localhost:8443/api/health`.

For a browser test over SSH, forward the loopback HTTP listener and open `http://localhost:8787`. Browser localhost origins are secure contexts. Public access to `https://ddns.984797.xyz:8443` also depends on router/firewall routing and must be verified separately; starting the listener alone does not establish public reachability.
