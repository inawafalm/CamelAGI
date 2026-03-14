# CamelAGI Runtime Internals

This document covers every subsystem that makes up the CamelAGI runtime layer: from message ingestion through agent execution, concurrency control, persistence, and system management.

---

## Table of Contents

1. [Orchestrator](#orchestrator)
2. [Queue](#queue)
3. [Lanes](#lanes)
4. [Runs](#runs)
5. [Retry](#retry)
6. [Compaction](#compaction)
7. [Sessions](#sessions)
8. [Usage Tracking](#usage-tracking)
9. [Chunker](#chunker)
10. [Boot Scripts](#boot-scripts)
11. [Daemon](#daemon)
12. [Doctor](#doctor)

---

## Orchestrator

**File:** `src/runtime/orchestrate.ts`

The orchestrator is the single source of truth for the chat flow. Before it existed, the same check-active / queue / acquire-lane / run-agent / save sequence was duplicated across `routes.ts`, `ws-handler.ts`, and `agent-bot.ts`. Now every entry point calls `orchestrate()`.

### Step-by-step flow

1. **Queue check** -- If a run is already active on the target `sessionId`, the inbound message is handed to `queueOrProcess()`. When queued, the caller receives a promise that resolves once the queued message is eventually processed. The orchestrator returns early with `queued: true`.

2. **Lane acquisition** -- `acquireLane(Lane.Main)` is called to obtain a concurrency slot. If all slots are taken, the call blocks until one frees up.

3. **Run registration** -- A unique `runId` is generated and an active-run handle is registered via `setActiveRun()`. The handle carries `sessionId`, `runId`, `startedAt` timestamp, an `abort()` callback, and an `isStreaming()` indicator.

4. **Abort wiring** -- If the caller supplied an `AbortSignal`, a dedicated `AbortController` is created and linked so that external abort propagates into the agent run.

5. **History loading + compaction** -- `loadMessages(sessionId)` reads the JSONL session file. The history is then passed to `compactHistory()` which may summarize older turns if token estimates exceed the compaction threshold. Callers are notified via the `onCompact` callback.

6. **Agent execution with retry** -- The agent is run inside `withRetry()`. Configuration values are resolved with per-call overrides taking precedence: `model`, `agentSystemPrompt`, `thinking`, `effort`, and `maxTurns` all fall back to `config.*` when no override is supplied.

7. **Message persistence** -- On success, both the user message and the assistant response are appended to the session JSONL file via `saveMessage()`.

8. **Cleanup (finally block)** -- `clearActiveRun(runId)` removes the run handle (notifying any waiters) and `release()` frees the lane slot. After cleanup, the queue for the session is drained: the first queued message is processed by recursively calling `orchestrate()`, and any remaining queued messages are rejected with "Superseded by newer message".

### OrchestrateOpts

| Field | Purpose |
|---|---|
| `sessionId` | Target session |
| `message` | User message text |
| `config` | Full resolved Config |
| `systemPrompt` | Base system prompt |
| `client` | Anthropic SDK client |
| `signal` | Optional AbortSignal for cancellation |
| `onEvent` | Streaming event callback |
| `onRetry` | Retry notification |
| `onCompact` | Compaction notification (old count, new count) |
| `agentId` | Agent identifier (multi-agent) |
| `resumeSessionId` | SDK session to resume |
| `label` | Session label for persistence |
| `model` | Per-call model override |
| `agentSystemPrompt` | Per-call system prompt override |
| `thinking` | Per-call thinking mode override |
| `effort` | Per-call effort override |
| `maxTurns` | Per-call max turns override |

### OrchestrateResult

| Field | Type | Notes |
|---|---|---|
| `response` | `string` | Assistant reply text |
| `runId` | `string` | Unique run identifier |
| `sessionId` | `string` | Echo of the session used |
| `usage` | `RunResult["usage"]` | Token usage from the agent, or `null` |
| `sdkSessionId` | `string?` | Anthropic SDK session ID (if returned) |
| `queued` | `boolean?` | `true` when the message was queued instead of processed immediately |

---

## Queue

**File:** `src/runtime/queue.ts`

The message queue prevents lost messages when a user sends input while the agent is still processing a previous turn on the same session.

### Data model

Each queued message is stored as a `QueuedMessage`:

```
{ text: string, resolve, reject, enqueuedAt: number }
```

The backing store is a `Map<sessionId, QueuedMessage[]>` held in memory (not persisted to disk).

### Key operations

| Function | Behavior |
|---|---|
| `queueOrProcess(sessionId, text)` | If no run is active, returns `{ queued: false }` so the caller proceeds normally. If a run is active, enqueues the message, waits for the run to end (`waitForRunEnd`), then returns `{ queued: true, promise }`. |
| `enqueueMessage(sessionId, text)` | Creates a `Promise<string>` whose resolve/reject are stored alongside the text. The promise settles when a consumer drains the queue and processes the message. |
| `getQueueLength(sessionId)` | Returns the number of pending messages for a session. |
| `drainQueue(sessionId)` | Atomically removes and returns all queued messages for a session. |
| `clearQueue(sessionId)` | Rejects every queued promise with `"Queue cleared"` and deletes the queue. |
| `reset()` | Clears all session queues (used in tests). |

### Factory pattern

`createMessageQueue()` returns a fresh instance. A default singleton is also exported for backward compatibility.

---

## Lanes

**File:** `src/runtime/lanes.ts`

Lanes provide concurrency control over parallel agent runs. They prevent the system from overwhelming the LLM provider with too many simultaneous requests.

### Lane types

```typescript
enum Lane {
  Main     = "main",      // User-initiated chat turns
  Cron     = "cron",      // Scheduled / cron-triggered runs
  Subagent = "subagent",  // Agent-spawned sub-agent calls
}
```

### How it works

Each lane has:

- `limit` -- maximum number of concurrent runs (defaults to `Infinity` if never configured).
- `active` -- current count of in-flight runs.
- `queue` -- FIFO array of `() => void` resolve callbacks from waiters.

**Acquiring a lane:**

1. If `active < limit`, increment `active` immediately and return a release function.
2. Otherwise, push a resolve callback onto the FIFO queue. The caller's `await acquireLane(lane)` blocks until a slot opens.

**Releasing a lane:**

1. Decrement `active`.
2. Shift the next waiter off the queue (if any) and invoke it, which unblocks that caller so it can increment `active` and proceed.

### API

| Function | Purpose |
|---|---|
| `configureLane(lane, limit)` | Set or update the concurrency limit for a lane. |
| `acquireLane(lane)` | Returns `Promise<() => void>` -- the release function. |
| `getLaneStats()` | Returns `{ active, limit, queued }` for every configured lane. `limit = -1` means unlimited. |
| `reset()` | Clears all lane state (testing). |

---

## Runs

**File:** `src/runtime/runs.ts`

The run tracker prevents concurrent runs on the same session and provides abort/wait primitives.

### Data structures

- **Primary index:** `Map<runId, RunHandle>` -- lookup by run ID.
- **Secondary index:** `Map<sessionId, runId>` -- maps each session to its latest run.
- **Waiters:** `Map<sessionId, Set<(ended: boolean) => void>>` -- callbacks waiting for a run to finish.

### RunHandle

```typescript
{
  sessionId: string;
  runId: string;
  startedAt: number;     // Date.now() at creation
  abort: () => void;     // Triggers the run's AbortController
  isStreaming: () => boolean;
}
```

### Key operations

| Function | Behavior |
|---|---|
| `generateRunId()` | Returns `run-{timestamp}-{counter}` with a monotonically increasing counter. |
| `setActiveRun(sessionId, handle)` | Registers a run. If a run already exists for that session, it is **aborted** first and removed. |
| `clearActiveRun(runId)` | Removes the run from both indexes. Only clears the session mapping if the run being cleared is still the latest for that session. Notifies all waiters with `true`. |
| `isRunActive(sessionId)` | Returns `true` if the session has a registered run. |
| `getActiveRun(sessionId)` | Returns the `RunHandle` or `undefined`. |
| `abortRun(sessionId)` | Calls `handle.abort()`, then `clearActiveRun()`. Returns `true` if a run was found. |
| `waitForRunEnd(sessionId, timeoutMs?)` | Returns a promise that resolves to `true` when the run ends, or `false` on timeout. Default timeout: `QUEUE_WAIT_TIMEOUT_MS` (15 seconds). |
| `acquireRun(sessionId, handle)` | Atomic check-and-set: returns `false` if a run is already active, otherwise registers and returns `true`. |
| `getActiveRunCount()` | Number of currently tracked runs across all sessions. |

---

## Retry

**File:** `src/runtime/retry.ts`

### Error classification

Errors are classified using a two-tier approach for reliability:

1. **Status code extraction** — The classifier first checks for `.status` or `.statusCode` properties on the error object (set by OpenAI and Anthropic SDKs). If not found, it falls back to extracting standalone 3-digit HTTP codes from the error message (e.g., "Error 429" but not "model-429b").

2. **String matching fallback** — If no status code is found, error messages are matched against known patterns.

| ErrorKind | Status Codes | String Matches | Retryable? |
|---|---|---|---|
| `abort` | — | Exact match: "aborted", "the operation was aborted", "this operation was aborted"; also `AbortError` name | No — immediate throw |
| `auth` | 401, 403 | "unauthorized", "invalid api key", "token expired" | No — immediate throw |
| `billing` | 402 | "insufficient", "payment required", "billing" | No — immediate throw |
| `rate_limit` | 429 | "rate limit", "too many requests", "quota", "resource exhausted" | Yes |
| `server_error` | 500–599 | "service unavailable", "internal server error", "bad gateway" | Yes |
| `overflow` | — | "context" + "exceeded"/"too large", "prompt is too long", "request too large", "maximum context length" | Special (compact + retry once) |
| `timeout` | 408 | "timeout", "deadline exceeded", "etimedout" | Yes |
| `format` | 400, 422 | "invalid request", "validation" | No — immediate throw |
| `unknown` | — | Everything else | Retry once, then fail |

Key improvements over the previous classifier:
- **`server_error`** is a distinct type (previously misclassified as `rate_limit`)
- **Abort detection** uses exact string match and `AbortError` name check — no false positives from timeout messages containing "abort"
- **Status code priority** avoids brittle substring matching (e.g., "500" in a URL won't trigger misclassification)

### Retry behavior

`withRetry(fn, opts)` wraps an async function:

- **rate_limit / timeout / server_error:** Retried up to `maxRetries` times with capped exponential backoff: `delay = min(backoffMs * 2^attempt, maxBackoffMs)`. Default cap is 30 seconds.
- **overflow:** Calls `onCompact()` (which force-compacts the history) then retries **once**. A flag (`overflowRetried`) prevents infinite compact loops.
- **unknown:** Retried once with a flat `backoffMs` delay, then fails.
- **auth / billing / format / abort:** Thrown immediately, no retry.

The `onRetry(attempt, kind, err)` callback fires before each retry sleep.

### RetryOpts

| Field | Type | Default | Description |
|---|---|---|---|
| `maxRetries` | `number` | — | Maximum number of retry attempts |
| `backoffMs` | `number` | — | Base backoff delay in milliseconds |
| `maxBackoffMs` | `number` | 30000 | Maximum backoff delay cap (prevents unbounded growth) |
| `onRetry` | `function` | — | Callback before each retry |
| `onCompact` | `function` | — | Called on overflow errors to compact context |

---

## Compaction

**File:** `src/runtime/compact.ts`

Compaction prevents context overflow by summarizing old conversation turns when estimated token usage gets too high.

### Trigger condition

Token count is estimated at **4 characters per token** (`CHARS_PER_TOKEN`). Compaction fires when:

```
estimatedTokens >= maxTokens * 0.8   (COMPACTION_TRIGGER_RATIO)
```

If compaction is disabled in config (`enabled: false`), the function returns `null` immediately.

### Process

1. **Split history** -- Messages are divided into `old` and `recent` by counting user-message turn boundaries. The last `keepTurns` turns (default 6) are kept verbatim.

2. **Memory flush** -- Before summarizing, the `old` messages are passed to `memoryFlush()`. This sends the old conversation text (up to `MEMORY_FLUSH_MAX_CHARS` = 30,000 characters) to the LLM with a prompt asking it to extract durable facts as bullet points. If meaningful facts are extracted, they are appended to a daily file under a timestamped `## HH:MM:SS (auto-flush)` heading. The destination is agent-scoped: when `agentId` is provided, notes land in `~/.camelagi/agents/<agentId>/memory/{YYYY-MM-DD}.md`; otherwise they go to the global `~/.camelagi/workspace/memory/{YYYY-MM-DD}.md`. The flush is best-effort: errors are silently caught.

3. **Summarize** -- The old messages are formatted as `[role]: content` blocks and sent to the LLM with a summarization prompt. The summary is wrapped in a synthetic user message:
   ```
   [Previous conversation summary]
   {summary text}
   [End of summary -- conversation continues below]
   ```

4. **Validate** -- The compacted result's estimated token count is compared against the original. If the compacted result is equal to or larger than the original (e.g., when recent turns dominate the context), compaction is skipped with a warning to stderr: `"⚠ Compaction skipped: result (N tokens) >= original (M tokens)"`. This prevents compaction from making things worse.

5. **Return** -- The compacted history is `[summaryMessage, ...recentMessages]`, or `null` if validation failed.

### Constants

| Constant | Value | Purpose |
|---|---|---|
| `CHARS_PER_TOKEN` | 4 | Token estimation ratio |
| `COMPACTION_TRIGGER_RATIO` | 0.8 | Trigger at 80% of maxTokens |
| `MEMORY_FLUSH_MAX_CHARS` | 30,000 | Max text sent to memory flush LLM call |

---

## Sessions

**File:** `src/session.ts`

Sessions are stored as JSONL (JSON Lines) files in `~/.camelagi/sessions/`.

### File format

Each session file is named `{urlEncodedSessionId}.jsonl`. The file structure:

- **Line 1 (metadata):** A JSON `SessionMeta` object:
  ```json
  { "id": "abc123", "createdAt": 1710300000000, "model": "claude-sonnet-4-20250514", "label": "My Chat" }
  ```
- **Lines 2+N (messages):** One JSON object per message:
  ```json
  { "type": "user", "content": "Hello" }
  { "type": "assistant", "content": "Hi there!" }
  ```

### Type mapping (backward compatibility)

Old LangChain-era type names are mapped on load:

| Stored `type` | Resolved `role` |
|---|---|
| `human` / `user` | `user` |
| `ai` / `assistant` | `assistant` |
| `system` | `system` |
| `tool` | `tool` |

New messages are saved with the current role names (`user`, `assistant`, etc.).

### API

| Function | Behavior |
|---|---|
| `listSessions()` | Reads all `.jsonl` files, parses the first line of each as `SessionMeta`, returns them sorted newest-first by `createdAt`. |
| `loadMessages(sessionId)` | Reads all lines after the metadata line, deserializes each as a `Message` with role mapping. Returns `[]` if file does not exist. |
| `saveMessage(sessionId, message, model, label?)` | Creates the file with a metadata line if it does not exist, then appends the serialized message. Creates the sessions directory if needed. |
| `deleteSession(sessionId)` | Deletes the `.jsonl` file and the associated usage tracking file via `deleteUsage()`. |

---

## Usage Tracking

**File:** `src/usage.ts`

Per-session token accounting, stored both in memory and on disk.

### What is tracked

Each session accumulates a `SessionUsage` record:

| Field | Type | Description |
|---|---|---|
| `totalInput` | `number` | Cumulative input tokens |
| `totalOutput` | `number` | Cumulative output tokens |
| `totalCacheRead` | `number` | Tokens read from prompt cache |
| `totalCacheWrite` | `number` | Tokens written to prompt cache |
| `calls` | `number` | Number of LLM API calls |
| `lastUpdated` | `number` | Timestamp of last update |

### Storage

- **In-memory:** `Map<sessionId, SessionUsage>` for fast lookups.
- **On disk:** `~/.camelagi/usage/{urlEncodedSessionId}.json` -- a single JSON object per session, overwritten on each update.

`getSessionUsage()` checks the in-memory map first, falls back to reading from disk, and returns a zeroed record if neither exists.

### Formatting helpers

| Function | Example output |
|---|---|
| `formatTokens(n)` | `1234` -> `"1.2k"`, `56789` -> `"57k"`, `1234567` -> `"1.2m"` |
| `formatUsageSummary(usage)` | `"45.2k total \| 30.1k in \| 15.1k out \| 8.5k cached"` (cache part omitted if zero) |

---

## Chunker

**File:** `src/chunker.ts`

The `BlockChunker` buffers streamed text and emits sized blocks suitable for Telegram (or any channel with message-length constraints).

### Configuration

| Option | Default | Description |
|---|---|---|
| `minChars` | 800 | Minimum buffer size before attempting a break |
| `maxChars` | 3500 | Hard maximum per chunk |
| `breakPreference` | `"paragraph"` | Preferred break style |
| `onChunk` | (required) | Callback receiving each emitted chunk |

### Break preference cascade

When the buffer exceeds `minChars`, the chunker searches for the **last** occurrence of each break type within the `[minChars, maxChars]` window, in order:

1. **Paragraph** (`\n\n`) -- only if `breakPreference` is `"paragraph"`
2. **Newline** (`\n`)
3. **Sentence** (`[.!?]\s`)
4. **Word** (`\s`)
5. **Hard break** at `maxChars` -- forced if no natural break is found

### Code fence tracking

The chunker tracks whether it is inside a fenced code block by counting `` ``` `` occurrences:

- **Inside a fence and below maxChars:** The chunker holds off on emitting, waiting for the fence to close naturally.
- **Forced break inside a fence:** The chunk gets a closing `` ``` `` appended, and the remainder buffer gets an opening `` ``` `` prepended, so both halves are valid Markdown.
- **Flush with open fence:** A closing `` ``` `` is appended before the final chunk is emitted.

### API

| Method | Purpose |
|---|---|
| `append(text)` | Add text to the buffer; may trigger zero or more `onChunk` calls |
| `flush()` | Emit whatever remains in the buffer (handles open fences) |

---

## Boot Scripts

**File:** `src/boot.ts`

BOOT.md provides a way to run automated tasks every time the gateway starts.

### How it works

1. On gateway launch, `runBoot(config, systemPrompt)` checks for `~/.camelagi/BOOT.md`.
2. If the file does not exist or is empty, returns `{ status: "skipped" }`.
3. Otherwise, the file content is sent as a user message to the agent with these constraints:
   - **Max turns:** 10 (the agent can use tools but is limited to 10 think-act iterations)
   - **Timeout:** 60 seconds
   - **Session:** `"boot"` (a dedicated session so boot history is isolated)
4. The user message (BOOT.md content) and assistant response are persisted to the `boot` session.
5. Returns `{ status: "ran", response }` on success or `{ status: "failed", error }` on error.

### Constraints

| Constraint | Value | Rationale |
|---|---|---|
| Max turns | 10 | Prevent runaway boot scripts |
| Timeout | 60 seconds | Boot should be fast |
| Session ID | `"boot"` | Isolates boot history from user sessions |

---

## Daemon

**File:** `src/daemon.ts`

macOS launchd integration for running the CamelAGI server as a persistent background service.

### Plist generation

The `generatePlist()` function produces a standard macOS property list with:

| Key | Value |
|---|---|
| `Label` | `com.camelagi.server` |
| `ProgramArguments` | `[{nodePath}, {entryPath}, "serve"]` |
| `RunAtLoad` | `true` -- starts on login |
| `KeepAlive` | `true` -- auto-restarts on crash |
| `StandardOutPath` | `~/.camelagi/logs/daemon.stdout.log` |
| `StandardErrorPath` | `~/.camelagi/logs/daemon.stderr.log` |
| `EnvironmentVariables.PATH` | Inherited from the installing shell's `$PATH` |

The plist is written to `~/Library/LaunchAgents/com.camelagi.server.plist`.

Node.js path is resolved via `which node` at install time (falls back to `/usr/local/bin/node`).

### Commands

| Function | Behavior |
|---|---|
| `install()` | Creates the plist file, ensures `~/.camelagi/logs/` exists, runs `launchctl load -w`. If loading fails (already loaded), unloads first and retries. |
| `uninstall()` | Runs `launchctl unload`, then deletes the plist file. No-op if not installed. |
| `status()` | Checks if the plist exists, then greps `launchctl list` for the label. Reports one of: **running** (with PID), **stopped** (with last exit code), or **not loaded/not installed**. |

---

## Doctor

**File:** `src/doctor.ts`

The doctor runs a comprehensive suite of health checks and returns structured results.

### Check format

Each check is a `{ name, status, message }` object where `status` is one of:

- `ok` -- green checkmark
- `warn` -- yellow exclamation
- `error` -- red X

Output is formatted with ANSI color codes for terminal display.

### All checks performed

| # | Check | ok | warn | error |
|---|---|---|---|---|
| 1 | **Config file** | File exists at expected path | Not found ("Run: camelagi setup") | -- |
| 2 | **Config valid** | Parses successfully; shows provider + model | -- | Parse/validation error message |
| 3 | **API key** | Present (shows last 4 chars masked) | -- | No API key configured |
| 4 | **Base URL** | Shows the configured URL | -- | -- |
| 5 | **Model connectivity** | Sends "Say OK" test prompt; shows first 50 chars of response | -- | Connection/auth error message |
| 6 | **Telegram bot(s)** | Calls `getMe` API; shows @username and name. Checks both the main bot token and per-agent bot tokens. | -- | Invalid token or network error |
| 7 | **Thinking** | Shows thinking mode if not "off" | -- | -- |
| 8 | **Workspace** | Directory exists; shows file count | Not found | -- |
| 9 | **Bootstrap files** | All 5 present (AGENTS.md, SOUL.md, USER.md, TOOLS.md, IDENTITY.md) | Lists missing files | -- |
| 10 | **Memory** | memory/ directory exists; shows daily file count | Directory not found | -- |
| 11 | **Sessions** | Shows session count | -- | -- |
| 11b | **Token usage** | Shows tracked session count (only if usage/ dir exists) | -- | -- |
| 12 | **Hooks** | Shows count of `.sh`/`.js` files in hooks/ (only if dir exists) | -- | -- |
| 13 | **Skills** | Shows count of skill subdirectories (only if dir exists) | -- | -- |
| 14 | **Config permissions** | Owner-only (e.g. 0600) | Readable by others; suggests `chmod 600` | -- |
| 15 | **Auth token** | 24+ characters | Short token or no token set | -- |
| 16 | **Bind address** | localhost/127.0.0.1/::1 | Non-localhost bind; suggests reverse proxy + TLS | -- |
| 17 | **State directory** | Owner-only permissions | Accessible by others; suggests `chmod 700` | -- |
| 18 | **Node.js** | Version 20+ | Below 20 | -- |

---

## System Interaction Diagram

```
User message
     |
     v
orchestrate()
     |
     +-- isRunActive? --yes--> queueOrProcess() --> wait --> resolve later
     |
     +-- acquireLane(Main) ----------> [blocks if lane full]
     |
     +-- setActiveRun()
     |
     +-- loadMessages() + compactHistory()
     |         |
     |         +-- estimateTokens() >= 80% maxTokens?
     |         |       |
     |         |       +-- memoryFlush() --> agent or global memory/{date}.md
     |         |       +-- chatDirect()  --> summary
     |         |       +-- return [summary, ...recentTurns]
     |         |
     |         +-- no --> return null
     |
     +-- withRetry( runAgent(...) )
     |         |
     |         +-- on rate_limit/server_error/timeout --> min(backoff * 2^attempt, 30s) --> retry
     |         +-- on overflow --> onCompact() --> retry once
     |         +-- on auth/billing/format/abort --> throw
     |
     +-- saveMessage(user) + saveMessage(assistant)
     |
     +-- finally: clearActiveRun() + release()
     |         |
     |         +-- drainQueue(sessionId)
     |               |
     |               +-- queued[0] --> orchestrate() --> resolve promise
     |               +-- queued[1..n] --> reject("Superseded")
     |
     v
OrchestrateResult
```
