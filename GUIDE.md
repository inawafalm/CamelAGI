# CamelAGI — Developer Guide

> Personal AI assistant with TUI, gateway server, Telegram bots, admin control plane, and cron jobs.
> Built on the Claude Agent SDK + OpenAI-compatible fallback for multi-provider support.

## Quick Start

```bash
# Install dependencies
npm install

# First-time setup via Telegram admin bot (recommended)
npx tsx src/cli.ts bootstrap

# Or: interactive CLI setup
npx tsx src/cli.ts setup

# Start chatting
npx tsx src/cli.ts chat

# One-shot mode
npx tsx src/cli.ts "What files are in this directory?"

# Start the gateway server
npx tsx src/cli.ts serve
```

### Bootstrap (Telegram-first setup)

The fastest way to get started:

1. Create a bot in Telegram via [@BotFather](https://t.me/BotFather)
2. Run `camelagi bootstrap` and paste the token
3. Send `/start` to your bot — it locks to your account
4. Use `/setup` in Telegram to configure your API provider and key
5. Use `/newagent` to create AI agents — all from Telegram

## CLI Commands

| Command | Description |
|---------|-------------|
| `camelagi bootstrap` | First-time setup via Telegram admin bot |
| `camelagi bootstrap <token>` | Non-interactive bootstrap |
| `camelagi chat` | Interactive TUI session |
| `camelagi chat --session <name>` | Resume a named session |
| `camelagi "message"` | One-shot mode (prints response and exits) |
| `camelagi serve` | Start gateway server (HTTP + WebSocket + Telegram) |
| `camelagi serve --port 3000` | Custom port |
| `camelagi sessions` | List saved sessions |
| `camelagi sessions rm <name>` | Delete a session |
| `camelagi agents` | List configured agents |
| `camelagi agents rm <id>` | Remove an agent |
| `camelagi soul <id>` | Edit agent's SOUL.md in $EDITOR |
| `camelagi cron` | List all cron jobs (config + runtime) |
| `camelagi cron add` | Add a runtime cron job |
| `camelagi cron rm <id>` | Remove a runtime cron job |
| `camelagi cron run <id>` | Trigger a cron job immediately |
| `camelagi setup` | Interactive setup wizard |
| `camelagi doctor` | Health checks |
| `camelagi daemon install` | Install as launchd daemon (auto-start on boot) |
| `camelagi daemon uninstall` | Remove launchd daemon |
| `camelagi daemon status` | Check daemon status |
| `camelagi logs` | Tail server request log |
| `camelagi logs -n 100` | Show last N log lines |
| `camelagi config list` | Show all config |
| `camelagi config get <key>` | Get a config value |
| `camelagi config set <key> <val>` | Set a config value |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                         CLI (cli.ts)                     │
│  Parses args → routes to: bootstrap, chat, serve, setup, │
│  doctor, sessions, agents, soul, config, or one-shot     │
└───────┬────────────┬────────────────┬────────────────────┘
        │            │                │
        ▼            ▼                ▼
┌──────────┐  ┌────────────┐  ┌──────────────┐
│   TUI    │  │  One-Shot   │  │  Standalone  │
│ (tui.ts) │  │  (cli.ts)   │  │   Gateway    │
│   ▲      │  │             │  │  (serve.ts)  │
│   │ WS   │  │  HTTP POST  │  │   ▲     ▲    │
│   ▼      │  │             │  │   │     │    │
│ Embedded │  │  Embedded   │  │   │     │    │
│ Gateway  │  │  Gateway    │  │   │     │    │
└────┬─────┘  └──────┬──────┘  └───┼─────┼────┘
     │               │             │     │
     └───────┬───────┘             │     │
             ▼                     │     │
┌─────────────────────────┐        │     │
│   Gateway Server        │◄───────┘     │
│   (serve.ts)            │              │
│                         │   ┌──────────┘
│  Express HTTP:          │   │
│   POST /chat            │   │  WebSocket:
│   GET  /sessions        │   │   { type: "chat" }
│   GET  /health          │   │   { type: "abort" }
│   CRUD /agents          │   │   { type: "switch_session" }
│   /approvals/:id/decide │   │
│                         │   │
│  Channels:              │
│   Telegram (grammY)     │
│   Discord (discord.js)  │
│   + pluggable adapters  │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│                   Agent (agent.ts)                    │
│                                                      │
│  ┌─────────────────────┐  ┌───────────────────────┐ │
│  │  Claude Agent SDK   │  │  OpenAI-Compatible    │ │
│  │  (Claude models)    │  │  (All other models)   │ │
│  │                     │  │                       │ │
│  │  • Built-in tools   │  │  • Streaming chat     │ │
│  │  • MCP server       │  │  • OpenAI SDK         │ │
│  │  • Thinking         │  │  • Any provider       │ │
│  │  • Subagents        │  │                       │ │
│  │  • Session resume   │  │                       │ │
│  │  • Hooks            │  │                       │ │
│  └─────────────────────┘  └───────────────────────┘ │
└──────────┬──────────────────────────────────────────┘
           │
     ┌─────┼──────────┬───────────┬──────────┐
     ▼     ▼          ▼           ▼          ▼
┌────────┐┌────────┐┌──────────┐┌─────────┐┌────────┐
│Sessions││Compact ││  Memory  ││  Hooks  ││ Skills │
│  .jsonl││  LLM   ││  search  ││  shell  ││  .md   │
│  files ││summary ││ keyword  ││ scripts ││prompts │
└────────┘└────────┘└──────────┘└─────────┘└────────┘
```

### Dual-Path Agent

The agent routes execution based on the model:

- **Claude models** (`claude-*`) → Claude Agent SDK with full tool support, thinking, subagents, session resume, and MCP server
- **All other models** (GPT, DeepSeek, Ollama, etc.) → OpenAI-compatible streaming chat via the `openai` SDK

Detection: `model.startsWith("claude-") || model.includes("/claude-")`

### Data Flow (TUI Chat)

```
User types message
      │
      ▼
TUI sends WS: { type: "chat", message, session, sdkSessionId }
      │
      ▼
Gateway receives → loads history → compacts if needed → retries
      │
      ▼
Agent runs (SDK or OpenAI path)
      │
      ▼
Events stream back: tool_call, tool_result, stream_text,
                     thinking, subagent_start, usage, chunk
      │
      ▼
Gateway sends WS events → TUI renders in real-time
      │
      ▼
Final result saved to session (JSONL)
```

## Project Structure

```
src/
├── cli.ts              # Entry point — command routing
├── agent.ts            # Dual-path agent (SDK + OpenAI)
├── serve.ts            # Express + WebSocket gateway
├── daemon.ts           # launchd daemon install/uninstall/status
├── config.ts           # YAML config + Zod schema
├── session.ts          # JSONL session persistence
├── workspace.ts        # Bootstrap files + system prompt
├── compact.ts          # Context compaction + memory flush
├── model.ts            # Anthropic SDK client (direct API)
├── retry.ts            # Error classification + retry logic
├── runs.ts             # Active run tracking (by runId)
├── queue.ts            # Message queue for concurrent requests
├── lanes.ts            # Concurrency lanes (main/cron/subagent)
├── hooks.ts            # Lifecycle hooks (~/.camelagi/hooks/)
├── skills.ts           # Skill loader (~/.camelagi/skills/)
├── usage.ts            # Token usage tracking
├── constants.ts        # Shared constants (no magic numbers)
├── errors.ts           # Error helpers
├── chunker.ts          # Block-aware text chunker
├── telegram.ts         # Telegram bots via grammY (multi-agent)
├── channels/
│   ├── types.ts        # Channel interface
│   ├── adapter.ts      # ChannelAdapter interface + RuntimeState
│   ├── handler.ts      # Shared command handling + streaming + chunking
│   ├── registry.ts     # Channel registry (start/stop/reconcile)
│   ├── index.ts        # Lazy channel loader
│   ├── telegram.ts     # TelegramChannel wrapper
│   └── discord.ts      # Discord channel (discord.js)
├── bootstrap.ts        # First-time setup (token → admin bot)
├── approvals.ts        # Tool approval engine
├── approval-forward.ts # Headless approval forwarding
├── boot.ts             # BOOT.md startup script
├── cron.ts             # Scheduled agent runs
├── doctor.ts           # Health checks
├── setup.ts            # Interactive setup wizard
├── policy.ts           # Tool allow/deny filtering
├── types.ts            # Shared types
├── gateway/
│   ├── routes.ts       # REST API endpoints
│   ├── state.ts        # Shared gateway state + auth
│   ├── ws-handler.ts   # WebSocket message dispatch
│   ├── logger.ts       # JSON-line request logger
│   ├── rate-limit.ts   # Per-IP rate limiting middleware
│   └── csrf.ts         # CSRF protection middleware
├── tools/
│   ├── memory.ts       # memory_search + memory_get (MCP)
│   ├── patch.ts        # apply_patch tool (MCP)
│   └── cron.ts         # cron management tool (MCP)
└── tui/
    ├── tui.ts          # Full TUI (~800+ LOC)
    ├── theme.ts        # Colors and styling
    └── components/
        ├── chat-log.ts        # Scrollable message list
        ├── assistant-message.ts # Streaming markdown render
        ├── user-message.ts    # User message display
        ├── tool-execution.ts  # Tool call/result display
        ├── welcome.ts         # Claude Code-style welcome screen
        ├── hint-bar.ts        # Bottom hints bar
        └── custom-editor.ts   # Multi-line input editor
```

## Configuration

Config file: `~/.camelagi/config.yaml`

```yaml
# Provider and model
provider: anthropic          # anthropic | openai
model: claude-sonnet-4-20250514
apiKey: sk-ant-...           # or set ANTHROPIC_API_KEY env var
baseUrl:                     # custom API endpoint (OpenRouter, Ollama, etc.)

# Agent behavior
thinking: off                # off | low | medium | high
effort: high                 # low | medium | high | max (SDK only)
maxBudgetUsd:                # cost cap per run (SDK only)
maxTurns: 25                 # max agent turns per message
timeoutSeconds: 300          # per-run timeout

# Gateway server
serve:
  port: 18789
  host: 127.0.0.1
  token:                     # auth token for HTTP/WS
  rateLimit:
    windowMs: 60000          # 1 minute window
    max: 60                  # max requests per window per IP

# Named agents (multi-bot)
agents:
  admin:
    name: Admin
    admin: true              # admin bot gets control plane commands
    telegram:
      botToken: "..."
      allowedUsers: [123456789]
  personal:
    name: Personal
    model: deepseek/deepseek-chat
    telegram:
      botToken: "..."
      allowedUsers: [123456789]
    discord:                     # optional Discord channel
      botToken: "MTk..."
      allowedChannels: []
      allowedRoles: []
      mentionOnly: true

# Voice transcription
voice:
  enabled: false
  provider: groq               # groq | openai | deepgram
  # apiKey: gsk_...
  # model: whisper-large-v3-turbo
  # language: en

# Legacy single-bot Telegram (deprecated — use agents instead)
telegram:
  botToken:
  allowedUsers: []
  groups:
    mentionOnly: true        # only respond when @mentioned in groups

# Approvals
approvals:
  mode: off                  # off | smart | always
  allowlist: []              # e.g. ["Bash:git *", "Read"]
  timeoutSeconds: 120
  fallback: deny             # deny | allow
  forwardTo:                 # Telegram chat ID for headless approvals

# Context management
compaction:
  enabled: true
  maxTokens: 80000           # trigger compaction at 80% of this
  keepTurns: 6               # keep last N turns, summarize rest

# Tool policy
tools:
  allow: []                  # whitelist (empty = allow all)
  deny: []                   # blacklist

# Skills
skills:
  enabled: true
  deny: []                   # skills to disable

# Lifecycle hooks
hooks:
  enabled: false

# Retry
retry:
  maxRetries: 3
  backoffMs: 1000

# Concurrency lanes
lanes:
  main: 3
  cron: 1
  subagent: 5

# Boot script
boot: true

# Cron jobs (config-defined — runtime jobs are in ~/.camelagi/cron/jobs.json)
cron:
  - id: daily-summary
    schedule: "24h"           # or cron: "*/30 * * * *"
    prompt: "Summarize today's activity"
    session: daily
    enabled: false
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key (fallback if no Anthropic key) |
| `CAMELAGI_MODEL` | Model override |
| `CAMELAGI_PROVIDER` | Provider override |
| `CAMELAGI_BASE_URL` | Custom base URL |
| `CAMELAGI_TOKEN` | Gateway auth token |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (legacy) |

## Telegram Admin Bot

The admin bot is a BotFather-style control plane. It uses conversational wizards for multi-step flows and inline keyboards for selection.

### Admin Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome + auto-lock to first user |
| `/help` | List all commands |
| `/setup` | Wizard: configure API provider, key, model |
| `/newagent` | Wizard: create a new agent (name → description → model → token) |
| `/agents` | List all agents with status |
| `/deleteagent` | Pick & delete an agent (inline buttons) |
| `/soul` | View/edit agent SOUL.md (inline buttons) |
| `/config` | View config or `/config <key> <value>` to update |
| `/sessions` | List sessions with cleanup buttons |
| `/pairing` | List pending access requests with Approve/Deny buttons |
| `/voice` | Configure voice transcription (Groq/OpenAI/Deepgram) |
| `/status` | System health (bots, API, sessions) |
| `/restart` | Restart all bots or `/restart <id>` for one |
| `/cancel` | Cancel active wizard |

### Agent Bot Commands

Each non-admin agent bot has:

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | List commands |
| `/clear` | Clear chat history |
| `/status` | Model, message count, usage |
| `/model <name>` | Switch model (runtime) |
| `/think` | Set thinking level (inline buttons) |
| `/effort` | Set effort level (inline buttons) |
| `/usage` | Token usage breakdown for this session |
| `/compact` | Force history compaction |
| `/voice` | Voice transcription info (redirects to admin if not configured) |

### How It Works

- **Bootstrap**: `camelagi bootstrap` → enter bot token → starts admin bot
- **Auto-lock**: First `/start` locks the bot to your Telegram account
- **Wizards**: Multi-step flows with inline keyboards, 10-min timeout, `/cancel` to abort
- **Hot-start**: New agents created via `/newagent` start polling immediately
- **ID generation**: Agent names auto-generate unique IDs (e.g. "Personal Finance" → `personalfinance`)

## Workspace

All workspace files live in `~/.camelagi/workspace/`:

| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent instructions and guidelines |
| `SOUL.md` | Personality and tone |
| `IDENTITY.md` | Name and emoji |
| `USER.md` | User profile (name, timezone, preferences) |
| `TOOLS.md` | Environment-specific tool notes |
| `MEMORY.md` | Curated long-term memory |
| `memory/*.md` | Daily auto-flushed memory notes |
| `BOOT.md` | Startup script (runs on gateway launch) |

Per-agent workspaces live in `~/.camelagi/agents/{id}/` with their own `SOUL.md`, `TOOLS.md`, `MEMORY.md`, and `memory/` directory.

These files are injected into the system prompt (truncated if needed: 20K per file, 150K total).

## Channels

### TUI

The TUI connects to an embedded gateway server via WebSocket. Features:

- Claude Code-style welcome screen with ASCII art
- Real-time streaming with markdown rendering
- Tool call visualization with timing
- Thinking/reasoning display
- Autocomplete for slash commands
- Session management (switch, create, clear)
- Status spinner (thinking, responding, tool use, subagent)
- SDK session resume across messages

**Slash commands:** `/help`, `/model`, `/config`, `/sessions`, `/session`, `/new`, `/clear`, `/tools`, `/skills`, `/think`, `/effort`, `/context`, `/status`, `/compact`, `/setup`, `/agents`, `/soul`, `/exit`

**Keyboard shortcuts:** `Ctrl+L` (model), `Ctrl+P` (session), `Ctrl+O` (tools), `Escape` (abort)

### Channel System

CamelAGI uses a pluggable channel architecture. Channels implement a common `Channel` interface for lifecycle management (start/stop/reconcile/hot-reload) and use a shared `ChannelAdapter` for command handling, streaming, and chunking. Adding a new channel means implementing one adapter file.

**Shared across all channels:**
- Command handling (`/help`, `/clear`, `/model`, `/think`, `/effort`, `/status`, `/usage`, `/compact`)
- Message flow (orchestrate → stream → chunk)
- Runtime overrides (per-conversation model/thinking/effort)
- Session persistence

**Channel-specific:**
- Platform SDK (grammY, discord.js, etc.)
- Auth/access control
- Message format, reactions, inline UI
- Rate limits and message size limits

### Telegram

The Telegram adapter uses grammY with multi-bot support:

- **Admin bot**: Wizards + control commands (no AI chat)
- **Agent bots**: AI chat with streaming, tools, approvals
- Message reactions for status (👀 seen, 🤔 thinking, 💭 reasoning, 🔧 tool use)
- Real-time streaming (edits throttled to 1.2s)
- Block-aware chunking for long responses (4096 char Telegram limit)
- Mention gating in groups (`@botname` to trigger)
- User allowlist per agent
- **Pairing flow** for new user approval (see below)
- Session per agent+chat (`{agentId}-{chatId}`)
- Inline keyboards for approval requests
- Compaction and retry
- Auto-restart polling with exponential backoff

### Voice Transcription

Agent bots can receive and transcribe voice messages. Supported providers:

| Provider | Config Key | Notes |
|----------|-----------|-------|
| Groq | `groq` | Free tier, fast, recommended |
| OpenAI | `openai` | Whisper API |
| Deepgram | `deepgram` | Real-time transcription |

**Setup:** Use `/voice` in the admin bot to configure. The wizard walks through provider selection, API key, model, and language.

**How it works:** When a voice message is received, the agent bot downloads the audio, sends it to the transcription provider, and passes the text to the LLM as `[Voice] transcribed text`.

### Discord

The Discord adapter uses discord.js with the following features:

- Guild messages + DMs
- **Mention-only mode** in servers (responds to @mention or replies to bot)
- **Channel restriction** via `allowedChannels`
- **Role restriction** via `allowedRoles`
- **Streaming** — sends a message then edits it as text arrives (600ms throttle)
- All shared commands (`/help`, `/clear`, `/model`, `/think`, `/effort`, `/status`, `/usage`, `/compact`)
- Auto-chunking for responses >2000 chars (Discord limit)
- Hot-reload — start/stop/reconcile on config change

**Config:**

```yaml
agents:
  myagent:
    name: "My Agent"
    discord:
      botToken: "MTk..."
      allowedChannels: []      # empty = all channels
      allowedRoles: []          # empty = all users
      mentionOnly: true         # require @mention in servers
```

### User Pairing (Access Approval)

When a new user messages an agent bot and they're not in `allowedUsers`:

1. **User gets**: "Access requested. Waiting for admin approval." + a 6-character pairing code
2. **Admin bot gets**: Notification with user info (username, ID) + **Approve / Deny** inline buttons
3. **Admin taps Approve** → user is added to `allowedUsers` in config.yaml, user gets "Access approved"
4. **Admin taps Deny** → user gets "Access denied", request is removed

Details:
- Pairing codes use a human-friendly alphabet (no O/0/I/1 confusion)
- Requests expire after 1 hour
- Max 10 pending requests at a time
- Duplicate requests return the same code (no spam)
- Admin can also use `/pairing` to list all pending requests
- Pairing data stored at `~/.camelagi/pairing.json`

If `allowedUsers` is empty (no access control), all users are allowed without pairing.

### HTTP API

The gateway exposes REST endpoints:

| Endpoint | Description |
|----------|-------------|
| `POST /chat` | Send a message, get a response |
| `GET /sessions` | List all sessions |
| `GET /sessions/:id/messages` | Get session messages |
| `DELETE /sessions/:id` | Delete a session |
| `GET /agents` | List all agents |
| `POST /agents` | Create an agent |
| `DELETE /agents/:id` | Delete an agent |
| `GET /agents/:id/soul` | Get agent SOUL.md |
| `PUT /agents/:id/soul` | Update agent SOUL.md |
| `GET /config` | Get config (API key masked) |
| `PATCH /config` | Update config |
| `POST /approvals/:id/decide` | Decide on a pending approval |
| `GET /health` | Health check |

## Approvals

Tool approval system with three modes:

- **off**: All tools auto-approved
- **smart**: Read-only tools auto-approved, write tools need approval
- **always**: Every tool call needs approval

Approval UI:
- **TUI**: SelectList overlay (Allow once / Always allow / Deny)
- **Telegram**: Inline keyboard buttons
- **Headless**: Forward to configured Telegram chat via `forwardTo`

Allowlist patterns: `"Bash:git *"`, `"Write:/path/*"`, `"ToolName"` (glob matching)

## Agent Events

The agent emits event types for real-time UI updates:

| Event | Description |
|-------|-------------|
| `init` | SDK session initialized (contains `sessionId`) |
| `stream_text` | Incremental text token |
| `chunk` | Final complete response |
| `tool_call` | Tool invoked (with `id`, `name`, `args`) |
| `tool_result` | Tool completed (with `id`, `name`, `preview`) |
| `thinking` | Thinking started/ended |
| `thinking_delta` | Incremental thinking text |
| `subagent_start` | Subagent spawned |
| `subagent_progress` | Subagent progress update |
| `subagent_done` | Subagent completed |
| `usage` | Token usage report |
| `approval_request` | Tool needs approval (with `id`, `toolName`, `preview`) |
| `approval_resolved` | Approval decided |

## Context Compaction

When conversation history exceeds 80% of `maxTokens`:

1. Split history into old messages and recent N turns
2. **Memory flush**: Extract durable facts from old messages → append to `memory/YYYY-MM-DD.md`
3. **Summarize**: Compress old messages into a summary via LLM
4. Replace old messages with summary + keep recent turns

## Error Handling & Retry

Errors are classified into kinds:

| Kind | Retryable | Examples |
|------|-----------|----------|
| `auth` | No | 401, 403, invalid API key |
| `billing` | No | 402, payment required |
| `format` | No | 400, invalid request |
| `rate_limit` | Yes | 429, 5xx server errors |
| `timeout` | Yes | Timeouts, aborted |
| `overflow` | Once | Context too large (triggers compaction) |
| `unknown` | Once | Anything else |

Retry uses exponential backoff: `backoffMs * 2^attempt`.

## Concurrency

**Lanes** limit parallel agent runs:
- `main` (3): TUI/HTTP/Telegram messages
- `cron` (1): Scheduled jobs
- `subagent` (5): SDK subagents

**Run tracking** uses `runId` as primary key (not session ID) to prevent race conditions when multiple connections share a session.

## Cron Jobs

Scheduled agent runs with two sources:

- **Config-defined**: `config.yaml` `cron:` array — managed by editing the file
- **Runtime-defined**: `~/.camelagi/cron/jobs.json` — managed via agent tool or CLI

### Schedule Formats

| Format | Type | Example |
|--------|------|---------|
| `5m`, `1h`, `30s`, `1d` | Repeating interval | Every 5 minutes |
| `*/5 * * * *` | Cron expression | Every 5 minutes (minute field) |
| `+20m`, `+2h` | One-shot relative | Runs once in 20 min, auto-deletes |
| `2026-03-14T09:00:00Z` | One-shot absolute | Runs once at exact time, auto-deletes |

### Agent Tool (Claude models only)

The agent has a `cron` tool with 4 actions. Users can say things like:

- "remind me in 20 minutes to check the deploy"
- "schedule a daily summary every morning"
- "show me my cron jobs"
- "delete the daily-check job"

The tool supports: `list`, `add`, `remove`, `run`.

Relative schedules (`+20m`) are converted to absolute ISO timestamps on creation, so they survive server restarts correctly.

### CLI

```bash
# List all jobs (config + runtime)
camelagi cron

# Add a repeating job
camelagi cron add --name "Daily Check" --schedule "1d" --prompt "check server status"

# Add a one-shot reminder
camelagi cron add --schedule "+20m" --prompt "remind me about the meeting"

# Remove a runtime job
camelagi cron rm job-m1abc

# Trigger a job immediately
camelagi cron run daily-summary
```

### Error Backoff

On consecutive failures, retry delay escalates: **30s → 1m → 5m → 15m → 60m**. Resets to normal schedule after a successful run.

### Execution

- Jobs run using `setTimeout` chains (not `setInterval`) to support dynamic backoff
- Repeating jobs run immediately on startup, then on schedule
- One-shot jobs run after the delay, then auto-delete from the store
- Each job gets its own session: `cron-{jobId}` (or custom `session` field)
- Runs through the standard `runAgent()` with full tool access
- Cron lane limits parallel execution (default: 1 concurrent cron job)

## Hooks

Place shell scripts in `~/.camelagi/hooks/`:

```
~/.camelagi/hooks/
  before_prompt.log.sh     # Runs before each user message
  after_response.notify.sh # Runs after each response
  before_tool.audit.sh     # Runs before each tool call
  after_tool.metrics.sh    # Runs after each tool call
```

Context is passed via environment variables: `CAMELAGI_HOOK_POINT`, `CAMELAGI_HOOK_SESSION`, `CAMELAGI_HOOK_MESSAGE`, `CAMELAGI_HOOK_TOOL`, etc.

## Skills

Place skill directories in `~/.camelagi/skills/`:

```
~/.camelagi/skills/
  my-skill/
    SKILL.md     # Skill definition with optional YAML frontmatter
```

Frontmatter format:
```yaml
---
name: my-skill
description: Does something useful
---
# Skill instructions here...
```

Skills are injected into the system prompt (budget: 30K chars total).

## Security

### Timing-Safe Token Comparison

The gateway auth token is compared using `crypto.timingSafeEqual` with SHA-256 hashing on both sides. This prevents timing attacks where an attacker could deduce the token character-by-character by measuring response times.

### CSRF Protection

The gateway blocks cross-origin mutation requests (POST, PUT, PATCH, DELETE) from browsers:

- Rejects requests with `Sec-Fetch-Site: cross-site`
- Rejects requests with non-loopback `Origin` header
- Rejects requests with non-loopback `Referer` header (when no `Origin` present)
- Non-browser clients (curl, Node.js) that don't send these headers pass through

### Security Audit (`camelagi doctor`)

The doctor command includes security checks:

- **Config file permissions** — warns if `config.yaml` is readable by other users (should be `600`)
- **State directory permissions** — warns if `~/.camelagi/` is accessible by others (should be `700`)
- **Auth token** — warns if no token is set or if token is shorter than 24 characters
- **Bind address** — warns if the server binds to a non-loopback address (exposed to network)

## Dependencies

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | Claude Agent SDK (tools, thinking, subagents) |
| `@anthropic-ai/sdk` | Anthropic API client (compaction, doctor) |
| `openai` | OpenAI-compatible API client (multi-provider fallback) |
| `@mariozechner/pi-tui` | Terminal UI framework |
| `grammy` | Telegram bot framework |
| `discord.js` | Discord bot framework |
| `express` | HTTP server |
| `ws` | WebSocket server |
| `zod` | Schema validation |
| `yaml` | YAML config parsing |
| `chalk` | Terminal colors |
| `dotenv` | Environment variable loading |

## Daemon (macOS)

CamelAGI can run as a background daemon that auto-starts on boot and auto-restarts on crash. This uses macOS `launchd`.

```bash
# Install — generates plist and starts immediately
camelagi daemon install

# Check if it's running
camelagi daemon status

# Remove — stops and removes the plist
camelagi daemon uninstall
```

The plist is written to `~/Library/LaunchAgents/com.camelagi.server.plist` and runs `camelagi serve`. Daemon stdout/stderr logs go to `~/.camelagi/logs/daemon.{stdout,stderr}.log`.

This is opt-in — by default you still start the server manually with `camelagi serve`.

## Request Logging

The gateway logs every HTTP request as a JSON line to `~/.camelagi/logs/server.log`. Each entry contains:

```json
{ "ts": "2026-03-13T12:00:00.000Z", "method": "POST", "path": "/chat", "status": 200, "ms": 1523, "sessionId": "my-session" }
```

- Logs auto-rotate daily (old log renamed to `server-YYYY-MM-DD.log`)
- Rotated logs older than 7 days are cleaned up on startup
- Only active when the server runs in non-silent mode (i.e. `camelagi serve`, not embedded mode)

```bash
# View recent logs
camelagi logs

# Show last 100 lines
camelagi logs -n 100
```

## Rate Limiting

The gateway includes per-IP rate limiting to protect against runaway clients burning API credits.

- Default: **60 requests per minute** per IP
- Returns `429 Too Many Requests` with `X-RateLimit-*` headers when exceeded
- Configurable in `config.yaml`:

```yaml
serve:
  rateLimit:
    windowMs: 60000   # 1 minute
    max: 60            # max requests per window
```

This works alongside concurrency lanes (which limit parallel agent runs) — rate limiting caps total request volume, lanes cap concurrent execution.

## Claude Agent SDK Features Used

### Core
- **`query()`** — Main agent execution with streaming message iteration
- **`tool()`** — Define custom MCP tools (memory_search, memory_get, apply_patch, cron)
- **`createSdkMcpServer()`** — In-process MCP server for custom tools

### Built-in Tools
- `Read`, `Write`, `Edit`, `Bash` — File and shell operations
- `Glob`, `Grep` — File search
- `WebSearch`, `WebFetch` — Web access
- `Agent` — Subagent spawning

### Configuration
- **`systemPrompt`** — Custom system prompt with bootstrap files
- **`allowedTools`** — Tool whitelist
- **`disallowedTools`** — Tool blacklist
- **`maxTurns`** — Turn limit per run
- **`maxBudgetUsd`** — Cost cap per run
- **`permissionMode: "bypassPermissions"`** — Headless execution
- **`cwd`** — Working directory
- **`env`** — Environment variables (`ANTHROPIC_API_KEY`)
- **`thinking: { type: "adaptive" }`** — Adaptive thinking for Claude
- **`effort`** — Thinking effort level
- **`settingSources: ["project"]`** — Load project-level settings
- **`includePartialMessages`** — Enable stream events

### Hooks (SDK-level)
- **`PreToolUse`** — Before each tool call (logging, audit, approval, custom hooks)
- **`PostToolUse`** — After each tool call (logging, metrics)
- **`HookCallback`** — Type for hook functions

### Session Management
- **`session_id`** — Captured from `init` system message
- **`resume`** — Resume a previous SDK session by ID

### Streaming Events
- **`result`** — Final result with usage stats
- **`system`** — Init, task lifecycle (started, progress, notification)
- **`stream_event`** — SSE events (text_delta, thinking_delta, content_block_start/stop)

### Subagent Tracking
- `task_started`, `task_progress`, `task_notification` — Subagent lifecycle events with `agent_id`, `tool_use_id`, `tool_count`, `duration_ms`
