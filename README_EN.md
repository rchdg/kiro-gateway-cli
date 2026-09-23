# Kiro Gateway CLI (Node.js)

[English](README_EN.md) | [简体中文](README.md)

A Node.js implementation of the Kiro Gateway — a transparent proxy that exposes
the Kiro API (Amazon Q Developer / AWS CodeWhisperer) as OpenAI-compatible and
Anthropic-compatible endpoints.

## Requirements

- Node.js >= 23.4 (uses the built-in `node:sqlite` module)
- npm

## Install

```bash
cd kiro-gateway-cli
npm install
```

## Usage

```bash
# Start with defaults (host: 0.0.0.0, port: 8000)
npm start

# Explicit serve subcommand (same as the default behavior)
kiro-gateway serve

# Custom port / host
kiro-gateway serve --port 9000
kiro-gateway serve --host 127.0.0.1 --port 9000
node bin/kiro-gateway.js serve --port 9000
node bin/kiro-gateway.js --host 127.0.0.1 --port 9000

# Run in the background (daemon) - returns immediately
kiro-gateway serve --background
kiro-gateway serve -b --port 9000

# Stop the background server (run from the same directory)
kiro-gateway stop

# Global install (adds the `kiro-gateway` command)
npm link
kiro-gateway serve --port 9000
```

### Common configuration via CLI flags

The most common configuration items can be passed as CLI arguments
(highest priority - they override `.env` and environment variables):

```bash
kiro-gateway serve \
  -k my-super-secret-key \                  # PROXY_API_KEY (optional; unset = no auth)
  -t your_refresh_token \                   # REFRESH_TOKEN (or -f / -d instead)
  -f ~/.aws/sso/cache/kiro-auth-token.json  # KIRO_CREDS_FILE (JSON credentials)
  -d ~/.local/share/kiro-cli/data.sqlite3   # KIRO_CLI_DB_FILE (kiro-cli SQLite)
  -r us-east-1 \                            # KIRO_REGION
  --api-region eu-central-1 \               # KIRO_API_REGION override
  --profile-arn arn:aws:codewhisperer:... \ # PROFILE_ARN
  --log-level DEBUG \                       # LOG_LEVEL
  --proxy-url http://127.0.0.1:7890 \       # VPN_PROXY_URL (HTTP/HTTPS/SOCKS5)
  --proxy-url socks5h://127.0.0.1:1080 \    # SOCKS5 with proxy-side DNS (socks5h)
  --proxy-url socks5://127.0.0.1:1080 \     # SOCKS5 with client-side DNS (socks5)
  --account-system \                        # enable multi-account failover
  -H 0.0.0.0 -p 8000                        # server binding
```

Run `kiro-gateway --help` for the full list.

Configuration priority (highest to lowest):
1. CLI arguments (`--api-key`, `--port`, ...)
2. Environment variables (`.env` file / process env)
3. Default values (`0.0.0.0:8000`, credentials: `~/.aws/sso/cache/kiro-auth-token.json`)

The `serve` subcommand is optional - running `kiro-gateway` with no arguments
starts the server the same way.

### Running in the background

`serve --background` (or `-b`) starts the server as a detached daemon and
returns immediately. The parent waits for the server to become healthy
(health endpoint) and prints the result.

```bash
kiro-gateway serve --background --port 9000
# Starting server in the background (pid 12345)...
# Server is running in the background: http://127.0.0.1:9000/health
# Stop it with: kiro-gateway stop

kiro-gateway stop
# Background server stopped (pid 12345).
```

Daemon state files (relative to the working directory, so `stop` must be run
from the same directory as `serve --background`):

- `.kiro-gateway.pid` - PID of the background server (override: `KIRO_PID_FILE`)
- `kiro-gateway.log` - daemon output (override: `KIRO_LOG_FILE`)

Before starting, the CLI checks that the target port is free and aborts with
an actionable message when another service is already listening there. If the
background server exits during startup (bad credentials, port conflict), the
CLI reports the failure and shows the last log lines.

### Platform notes (Windows)

The daemon works on Windows too: the child is spawned without a console
window (`windowsHide`) and redirects its output to the log file itself
(Win32 cannot inherit arbitrary file descriptors via `stdio`). One caveat:
Windows has no POSIX signals, so `kiro-gateway stop` terminates the
background process directly instead of triggering its graceful shutdown
handler. The pid file is still cleaned up by `stop`, and ungraceful
termination is safe because the pid file is validated against the process
state on every `start`/`stop`.

## Configuration

Copy the root `.env.example` to `.env` (next to `kiro-gateway-cli`) or use
environment variables:

| Variable | Description |
| --- | --- |
| `PROXY_API_KEY` | API key clients must send (optional; empty/unset = authentication disabled) |
| `REFRESH_TOKEN` | Kiro refresh token (Option 2) |
| `KIRO_CREDS_FILE` | Path to Kiro IDE credentials JSON (Option 1, recommended; default: `~/.aws/sso/cache/kiro-auth-token.json`) |
| `KIRO_CLI_DB_FILE` | Path to kiro-cli SQLite database (Option 3, AWS SSO) |
| `KIRO_REGION` | SSO/auth region (default: `us-east-1`) |
| `KIRO_API_REGION` | Override the Q API region |
| `PROFILE_ARN` | AWS CodeWhisperer profile ARN override |
| `SERVER_HOST` / `SERVER_PORT` | Server binding |
| `VPN_PROXY_URL` | Proxy for restricted networks: HTTP/HTTPS or SOCKS (`socks5://`, `socks5h://` for proxy-side DNS, `socks4a://`) |
| `LOG_LEVEL` | `DEBUG`, `INFO`, `WARNING`, `ERROR` (default: `INFO`) |
| `KIRO_PID_FILE` | PID file for `--background` mode (default: `.kiro-gateway.pid`) |
| `KIRO_LOG_FILE` | Log file for `--background` mode (default: `kiro-gateway.log`) |
| `ACCOUNT_SYSTEM` | Enable multi-account failover (`true`/`false`) |
| `FAKE_REASONING` | Extended thinking via tag injection (default: **disabled**). Kiro blocks reasoning extraction server-side: once the model opens a `<thinking>` block the turn comes back as `CONTENT_FILTERED` / `REASONING_EXTRACTION` and the answer is lost. Set to `1` to opt in at your own risk |
| `FIRST_TOKEN_TIMEOUT` | First-token wait before retry (default: 15s) |

### Credentials (multi-account)

Credentials can be provided as `credentials.json` (next to the CLI) with an
array of accounts:

```json
[
  { "type": "json", "path": "~/.aws/sso/cache/kiro-auth-token.json", "region": "us-east-1" },
  { "type": "refresh_token", "refresh_token": "your-token" },
  { "type": "sqlite", "path": "~/.local/share/kiro-cli/data.sqlite3" }
]
```

If `credentials.json` does not exist, the CLI creates it once from the legacy
`.env` variables (`KIRO_CREDS_FILE` > `REFRESH_TOKEN` > `KIRO_CLI_DB_FILE`).

## API Endpoints

| Endpoint | Auth | Description |
| --- | --- | --- |
| `GET /` | none | Health check |
| `GET /health` | none | Detailed health check |
| `GET /v1/models` | `Authorization: Bearer {PROXY_API_KEY}` (only if a key is configured) | List models |
| `POST /v1/chat/completions` | Bearer (only if a key is configured) | OpenAI chat (streaming + non-streaming) |
| `POST /v1/messages` | `x-api-key` or Bearer (only if a key is configured) | Anthropic messages (streaming + non-streaming) |
| `POST /v1/messages/count_tokens` | `x-api-key` (only if a key is configured) | Token estimation |

### Example

When `PROXY_API_KEY` is set, clients must send it:

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.5", "messages": [{"role": "user", "content": "Hello"}]}'
```

If `PROXY_API_KEY` is left unset, no authentication is required and the
`Authorization` header can be omitted.

## What is ported

- **Auth**: Kiro Desktop refresh, AWS SSO OIDC (kiro-cli), JSON credentials
  (including Enterprise `clientIdHash` device registration), SQLite read +
  read-merge-write token refresh
- **Model resolution**: 4-layer pipeline (alias → normalize → cache/hidden →
  pass-through)
- **Converters**: full OpenAI/Anthropic → Kiro pipeline (system prompt,
  tools, tool calls/results, images, adjacent-message merging, role
  alternation, thinking tag injection, JSON schema sanitization)
- **Streaming**: AWS event stream parser, thinking-block FSM, first-token
  timeout with retry, OpenAI `chat.completion.chunk` SSE and Anthropic
  Messages SSE formats
- **HTTP client**: 403 token-refresh retry, 429/5xx exponential backoff,
  network error classification, per-request abort on client disconnect
- **Account system**: multi-account failover with sticky index and circuit
  breaker, lazy initialization

## Tests

```bash
npm test
```

Tests cover parsers, thinking parser, model resolver, converters, error
classification, auth, HTTP client retries, streaming formats, and full
end-to-end server behavior (with mocked upstream). No network access needed.
