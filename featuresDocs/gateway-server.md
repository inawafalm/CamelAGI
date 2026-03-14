# CamelAGI Gateway Server

The Gateway Server is the central orchestration point for CamelAGI. It exposes both an HTTP REST API and a WebSocket interface, providing a unified entry point for the TUI, Telegram bots, and any external clients.

---

## Architecture Overview

The gateway is built on **Express** (HTTP) and the **ws** library (WebSocket), sharing a single `http.Server` instance. All mutable runtime state is held in a single `GatewayState` object passed to both the route handler and the WebSocket handler.

```
┌──────────────────────────────────────────────┐
│                http.Server                   │
│  ┌──────────────────┐  ┌──────────────────┐  │
│  │   Express app    │  │  WebSocketServer │  │
│  │  (REST routes)   │  │  (ws handler)    │  │
│  └────────┬─────────┘  └────────┬─────────┘  │
│           └──────────┬──────────┘            │
│              GatewayState                    │
│   { config, client, systemPrompt,           │
│     token, clients, startTime }             │
└──────────────────────────────────────────────┘
```

### Key source files

| File | Purpose |
|------|---------|
| `src/serve.ts` | Server startup, heartbeat, config watcher, shutdown |
| `src/gateway/routes.ts` | All REST API endpoints |
| `src/gateway/ws-handler.ts` | WebSocket message handling |
| `src/gateway/state.ts` | Shared state type, auth check, helpers |
| `src/gateway/rate-limit.ts` | In-memory sliding-window rate limiter |
| `src/gateway/csrf.ts` | CSRF protection middleware |
| `src/gateway/logger.ts` | JSON-line request logger |

---

## GatewayState

All handlers share a single mutable state object:

```ts
interface GatewayState {
  config: Config;          // Current (hot-reloadable) configuration
  client: Anthropic;       // OpenAI-compatible SDK client
  systemPrompt: string;    // Compiled system prompt
  token: string | undefined; // Bearer token for auth (from config.serve.token)
  silent: boolean;         // Suppress console logging
  clients: Set<WebSocket>; // Connected WebSocket clients
  startTime: number;       // Server start timestamp (epoch ms)
}
```

---

## Authentication

All endpoints except `GET /health` require authentication when `config.serve.token` is set. If no token is configured, all requests are allowed through.

### Mechanism

- **HTTP**: The `Authorization` header must contain `Bearer <token>`.
- **WebSocket**: The `Authorization` header is checked on connection. Alternatively, the token can be passed as a query parameter: `ws://host:port?token=<token>`.

### Timing-safe comparison

Token comparison uses SHA-256 hashing followed by `crypto.timingSafeEqual` to prevent timing attacks:

```ts
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
```

### Failure responses

- HTTP: `401 { error: "Unauthorized" }`
- WebSocket: Connection closed with code `4001` and reason `"Unauthorized"`

---

## REST API Endpoints

All request and response bodies are JSON. Authenticated endpoints are marked with a lock icon.

### Health Check

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/health` |
| **Auth** | None |
| **Response** | `{ status, uptime, sessions, clients, activeRuns, lanes }` |

Returns server health information. `uptime` is in seconds. `lanes` contains concurrency lane statistics.

---

### Chat

| | |
|---|---|
| **Method** | `POST` |
| **Path** | `/chat` |
| **Auth** | Required |
| **Request body** | `{ message: string, session?: string }` |
| **Response** | `{ response: string, session: string }` |
| **Error** | `400` if `message` missing; `500` on orchestration failure |

Sends a message through the orchestration pipeline. If `session` is omitted, a session ID is generated as `http-<timestamp>`.

---

### Sessions

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/sessions` | Required | List all sessions. Returns an array of session metadata. |
| `GET` | `/sessions/:id/messages` | Required | Get message history for a session. Returns `[{ role, content }]`. |
| `DELETE` | `/sessions/:id` | Required | Delete a session. Returns `{ ok: true }`. |

---

### Agents

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/agents` | Required | List all agents with their status (name, model, telegram running, directory). |
| `POST` | `/agents` | Required | Create a new agent. |
| `DELETE` | `/agents/:id` | Required | Remove an agent from config. |
| `GET` | `/agents/:id/soul` | Required | Read the agent's SOUL.md file. Returns `{ content: string }`. |
| `PUT` | `/agents/:id/soul` | Required | Write the agent's SOUL.md file. Body: `{ content: string }`. |

**POST /agents request body:**
```json
{
  "id": "string (required)",
  "name": "string (required)",
  "model": "string (optional, defaults to global model)",
  "description": "string (optional)",
  "telegramToken": "string (optional)",
  "allowedUsers": ["number[] (optional)"]
}
```

**POST /agents response:** `201 { id, name, dir }`

**POST /agents errors:**
- `400` if `id` or `name` missing
- `409` if agent ID already exists

---

### Config

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/config` | Required | Returns the current config with `apiKey` masked (`***<last4>`). |
| `PATCH` | `/config` | Required | Merge-update config fields. `apiKey` and `serve` fields are stripped for safety. Triggers client and system prompt rebuild. |

---

### Pairing (Telegram user pairing)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/pairing` | Required | List pending pairing requests. |
| `POST` | `/pairing/:code/approve` | Required | Approve a pairing request. Returns `{ ok, otp, userId, agentId }`. Notifies the Telegram user to enter the OTP. |
| `POST` | `/pairing/:code/deny` | Required | Deny a pairing request. Notifies the Telegram user. Returns `{ ok: true }`. |

---

### Bot Approvals

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/bot-approvals` | Required | List pending bot approval requests. |
| `POST` | `/bot-approvals/:agentId/approve` | Required | Approve and start a bot. Returns `{ ok, agentId, botUsername }`. |
| `POST` | `/bot-approvals/:agentId/deny` | Required | Deny a bot approval. Returns `{ ok: true }`. |

---

### Tool Approvals

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/approvals/:id/decide` | Required | Submit a tool approval decision. Body: `{ decision: "allow-once" | "allow-always" | "deny" }`. Returns `{ ok: boolean }`. |

---

## WebSocket Protocol

Connect to `ws://<host>:<port>` with an `Authorization` header or `?token=<token>` query parameter.

All messages are JSON objects with a `type` field.

### Client-to-Server Messages

#### `chat` -- Send a message

```json
{
  "type": "chat",
  "message": "string",
  "session": "string (optional, defaults to ws-<timestamp>)",
  "sdkSessionId": "string (optional, for resuming SDK sessions)"
}
```

During processing, the server streams `AgentEvent` objects to the client (e.g., thinking, tool calls, text deltas). When complete, a `done` message is sent.

#### `sessions.list` -- List sessions

```json
{ "type": "sessions.list" }
```

Response: `{ type: "sessions", sessions: [...] }`

#### `sessions.delete` -- Delete a session

```json
{ "type": "sessions.delete", "id": "session-id" }
```

Response: `{ type: "sessions", sessions: [...] }` (updated list)

#### `sessions.history` -- Get session history

```json
{ "type": "sessions.history", "id": "session-id" }
```

The `id` field can also be specified as `session` (alias). If both are present, `id` takes precedence.

Response: `{ type: "history", session: "id", messages: [{ role, content }] }`

#### `compact` -- Compact session history

```json
{ "type": "compact", "session": "session-id" }
```

Response: `{ type: "compacted", session, oldCount, newCount }`

#### `status` -- Get runtime status

```json
{ "type": "status", "session": "session-id (optional)" }
```

Response:
```json
{
  "type": "status",
  "session": "...",
  "model": "...",
  "provider": "...",
  "messageCount": 42,
  "historyTokens": 1500,
  "usage": { "calls": 5, "inputTokens": 1000, "outputTokens": 500 },
  "lanes": { ... },
  "activeRuns": 1
}
```

#### `model.switch` -- Switch model at runtime

```json
{
  "type": "model.switch",
  "model": "string (optional)",
  "thinking": "string (optional)"
}
```

Response: `{ type: "model.switched", model, thinking }`

#### `abort` -- Abort current run

```json
{ "type": "abort" }
```

Response: `{ type: "aborted" }`

#### `approval.decide` -- Submit tool approval decision

```json
{
  "type": "approval.decide",
  "id": "approval-id",
  "decision": "allow-once | allow-always | deny"
}
```

No success response; an `error` message is sent only if the approval was not found.

### Server-to-Client Messages

| Type | Description |
|------|-------------|
| `AgentEvent` (various) | Streamed during `chat` processing: init, thinking, tool_call, text delta, etc. |
| `done` | Chat completion. Contains `response`, `session`, `runId`, `usage`, `sdkSessionId`. |
| `queued` | The request was queued due to lane concurrency limits. Contains `session`. |
| `retry` | A retry is happening. Contains `attempt` and `kind`. |
| `compacted` | History was compacted. Contains `oldCount` and `newCount`. |
| `sessions` | Session list response. Contains `sessions` array. |
| `history` | Session message history. Contains `session` and `messages`. |
| `status` | Runtime status. Contains model, usage, lanes, etc. |
| `model.switched` | Confirms model switch. Contains `model` and `thinking`. |
| `aborted` | Confirms abort of current run. |
| `error` | Error message. Contains `message: string`. |

---

## Rate Limiting

An in-memory sliding-window rate limiter is applied to all HTTP requests.

### Configuration

Set via `config.serve.rateLimit`:

```yaml
serve:
  rateLimit:
    windowMs: 60000   # Window duration in milliseconds
    max: 100           # Maximum requests per window per IP
```

### Behavior

- Keyed by `req.ip`.
- A cleanup interval runs every `windowMs` to remove expired entries (using `.unref()` so it does not prevent process exit).
- When the limit is exceeded, the server responds with `429 { error: "Too many requests, please try again later" }`.

### Response Headers

Every response includes:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests allowed in the window |
| `X-RateLimit-Remaining` | Requests remaining in the current window |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when the window resets |

When the rate limit is exceeded (429), an additional header is included:

| Header | Description |
|--------|-------------|
| `Retry-After` | Seconds until the current window resets |

---

## Request Body Limits

JSON request bodies are limited to **1 MB** via `express.json({ limit: "1mb" })`. Requests exceeding this limit receive a `413 Payload Too Large` response. This prevents abuse from oversized payloads while allowing generous message sizes for normal usage.

---

## CSRF Protection

Applied as Express middleware to all mutation requests (non-GET/HEAD/OPTIONS).

### Rules

1. **`Sec-Fetch-Site` header**: If present and set to `cross-site`, the request is blocked with `403`.
2. **`Origin` header**: If present, must resolve to a loopback address (`localhost`, `127.0.0.1`, or `::1`). Non-local origins are blocked with `403`.
3. **`Referer` header**: If `Origin` is absent but `Referer` is present, the referer must also be a loopback address.
4. **Non-browser clients**: Clients like `curl` or Node.js `fetch` that do not send `Origin`/`Sec-Fetch-Site` headers pass through without restriction.

### Allowed loopback hosts

`localhost`, `127.0.0.1`, `::1`

---

## Request Logging

### Format

Each HTTP request is logged as a JSON line to `~/.camelagi/logs/server.log`:

```json
{
  "ts": "2026-03-13T12:00:00.000Z",
  "method": "POST",
  "path": "/chat",
  "status": 200,
  "ms": 1234,
  "sessionId": "http-1710316800000",
  "error": "Not Found"
}
```

- `sessionId` is included when available (from `req.body.session` or `req.params.id`).
- `error` is included only for responses with status >= 400.
- Logging is disabled when the server starts with `silent: true`.

### Log Rotation

- On startup, the logger checks if the current log file's modification date differs from today. If so, it renames the file to `server-<YYYY-MM-DD>.log`.
- Rotated log files older than **7 days** are automatically deleted.

### File Location

| File | Purpose |
|------|---------|
| `~/.camelagi/logs/server.log` | Current day's log |
| `~/.camelagi/logs/server-YYYY-MM-DD.log` | Rotated logs from previous days |

### Console Logging

In addition to file logging, the gateway logs message traffic to the console with colored arrows:

- `→` (cyan): Inbound message
- `←` (green): Outbound response

Format: `[channel:sessionId] <preview up to 160 chars>`

Session IDs are truncated to the first 16 characters in the tag. Message previews have newlines replaced with spaces.

---

## Heartbeat / Ping-Pong

The server maintains WebSocket connection health using the WebSocket ping/pong protocol.

- **Interval**: Every **30 seconds** (`HEARTBEAT_INTERVAL_MS`).
- **Mechanism**:
  1. On connection, each client is marked as `alive = true`.
  2. Every 30 seconds, the heartbeat loop iterates over all connected clients:
     - If `alive` is `false`, the client is terminated (connection presumed dead).
     - Otherwise, `alive` is set to `false` and a `ping` frame is sent.
  3. When the client responds with a `pong`, `alive` is set back to `true`.
- Dead clients are removed from `state.clients` and their connections are terminated.

---

## Config Hot-Reload

The gateway watches `~/.camelagi/` for changes to `config.yaml` using `fs.watch`.

### Mechanism

1. The **directory** is watched (not the file), so that newly created `config.yaml` files are also detected (e.g., after a reset + onboarding).
2. Changes are **debounced by 500ms** to coalesce rapid writes.
3. On change, `loadConfig()` is called to re-parse and validate the config.
4. The following state is updated:
   - `state.config` -- new configuration
   - `state.systemPrompt` -- rebuilt from new config
   - Lane configurations are reconfigured
   - Cron context is updated
   - Telegram bots are reconciled (new agents started, removed agents stopped)

### In-memory sync via `onConfigSaved`

In addition to file watching, `onConfigSaved` is registered as a callback that fires immediately whenever `saveConfig()` is called programmatically (e.g., via `PATCH /config` or `POST /agents`). This provides instant state sync without waiting for the filesystem watcher debounce.

---

## Startup Sequence

1. **`ensureDirs()`** -- Create required directories (`~/.camelagi/`, sessions, etc.).
2. **`seedWorkspace()`** -- Write bootstrap files (AGENTS.md, SOUL.md, etc.) if missing.
3. **`loadConfig()`** -- Parse and validate `~/.camelagi/config.yaml`.
4. **Build initial state** -- Create the `GatewayState` object with config, client, system prompt, and empty client set.
5. **Configure lanes** -- Set concurrency limits for Main, Cron, and Subagent lanes.
6. **Register `onConfigSaved` callback** -- For immediate in-memory config sync.
7. **Set cron context** -- So runtime-added cron jobs can auto-start.
8. **Create Express app** -- Apply middleware in order:
   1. `express.json({ limit: "1mb" })` -- Body parsing (1 MB max request body)
   2. `csrfProtection()` -- CSRF guard
   3. `requestLogger()` -- JSON-line file logging (skipped if silent)
   4. `rateLimit()` -- Sliding-window rate limiter
9. **Create HTTP server and WebSocketServer**.
10. **Start heartbeat interval** (30s).
11. **Register route and WebSocket handlers**.
12. **Bind and listen** on configured host and port.
13. **Run boot script** (`BOOT.md`) if configured and `opts.boot !== false`.
14. **Start Telegram bots** if any agent or legacy config has a bot token.
15. **Start cron jobs** (config-defined + runtime-defined).
16. **Start config file watcher** with Telegram reconciliation on change.
17. **Register SIGINT/SIGTERM handlers** for graceful shutdown (unless silent mode).

---

## Graceful Shutdown

Triggered by `SIGINT` or `SIGTERM` signals, or by calling the `close()` method on the returned `ServerHandle`.

### Shutdown steps

1. **Clear heartbeat interval** -- Stop the 30s ping loop.
2. **Close config file watcher** -- Stop watching `~/.camelagi/`.
3. **Stop all cron jobs** -- Cancel all scheduled tasks.
4. **Close all WebSocket clients** -- Send close frame with code `1001` ("Going Away") and reason `"Server shutting down"`.
5. **Stop Telegram bots** -- Gracefully stop all running Telegram bot instances.
6. **Close HTTP server** -- Stop accepting new connections and wait for existing ones to drain.

---

## Config Options

The gateway reads its configuration from the `serve` section of `~/.camelagi/config.yaml`:

```yaml
serve:
  port: 3000           # Port to listen on (default from config schema)
  host: "127.0.0.1"    # Bind address
  token: "my-secret"   # Bearer token for auth (optional; no auth if omitted)
  rateLimit:
    windowMs: 60000    # Rate limit window in milliseconds
    max: 100           # Max requests per IP per window
```

### ServeOpts (programmatic)

When starting the server programmatically via `startServer(opts)`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | `config.serve.port` | Override listen port |
| `host` | `string` | `config.serve.host` | Override bind host |
| `channels` | `boolean` | `true` | Enable/disable Telegram bots |
| `cron` | `boolean` | `true` | Enable/disable cron jobs |
| `boot` | `boolean` | `true` | Enable/disable boot script |
| `silent` | `boolean` | `false` | Suppress console output and request logging |

### ServerHandle (return value)

`startServer()` returns a handle for programmatic control:

```ts
interface ServerHandle {
  port: number;            // Actual port (may differ from requested if 0)
  close: () => Promise<void>; // Graceful shutdown
  config: Config;          // Initial config snapshot
  client: Anthropic;       // SDK client instance
  systemPrompt: string;    // Compiled system prompt
}
```
