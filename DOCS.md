# CamelAGI Documentation

> Personal AI assistant platform — run your own AI agents with Telegram, CLI, TUI, and REST API.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Claude Code via Telegram](#claude-code-via-telegram)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Agent System](#agent-system)
- [Gateway Server](#gateway-server)
- [Telegram Bots](#telegram-bots)
- [Pairing & OTP](#pairing--otp)
- [CLI Commands](#cli-commands)
- [TUI (Terminal UI)](#tui-terminal-ui)
- [Tools](#tools)
- [Memory System](#memory-system)
- [Context Compaction](#context-compaction)
- [Cron Jobs](#cron-jobs)
- [Skills](#skills)
- [Hooks](#hooks)
- [Approvals](#approvals)
- [Sessions](#sessions)
- [Concurrency Lanes](#concurrency-lanes)
- [Retry & Error Handling](#retry--error-handling)
- [Boot Scripts](#boot-scripts)
- [Daemon (macOS)](#daemon-macos)
- [Doctor](#doctor)
- [Environment Variables](#environment-variables)

---

## Quick Start

```bash
# One-command setup: creates config + starts server
camelagi bootstrap

# Or manual setup
camelagi setup          # Interactive config wizard
camelagi serve          # Start the gateway

# Chat
camelagi chat           # TUI chat
camelagi "hello world"  # One-shot message
```

After bootstrap, the admin Telegram bot is live. Message it to start the pairing flow.

---

## Claude Code via Telegram

Run Claude Code on your local machine, remote-controlled from Telegram. CamelAGI spawns the `claude` CLI as a subprocess and bridges messages between Telegram and your local machine.

### Prerequisites

- Claude Code installed: `npm i -g @anthropic-ai/claude-code`
- Logged in: `claude login`

### Using `/claudecode`

In any agent bot, type `/claudecode` to open the control menu:

| Action | Description |
|--------|-------------|
| **Start** | Begin a new Claude Code session |
| **Stop** | End the active session |
| **New Session** | Start fresh (clear session history) |
| **Sessions** | List and resume previous sessions |
| **Model** | Switch between Sonnet, Opus, Haiku |
| **Work Dir** | Browse and select working directory |

Once started, every message you send goes directly to Claude Code.

### Per-Agent Mode

Create an agent that always uses Claude Code:

```yaml
agents:
  coder:
    name: "Coder"
    mode: claude-code
    workDir: ~/projects/my-app
    telegram:
      botToken: "YOUR_BOT_TOKEN"
      allowedUsers: [YOUR_TELEGRAM_ID]
```

Or use `/newagent` in Telegram and select "Claude Code (local CLI)" as the mode.

### Directory Browser

The `/workdir` command opens an interactive file browser in Telegram using inline buttons. Navigate folders, go back, and select — no typing paths.

### How It Works

1. Message arrives on Telegram
2. CamelAGI spawns: `claude -p "message" --output-format stream-json --resume <session_id>`
3. Claude Code runs locally with full filesystem access
4. Response streams back to Telegram via DraftStream (real-time edits)
5. Session ID stored for conversation persistence

---

## Architecture

CamelAGI is a gateway-first AI assistant. All execution flows through a single Express + WebSocket server.

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Telegram    │  │    TUI      │  │  REST/WS    │
│  (grammY)    │  │  (pi-tui)   │  │  clients    │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       └────────────┬────┴────────────────┘
                    │
            ┌───────▼────────┐
            │    Gateway     │
            │  Express + WS  │
            │  Config reload │
            │  Rate limiting │
            └───────┬────────┘
                    │
            ┌───────▼────────┐
            │  Orchestrator  │
            │  Queue + Lanes │
            │  Session mgmt  │
            └───────┬────────┘
                    │
            ┌───────▼────────┐
            │   Agent Loop   │
            │  Claude SDK or │
            │  OpenAI compat │
            └───────┬────────┘
                    │
            ┌───────▼────────┐
            │   AI Provider  │
            │  Anthropic     │
            │  OpenAI        │
            │  OpenRouter    │
            │  Ollama        │
            │  Custom        │
            └────────────────┘
```

**Key design decisions:**
- Single process, single config file, no database
- Sessions stored as JSONL files
- Config hot-reload via filesystem watcher
- Dual agent path: Claude Agent SDK (native tools, thinking, subagents) or OpenAI-compatible streaming

---

## Configuration

All config lives in `~/.camelagi/config.yaml`. Changes are hot-reloaded without restart.

### Full Schema

```yaml
# ── Provider ──────────────────────────────────────
provider: "anthropic"        # anthropic | openai
model: "claude-sonnet-4-20250514"
apiKey: "sk-ant-..."         # or set via env var
baseUrl: ""                  # custom OpenAI-compatible endpoint

# ── Agent Defaults ────────────────────────────────
systemPrompt: "You are CamelAGI, a helpful AI assistant..."
thinking: "off"              # off | low | medium | high
effort: "high"               # low | medium | high | max
maxTurns: 25                 # max tool-use turns per request
timeoutSeconds: 300          # per-request timeout
maxBudgetUsd: ~              # optional spending cap

# ── Gateway Server ────────────────────────────────
serve:
  port: 18789
  host: "127.0.0.1"
  token: ""                  # bearer token for API auth
  rateLimit:
    windowMs: 60000          # sliding window
    max: 60                  # max requests per window

# ── Telegram (legacy single bot) ──────────────────
telegram:
  botToken: ""
  allowedUsers: []           # Telegram user IDs
  groups:
    mentionOnly: true
  chats: {}                  # per-chat overrides (model, prompt, etc.)

# ── Named Agents ──────────────────────────────────
agents:
  admin:
    name: "Admin"
    admin: true              # admin bot (BotFather-style commands)
    model: ""                # override default model
    systemPrompt: ""         # override default prompt
    thinking: "off"
    effort: "high"
    maxTurns: 25
    telegram:
      botToken: "123:ABC"
      allowedUsers: []
      groups:
        mentionOnly: true

  mybot:
    name: "My Bot"
    telegram:
      botToken: "456:DEF"
      allowedUsers: [123456]

# ── Context Compaction ────────────────────────────
compaction:
  enabled: true
  maxTokens: 80000           # trigger compaction at 80% of this
  keepTurns: 6               # keep last N turns verbatim

# ── Tool Filtering ────────────────────────────────
tools:
  allow: []                  # if set, ONLY these tools are available
  deny: []                   # never allow these tools

# ── Skills ────────────────────────────────────────
skills:
  enabled: true
  deny: []                   # skill names to exclude

# ── Hooks ─────────────────────────────────────────
hooks:
  enabled: false

# ── Approvals ─────────────────────────────────────
approvals:
  mode: "off"                # off | smart | always
  allowlist: []              # pre-approved tool patterns
  timeoutSeconds: 120
  fallback: "deny"           # deny | allow (on timeout)
  forwardTo: ~               # Telegram chat ID for headless approval

# ── Retry ─────────────────────────────────────────
retry:
  maxRetries: 3
  backoffMs: 1000            # exponential backoff base

# ── Concurrency Lanes ────────────────────────────
lanes:
  main: 3                    # concurrent chat requests
  cron: 1                    # concurrent cron jobs
  subagent: 5                # concurrent subagents

# ── Boot Script ───────────────────────────────────
boot: true                   # run BOOT.md on startup

# ── Cron Jobs ─────────────────────────────────────
cron:
  - id: "daily-summary"
    name: "Daily Summary"
    schedule: "1d"           # 5m, 1h, 1d, */5 * * * *, +20m, ISO
    prompt: "Summarize today's activity"
    session: "cron-daily"    # optional fixed session
    enabled: true
```

### Config Precedence

1. YAML file (`~/.camelagi/config.yaml`)
2. Environment variables (override file values)
3. Runtime overrides (per-chat model switching)

---

## Agent System

The agent runs a think-act loop: receive message → call tools → return response.

### Dual Execution Path

| Feature | Claude SDK Path | OpenAI-Compatible Path |
|---------|----------------|----------------------|
| Provider | Anthropic (no custom baseUrl) | Any OpenAI-compatible |
| Streaming | Native events | SSE stream parsing |
| Tools | SDK `tool()` definitions via MCP | OpenAI function-calling with tool loop |
| Tool Hooks | `before_tool` / `after_tool` hooks | `before_tool` / `after_tool` hooks |
| Thinking | Extended thinking (low/med/high) | Not supported |
| Subagents | Native spawning | Not supported |
| Approvals | Inline approval hooks | Not supported |

The path is auto-selected based on model name (`claude-*` prefix) and whether a custom `baseUrl` is set.

### Agent Events

Events emitted during execution:

| Event | Description |
|-------|-------------|
| `stream_text` | Incremental text from the model |
| `chunk` | Full text so far (for draft display) |
| `tool_call` | Tool invocation started |
| `tool_result` | Tool execution completed |
| `thinking` | Extended thinking start/end |
| `subagent_start` | Subagent spawned |
| `subagent_end` | Subagent completed |
| `approval_request` | Tool needs user approval |
| `error` | Error occurred |
| `done` | Run completed |

---

## Gateway Server

Express + WebSocket server at `http://127.0.0.1:18789`.

### REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (uptime, runs, lanes, sessions) |
| `POST` | `/chat` | Send message (`{ message, session?, model? }`) |
| `GET` | `/sessions` | List all sessions |
| `GET` | `/sessions/:id/messages` | Get session messages |
| `DELETE` | `/sessions/:id` | Delete session |
| `GET` | `/config` | Get current config (keys redacted) |
| `PATCH` | `/config` | Update config fields |
| `GET` | `/agents` | List agents with Telegram status |
| `POST` | `/agents` | Create agent |
| `DELETE` | `/agents/:id` | Delete agent |
| `GET` | `/agents/:id/soul` | Read agent SOUL.md |
| `PUT` | `/agents/:id/soul` | Write agent SOUL.md |
| `GET` | `/pairing` | List pending pairing requests |
| `POST` | `/pairing/:code/approve` | Approve pairing (returns OTP) |
| `POST` | `/pairing/:code/deny` | Deny pairing request |
| `GET` | `/bot-approvals` | List pending bot approvals |
| `POST` | `/bot-approvals/:id/approve` | Approve bot creation |
| `POST` | `/bot-approvals/:id/deny` | Deny bot creation |

### WebSocket

Connect to `ws://127.0.0.1:18789` with optional `?token=` query param.

**Client → Server messages:**

```json
{ "type": "chat", "message": "hello", "session": "optional-id" }
{ "type": "abort" }
{ "type": "model.switch", "model": "gpt-4o" }
{ "type": "compact" }
```

**Server → Client events:** Same as [Agent Events](#agent-events), sent as JSON.

### Security

- **Auth token**: Optional bearer token via `serve.token` config
- **Rate limiting**: Sliding window (default 60 req/min), `Retry-After` header on 429
- **Body size limit**: 1 MB max JSON request body
- **CSRF protection**: Origin/referer validation
- **Timing-safe comparison**: Token checks use SHA-256 + `timingSafeEqual`

---

## Telegram Bots

CamelAGI supports multiple Telegram bots — one admin bot for management, plus unlimited agent bots for AI chat.

### Admin Bot

The admin bot is a BotFather-style control plane. It manages agents, config, sessions, and access control.

**Commands:**

| Command | Description |
|---------|-------------|
| `/start` | Welcome + status overview |
| `/help` | List all commands |
| `/setup` | Configure API provider, key, model (wizard) |
| `/newagent` | Create a new agent bot (wizard) |
| `/agents` | List all agents + running status |
| `/deleteagent` | Delete an agent |
| `/soul` | View/edit agent personality (SOUL.md) |
| `/config` | View config or update (`/config model gpt-4o`) |
| `/sessions` | List sessions with bulk delete |
| `/status` | System health: bots, sessions, config |
| `/restart` | Restart agent bots (`/restart` all or `/restart <id>`) |
| `/pairing` | List pending access requests with approve/deny buttons |
| `/cancel` | Cancel active wizard |

### Agent Bot

Each agent bot handles AI chat with its own personality, model, and session.

**Commands:**

| Command | Description |
|---------|-------------|
| `/start` | Introduction |
| `/help` | Commands + current config |
| `/clear` | Clear chat history |
| `/status` | Model, messages, token usage |
| `/model <name>` | Switch model (runtime, resets on clear) |
| `/compact` | Force context compaction |

**Features:**
- Streaming responses with live message editing
- Group support (mention-only mode: `@botname message`)
- Inline approval buttons for tool calls
- Queued messages while agent is processing
- Reactions for status: eyes → thinking → wrench (tool) → done

### Per-Agent Config

Each agent can override the global defaults:

```yaml
agents:
  researcher:
    name: "Research Bot"
    model: "claude-opus-4-20250514"
    systemPrompt: "You are a research assistant..."
    thinking: "high"
    effort: "max"
    maxTurns: 50
    telegram:
      botToken: "123:ABC"
      allowedUsers: [111, 222]
      groups:
        mentionOnly: true
```

---

## Pairing & OTP

Secure access control for Telegram bots. Unauthorized users must be approved before they can chat.

### Flow

```
1. User messages bot
   ↓
2. Bot: "Access requested. Code: SDH33B"
   ↓
3. Admin approves (Camel app, CLI, or admin bot /pairing)
   ↓
4. OTP generated (5-digit code, expires in 5 minutes)
   ↓
5. Bot tells user: "Enter the 5-digit verification code"
   ↓
6. User enters OTP in bot chat
   ↓
7. User added to allowedUsers in config (persisted)
   ↓
8. All future messages: authorized instantly
```

### Approval Methods

| Method | How |
|--------|-----|
| **Camel app** | Pairing card in dashboard, tap Approve |
| **CLI** | `camelagi pairing` — interactive approve/deny |
| **Admin bot** | `/pairing` — inline buttons |
| **REST API** | `POST /pairing/:code/approve` |

### Security Details

- Pairing codes: 6 characters (A-Z, 2-9, no O/0/I/1 ambiguity)
- OTP: 5-digit number, 5-minute TTL
- Max 5 OTP attempts before lockout
- Pairing requests expire after 1 hour
- Max 10 pending requests at a time
- User IDs persisted to config.yaml `allowedUsers` array

---

## CLI Commands

```
camelagi <command> [options]
```

All commands support `--help` / `-h` for per-command usage information.

| Command | Description |
|---------|-------------|
| `bootstrap [token]` | One-command setup: config + server |
| `serve [--port N]` | Start gateway server |
| `chat [--session id]` | Interactive TUI chat |
| `"message"` | One-shot message (starts ephemeral server) |
| `setup` | Interactive config wizard |
| `config` | View config (`config list`, `config get key`, `config set key value`) |
| `agents` | List agents (`agents`, `agents rm <id> [--yes]`) |
| `soul [id]` | View/edit SOUL.md in $EDITOR |
| `sessions` | List sessions (`sessions`, `sessions rm <id> [--yes]`) |
| `pairing` | Approve/deny pending pairing requests |
| `cron` | Manage cron jobs (`cron list`, `cron add`, `cron rm <id>`, `cron run <id>`) |
| `logs [-n N]` | Tail server request logs |
| `doctor` | Run health checks |
| `daemon` | macOS launchd service (`daemon install`, `daemon uninstall`, `daemon status`) |
| `reset [--confirm]` | Delete all data in ~/.camelagi |

### Input Validation

- **Port numbers** (`serve --port`): Must be a number between 1 and 65535
- **Log lines** (`logs -n`): Must be a positive number (>= 1)
- **Cron schedules** (`cron add --schedule`): Validated against supported formats (duration, cron expression, one-shot, ISO timestamp)
- **Config keys** (`config set`): Only existing top-level keys are accepted
- **Destructive operations** (`agents rm`, `sessions rm`): Prompt for confirmation (skip with `--yes` / `-y`)
- **Unknown subcommands** (`agents blah`, `sessions blah`): Show error instead of silently falling through

---

## TUI (Terminal UI)

Full-featured terminal chat client built with pi-tui. Connects to the gateway via WebSocket.

### Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/model [name]` | Switch model (opens selector if no name) |
| `/config` | Show current config |
| `/sessions` | List sessions |
| `/session <id>` | Switch to session |
| `/new` | Start new session |
| `/clear` | Clear chat history |
| `/tools` | Toggle tool output expand/collapse |
| `/skills` | List active skills |
| `/think [level]` | Set thinking level (off/low/medium/high) |
| `/context` | Show context breakdown (sizes, tokens) |
| `/status` | Session status (model, messages, usage) |
| `/compact` | Force context compaction |
| `/agents` | List agents (`/agents add` to create, `/agents rm <id>`) |
| `/soul [id]` | View agent SOUL.md (`/soul <id> edit` to edit) |
| `/setup` | Run setup wizard |
| `/exit` | Quit |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+L` | Open model selector |
| `Ctrl+P` | Open session selector |
| `Ctrl+O` | Toggle tool output |
| `Escape` | Abort current request |
| `Ctrl+C` | Clear input (double-tap to exit) |
| `Ctrl+D` | Exit |

### Shell Commands

Prefix with `!` to run shell commands directly:

```
!ls -la
!git status
```

---

## Tools

The agent has access to these tools (filterable via `tools.allow` / `tools.deny`):

### Built-in (Claude Agent SDK)

| Tool | Description |
|------|-------------|
| `Read` | Read files with line numbers |
| `Write` | Create or overwrite files |
| `Edit` | Targeted string replacement in files |
| `Bash` | Run shell commands (30s timeout) |
| `Glob` | Find files by pattern |
| `Grep` | Search file contents with regex |
| `WebSearch` | Web search |
| `WebFetch` | HTTP requests (GET, POST, PUT, DELETE) |

### Custom Tools

| Tool | Description |
|------|-------------|
| `apply_patch` | Multi-file patch tool (custom diff format) |
| `memory_search` | Search memory files by keyword |
| `memory_get` | Read a specific memory file |
| `cron` | Manage scheduled tasks (list, add, remove, run) |
| `subagent` | Spawn a child agent (Claude SDK only) |

### Tool Filtering

```yaml
tools:
  allow: ["Read", "Bash"]    # only these tools available
  deny: ["Write", "Edit"]    # these tools blocked
```

If `allow` is set, it acts as a whitelist. `deny` always takes precedence.

---

## Memory System

Two-tier memory: curated MEMORY.md + daily notes.

### Workspace Structure

```
~/.camelagi/workspace/
  AGENTS.md     # Agent instructions
  SOUL.md       # Personality & boundaries
  IDENTITY.md   # Identity context
  USER.md       # User info
  TOOLS.md      # Tool usage notes
  MEMORY.md     # Curated long-term memory
  memory/       # Daily notes
    2026-03-13.md
    2026-03-12.md
```

### Per-Agent Memory

Each agent gets its own workspace:

```
~/.camelagi/agents/<agent-id>/
  SOUL.md
  MEMORY.md
  TOOLS.md
  memory/
    2026-03-13.md
```

### Memory Tools

**`memory_search`** — Search across MEMORY.md and all memory/*.md files
- Keyword scoring with snippet extraction
- Returns top N results ranked by relevance
- Scoped to the active agent's workspace

**`memory_get`** — Read a specific memory file by name

### Bootstrap Files

These files are injected into the system prompt:

| File | Purpose | Max Size |
|------|---------|----------|
| AGENTS.md | Agent instructions and behavior rules | 20K chars |
| SOUL.md | Personality, tone, boundaries | 20K chars |
| IDENTITY.md | Who the agent is | 20K chars |
| USER.md | Who the user is | 20K chars |
| TOOLS.md | Tool usage guidelines | 20K chars |
| MEMORY.md | Curated facts and context | 20K chars |

Total bootstrap limit: 150K characters. Files are truncated (70% head + 20% tail) if they exceed individual limits.

---

## Context Compaction

Automatic context management to prevent token overflow.

### How It Works

1. **Trigger**: When context exceeds 80% of `compaction.maxTokens`
2. **Split**: Separate history into old messages + last N turns (default 6)
3. **Memory flush**: Extract durable facts from old messages and write to memory
4. **Summarize**: Compress old messages into a concise summary
5. **Validate**: Verify the compacted result is actually smaller than the original (skip with warning if not)
6. **Replace**: New history = summary + recent turns

### Config

```yaml
compaction:
  enabled: true
  maxTokens: 80000    # trigger at 80% = 64K tokens
  keepTurns: 6        # keep last 6 turns verbatim
```

### Manual Trigger

- TUI: `/compact`
- Telegram: `/compact`
- WebSocket: `{ "type": "compact" }`

---

## Cron Jobs

Scheduled AI tasks that run automatically.

### Two Sources

1. **Config-defined**: In `config.yaml` (read-only at runtime)
2. **Runtime-defined**: Created via CLI or agent tool (stored in `~/.camelagi/cron/jobs.json`)

### Schedule Formats

| Format | Example | Description |
|--------|---------|-------------|
| Duration | `5m`, `1h`, `1d` | Repeat every N minutes/hours/days |
| Cron expression | `*/5 * * * *` | Standard 5-field cron |
| One-shot delay | `+20m` | Run once after 20 minutes |
| ISO timestamp | `2026-03-15T09:00:00Z` | Run once at specific time |

### Config Example

```yaml
cron:
  - id: "morning-brief"
    name: "Morning Briefing"
    schedule: "1d"
    prompt: "Check my calendar and summarize today's priorities"
    session: "cron-morning"
    enabled: true
```

### CLI

```bash
camelagi cron list          # list all jobs
camelagi cron add           # interactive job creation
camelagi cron rm <id>       # remove a job
camelagi cron run <id>      # run immediately
```

### Error Handling

Failed jobs use exponential backoff: 30s → 1m → 5m → 15m → 60m. Backoff resets on success.

---

## Skills

Loadable prompt extensions from `~/.camelagi/skills/`.

### Structure

```
~/.camelagi/skills/
  code-review/
    SKILL.md
  writing/
    SKILL.md
```

### SKILL.md Format

```markdown
---
name: code-review
description: Expert code reviewer
---

When asked to review code:
1. Check for bugs and edge cases
2. Evaluate performance implications
3. Suggest improvements with examples
```

Skills are injected into the system prompt (up to 30K total). Disable specific skills:

```yaml
skills:
  enabled: true
  deny: ["code-review"]
```

---

## Hooks

Shell scripts that run at lifecycle points.

### Setup

```yaml
hooks:
  enabled: true
```

Place scripts in `~/.camelagi/hooks/`:

```
~/.camelagi/hooks/
  before_prompt.log.sh
  after_response.notify.sh
  before_tool.check.sh
  after_tool.audit.sh
```

### Hook Points

| Point | When | Context |
|-------|------|---------|
| `before_prompt` | User message about to be sent | `CAMELAGI_HOOK_MESSAGE` |
| `after_response` | Agent response ready | `CAMELAGI_HOOK_RESPONSE` |
| `before_tool` | Tool call about to execute | `CAMELAGI_HOOK_TOOL_NAME`, `CAMELAGI_HOOK_TOOL_ARGS` |
| `after_tool` | Tool execution completed | `CAMELAGI_HOOK_TOOL_NAME`, `CAMELAGI_HOOK_TOOL_RESULT` |

### Environment Variables

All hooks receive:
- `CAMELAGI_HOOK_POINT` — which hook point
- `CAMELAGI_HOOK_SESSION` — current session ID

Scripts have a 10-second timeout. Stderr is captured (max 10K chars).

---

## Approvals

Gate dangerous tool calls behind user confirmation.

### Modes

| Mode | Behavior |
|------|----------|
| `off` | No approval checks (default) |
| `smart` | Auto-approve reads (Read, Glob, Grep, WebSearch, WebFetch, memory tools). Ask for writes and exec. |
| `always` | Ask for every tool call |

### Allowlist

Pre-approve specific tools or patterns:

```yaml
approvals:
  mode: "smart"
  allowlist:
    - "Read"              # always allow Read
    - "Bash:git *"        # allow git commands
    - "Write:/tmp/*"      # allow writes to /tmp
    - "apply_patch:*"     # allow all patches
```

### Approval Channels

| Channel | How approvals work |
|---------|-------------------|
| TUI | Inline prompt in terminal |
| Telegram | Inline buttons (Allow / Always / Deny) |
| REST/headless | Forward to Telegram via `approvals.forwardTo` chat ID |

### Timeout

If no decision within `timeoutSeconds` (default 120), the `fallback` action applies (`deny` or `allow`).

---

## Sessions

Chat sessions stored as JSONL files in `~/.camelagi/sessions/`.

### Format

```
Line 1: {"id":"session-123","createdAt":1710000000000,"model":"claude-sonnet-4","label":"My Chat"}
Line 2: {"role":"user","content":"Hello"}
Line 3: {"role":"assistant","content":"Hi there!"}
...
```

### Management

```bash
camelagi sessions          # list all
camelagi sessions rm <id>  # delete one
```

TUI: `/sessions`, `/session <id>`, `/new`, `/clear`

Telegram: `/clear` (per-chat), admin `/sessions`

### Usage Tracking

Per-session token accounting stored in `~/.camelagi/usage/<session-id>.json`:
- Input tokens, output tokens
- Cache read/write tokens
- Call count, last updated

---

## Concurrency Lanes

Control how many operations run simultaneously.

```yaml
lanes:
  main: 3       # concurrent chat requests
  cron: 1       # concurrent cron jobs
  subagent: 5   # concurrent subagents
```

Requests that exceed the lane limit are queued (FIFO) until a slot opens.

---

## Retry & Error Handling

Automatic retry with exponential backoff for transient errors.

### Error Classification

Errors are classified using a two-tier approach: HTTP status codes (from SDK error objects) are checked first for reliable classification, then string matching as a fallback.

| Type | HTTP Code | Action |
|------|-----------|--------|
| `rate_limit` | 429 | Retry with capped backoff |
| `server_error` | 500, 502, 503 | Retry with capped backoff |
| `timeout` | 408, deadline exceeded | Retry with capped backoff |
| `overflow` | Context too large | Compact + retry once |
| `auth` | 401, 403 | Fail immediately |
| `billing` | 402 | Fail immediately |
| `format` | 400, 422 | Fail immediately |
| `abort` | User cancelled (exact match) | Fail immediately |

### Config

```yaml
retry:
  maxRetries: 3
  backoffMs: 1000    # exponential with 30s cap: 1s, 2s, 4s, 8s... max 30s
```

---

## Boot Scripts

Run a prompt on gateway startup.

### Setup

1. Create `~/.camelagi/workspace/BOOT.md` with your startup prompt
2. Set `boot: true` in config (default)

```markdown
Check if any cron jobs failed overnight and send a summary to Telegram.
```

Boot runs with 10 max turns, 60-second timeout, saved to session `boot`.

---

## Daemon (macOS)

Run CamelAGI as a background service via launchd.

```bash
camelagi daemon install     # create plist + start
camelagi daemon uninstall   # stop + remove plist
camelagi daemon status      # check if running
```

Plist location: `~/Library/LaunchAgents/com.camelagi.server.plist`

Logs: `~/.camelagi/logs/daemon.stdout.log`, `daemon.stderr.log`

Auto-restarts on crash (KeepAlive: true).

---

## Doctor

Run health checks to diagnose issues.

```bash
camelagi doctor
```

Checks:
1. Config file exists and is valid
2. API key is set
3. Base URL is reachable (if custom)
4. Model connectivity (test chat call)
5. Telegram bot tokens (getMe check)
6. Sessions directory
7. Workspace directory
8. Usage tracking

---

## Environment Variables

| Variable | Overrides | Description |
|----------|-----------|-------------|
| `ANTHROPIC_API_KEY` | `apiKey` | Anthropic API key |
| `OPENAI_API_KEY` | `apiKey` | OpenAI API key (if no Anthropic key) |
| `CAMELAGI_PROVIDER` | `provider` | Provider override |
| `CAMELAGI_MODEL` | `model` | Model override |
| `CAMELAGI_BASE_URL` | `baseUrl` | Custom API endpoint |
| `CAMELAGI_TOKEN` | `serve.token` | Gateway auth token |
| `TELEGRAM_BOT_TOKEN` | `telegram.botToken` | Legacy bot token |

Environment variables take precedence over config file values.

---

## File Structure

```
~/.camelagi/
  config.yaml              # main config
  pairing.json             # pending pairing requests
  sessions/                # JSONL session files
  usage/                   # per-session token usage
  workspace/               # global bootstrap files
    AGENTS.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md, MEMORY.md
    memory/                # daily memory notes
  agents/                  # per-agent workspaces
    <agent-id>/
      SOUL.md, MEMORY.md, TOOLS.md
      memory/
  hooks/                   # lifecycle hook scripts
  skills/                  # skill definitions
  cron/                    # runtime cron job state
  logs/                    # request logs, daemon logs
```
