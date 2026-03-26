<p align="center">
  <img src="assets/logo-bg.png" alt="CamelAGI Logo" width="200" />
</p>
<h1 align="center" style="border: none; padding-bottom: 0; margin-bottom: 0;">CamelAGI</h1>
<p align="center" style="font-size: 0.9em; color: #b45309; margin-top: 4px;"><strong>OpenClaw Alternative</strong></p>
<p align="center">
  <strong>Your personal AI agent — powered by Claude Agent SDK.<br>Set it up once, manage everything from Telegram.</strong>
</p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript" alt="TypeScript"></a>
  <a href="https://platform.claude.com/docs/en/agent-sdk/overview"><img src="https://img.shields.io/badge/Built%20with-Claude%20Agent%20SDK-orange?logo=anthropic" alt="Claude Agent SDK"></a>
  <a href="https://core.telegram.org/bots"><img src="https://img.shields.io/badge/Telegram-Admin%20Bot-26A5E4?logo=telegram" alt="Telegram"></a>
  <a href="https://camelagi.net"><img src="https://img.shields.io/badge/Website-camelagi.net-brown" alt="Website"></a>
</p>

<br>

CamelAGI is a self-hosted AI assistant that runs on your server and puts you in full control from your phone. One command to install, then manage everything — create agents, switch models, approve tools, monitor usage — all from Telegram, Discord, or your terminal.

<p align="center">
  <img src="assets/Claude_Logo.png" alt="Claude Logo" width="200" />
</p>
<p align="center">
Powered by <a href="https://platform.claude.com/docs/en/agent-sdk/overview">Claude Agent SDK</a> — the same runtime behind Claude Code.
</p>

<p align="center">
  <a href="https://camelagi.net"><strong>camelagi.net</strong></a>
</p>

## Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [Channels](#channels)
- [Admin Bot Commands](#admin-bot-commands)
- [Agent Bot Commands](#agent-bot-commands)
- [CLI Commands](#cli-commands)
- [Built on Claude Agent SDK](#built-on-claude-agent-sdk)
- [Claude Agent SDK vs pi-agent](#claude-agent-sdk-vs-pi-agent)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Documentation](#documentation)
- [License](#license)

<br>

## Quick Start

> **Requirements:** Node.js 23+

| Install | Setup & Run | Update |
|:--------|:------------|:-------|
| `npm i -g camelagi` | `camel setup` | `camel update` |

```bash
camel setup      # First-time setup: API key, Telegram bot, provider
camel serve      # Start the gateway server
camel chat       # Terminal UI
```

After setup, use `/newagent` in Telegram to create your first AI agent.

<br>

## Features

> 4 channels, 18 CLI commands, 10 built-in tools — terminal, Telegram, Discord, or Claude Code.

| | Feature | Description |
|---|---|---|
| 💻 | **Claude Code via Telegram** | Run Claude Code on your local machine, remote-controlled from Telegram. `/claudecode` to start — browse directories, switch models, manage sessions. Full Claude Code power from your phone |
| 🤖 | **Telegram — Admin Bot** | BotFather for AI agents. Create, configure, clone, and manage agents entirely from Telegram — instant commands, zero tokens |
| 💬 | **Telegram — Agent Bots** | Each agent gets its own Telegram bot. Message it like any chat — it runs tools, reads files, remembers context |
| 🎮 | **Discord Bots** | Per-agent Discord bots with mention-only mode, role filtering, and channel restrictions |
| ⌨️ | **Terminal UI** | Full TUI with streaming, slash commands, model switching, session management, and markdown rendering |
| 🧠 | **Agent Memory** | Isolated two-tier memory per agent — curated MEMORY.md + daily auto-journaling with recency-boosted search |
| 🎙️ | **Voice Transcription** | Send voice messages to agent bots — transcribed via Groq, OpenAI, or Deepgram and processed as text |
| 🔌 | **MCP Servers** | Connect external tool servers (stdio, HTTP, SSE). Global or per-agent. Add/remove from Telegram with `/mcp` |
| 💭 | **Extended Thinking** | Claude reasons step by step before answering. Configure depth: off, low, medium, high |
| ⏰ | **Cron Jobs** | Schedule AI tasks — daily summaries, monitoring, automations. Intervals, cron expressions, or one-shot timers |
| 📋 | **Brief Mode** | Toggle short text-message-style replies per chat or per agent — ideal for Telegram |
| 📊 | **Usage Tracking** | Per-agent token usage and cost breakdown — input, output, cache reads, API calls |
| 🧬 | **Agent Cloning** | Clone an existing agent with all its config, personality, memory, and MCP servers |
| 🔐 | **Secure Pairing** | OTP-based user verification. No hardcoded IDs — pairing code + 5-digit OTP from Telegram |
| 🔁 | **Multi-Provider** | Anthropic, OpenAI, OpenRouter, Ollama — any OpenAI-compatible endpoint. Zero vendor lock-in |
| 🛡️ | **Tool Approvals** | Human-in-the-loop safety. Approve dangerous operations from Telegram with inline buttons |
| 🪝 | **Skills & Hooks** | Teach agents skills via Markdown. Run shell/JS hooks before and after tool calls |
| 🔄 | **Auto Compaction** | Summarizes old turns at 80% capacity. Flushes facts to memory first — nothing is lost |
| ⚙️ | **Same Engine** | All channels run the same agent loop, same tools, same memory. Switch freely between them |

<br>

## Channels

CamelAGI runs across four channels — all sharing the same agent runtime, tools, and memory.

### Claude Code via Telegram

Run Claude Code on your local machine, controlled from your phone. Type `/claudecode` in any agent bot to start — or create an agent with `mode: claude-code` for always-on mode.

- **Directory browser** — navigate your filesystem from Telegram inline buttons
- **Session management** — start, stop, resume previous sessions
- **Model switching** — switch between Sonnet, Opus, Haiku on the fly
- **Real-time streaming** — responses stream back to Telegram as Claude Code generates them
- **Persistent sessions** — conversations carry across messages via `--resume`

Requires Claude Code installed (`npm i -g @anthropic-ai/claude-code`) and logged in (`claude login`).

### Telegram

Two bot types work together:

- **Admin Bot** — A non-AI command bot (zero tokens burned). Create agents, manage config, approve users, monitor sessions, configure MCP servers, set up voice — all from Telegram. Think [@BotFather](https://t.me/BotFather), but for your entire AI infrastructure.
- **Agent Bots** — Each agent gets its own Telegram bot. Message it like any contact — it runs tools, reads files, remembers context, and supports voice messages.

### Discord

Per-agent Discord bots with:
- **Mention-only mode** — responds only to @mentions in guild channels, all messages in DMs
- **Role filtering** — optional allowlist of Discord roles
- **Channel restrictions** — optional allowlist of channels

### Terminal

`camel chat` gives you a full TUI with streaming, slash commands, keyboard shortcuts, model switching, session management, and one-shot mode (`camel "your question"`).

<br>

## Admin Bot Commands

The Admin Bot is a non-AI Telegram bot for managing your entire CamelAGI server.

| Category | Command | Description |
|----------|---------|-------------|
| **Setup** | `/setup` | Configure API provider, key, model |
| | `/config` | View configuration |
| | `/config <key> <value>` | Update config |
| **Agents** | `/newagent` | Create agent wizard |
| | `/agents` | List all agents |
| | `/agent` | View/edit agent config |
| | `/deleteagent` | Delete an agent |
| | `/soul` | View/edit agent personality |
| **Tools** | `/mcp` | Manage MCP servers (add/list/remove) |
| | `/voice` | Configure voice transcription provider |
| **Monitor** | `/status` | System health & stats |
| | `/sessions` | List & manage sessions |
| | `/usage` | Per-agent usage & cost summary |
| | `/restart` | Restart agent bots |
| **Security** | `/pairing` | Manage access requests |
| **Utility** | `/help` | List all commands |
| | `/cancel` | Cancel active wizard |

<br>

## Agent Bot Commands

Each agent bot supports these commands in Telegram:

| Category | Command | Description |
|----------|---------|-------------|
| **Chat** | `/clear` | Clear this chat's history |
| | `/compact` | Force compaction of chat history |
| | `/brief` | Toggle brief response mode |
| | `/export` | Export session as markdown file |
| **Model** | `/model` | Switch model for this chat |
| | `/think` | Set thinking level (off/low/medium/high) |
| | `/effort` | Set effort level (low/medium/high/max) |
| **Session** | `/session` | Show or switch session |
| | `/status` | Show model, message count, token usage |
| | `/usage` | Token usage for this session |
| **Tools** | `/skills` | List active skills |
| | `/mcp` | Manage MCP tool servers |
| | `/voice` | Voice transcription info |
| **Utility** | `/help` | List commands and current config |

<br>

## CLI Commands

```
camel <command> [options]
```

| Category | Command | Description |
|----------|---------|-------------|
| **Getting Started** | `bootstrap` | First-time setup wizard |
| | `setup` | Interactive setup (re-run anytime) |
| | `chat` | Interactive terminal UI |
| **Server** | `serve` | Start the gateway server |
| | `watch` | Monitor a running gateway in real-time |
| | `connect` | Connect TUI to a remote gateway |
| | `tailscale` | Tailscale remote access setup |
| | `daemon` | Manage launchd daemon (install/uninstall/status) |
| | `logs` | Tail server request log |
| | `status` | System health overview |
| **Agents & Sessions** | `agents` | List configured agents |
| | `soul` | View/edit agent SOUL.md in $EDITOR |
| | `sessions` | List saved sessions |
| | `pairing` | List and approve/deny pending requests |
| **Configuration** | `config` | View/edit config (get/set/list) |
| | `cron` | Manage cron jobs (list/add/rm/run) |
| **Maintenance** | `doctor` | Run health checks |
| | `reset` | Delete all config, sessions, agents |
| | `install` | Install to ~/.camelagi/versions/ and add to PATH |
| | `uninstall` | Remove CamelAGI completely |
| | `update` | Update to the latest version |

One-shot mode: `camel "your question"` — spins up an ephemeral gateway and answers inline.

Remote one-shot: `CAMELAGI_REMOTE_URL=http://server:18305 camel "your question"` — sends to remote gateway.

<br>

## Built on Claude Agent SDK

<p align="center">
  <img src="assets/Claude_Logo.png" alt="Claude Logo" width="200" />
</p>

Powered by [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) — the same runtime behind Claude Code.

> **10 tools** · **Two-tier memory** · **Extended thinking** · **Subagents** · **Context compaction** · **Multi-provider**

- **Agent Capabilities** — <span style="font-size: 0.9em; color: #d97706;">Powered by Claude Agent SDK</span>
  - 10 built-in tools (shell, files, web, memory, cron)
  - Extended thinking with chain-of-thought
  - Subagent spawning for parallel work
  - Prompt caching for efficiency
- **Memory System** — <span style="font-size: 0.9em; color: #d97706;">Powered by Claude Agent SDK</span>
  - Curated MEMORY.md per agent
  - Daily auto-journaling with timestamps
  - Recency-boosted search (today 1.5x)
  - Auto memory flush on compaction

  Each agent gets isolated memory & personality:

  ```
  ~/.camelagi/
  ├── agents/
  │   ├── coder/
  │   │   ├── SOUL.md          ← Coder's personality
  │   │   ├── MEMORY.md        ← Coder's curated knowledge
  │   │   └── memory/
  │   │       └── 2026-03-14.md
  │   └── researcher/
  │       ├── SOUL.md          ← Researcher's personality
  │       ├── MEMORY.md        ← Researcher's curated knowledge
  │       └── memory/
  │           └── 2026-03-14.md
  └── config.yaml
  ```

  Each agent runs on Claude Agent SDK with its own tools, memory, and conversation history. They don't share context. Fully independent, managed from your single Admin Bot.

<br>

## Claude Agent SDK vs pi-agent

CamelAGI uses **Claude Agent SDK**. OpenClaw uses **pi-agent-core**. Here's why that matters:

|  | **Claude Agent SDK** (CamelAGI) | **pi-agent-core** (OpenClaw) |
|---|---|---|
| **Built by** | Anthropic | Third-party |
| **Tool use** | Native function calling with structured outputs | Custom tool protocol |
| **Thinking** | Extended thinking (low/medium/high) built-in | Not available |
| **Subagents** | Native agent spawning with isolated context | Custom implementation |
| **Prompt caching** | Built-in, automatic | Manual |
| **Memory** | Agent-scoped two-tier memory with recency boost | Vector DB (LanceDB) |
| **Streaming** | Native SSE streaming | Custom streaming |
| **Upgrades** | `npm update` — get Anthropic's latest improvements | Maintain custom abstractions |

> **The key difference:** Claude Agent SDK is Anthropic's own runtime. When Anthropic ships improvements to tool use, thinking, or context handling, CamelAGI gets them automatically. pi-agent is a third-party layer that must be manually updated to keep up.

<br>

## Configuration

CamelAGI uses a single YAML config file at `~/.camelagi/config.yaml`, validated with Zod.

```yaml
# Provider & Model
provider: anthropic          # anthropic | openai | openrouter | ollama
model: claude-sonnet-4-20250514
anthropicApiKey: sk-ant-...

# Telegram
telegramBotToken: "123456:ABC..."
allowedTelegramUsers: [123456789]

# Agents
agents:
  coder:
    model: claude-sonnet-4-20250514
    thinkingLevel: medium
    briefMode: true
    telegramBotToken: "654321:XYZ..."
    mcp:
      servers:
        github:
          type: stdio
          command: npx
          args: ["-y", "@modelcontextprotocol/server-github"]

# MCP Servers (global)
mcp:
  servers:
    supabase:
      type: http
      url: https://mcp.supabase.com/...
```

Environment variables override file values: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CAMELAGI_MODEL`, `CAMELAGI_PROVIDER`, `CAMELAGI_TOKEN`, `TELEGRAM_BOT_TOKEN`.

See [featuresDocs/configuration.md](featuresDocs/configuration.md) for the full configuration reference.

<br>

## Architecture

```
~/.camelagi/
├── config.yaml              ← Single config file
├── workspace/               ← Default agent workspace
│   ├── SOUL.md              ← Default personality
│   ├── MEMORY.md            ← Default curated memory
│   └── memory/              ← Daily notes
├── agents/                  ← Per-agent isolated directories
│   └── <agent-id>/
│       ├── SOUL.md
│       ├── TOOLS.md
│       ├── MEMORY.md
│       └── memory/
├── sessions/                ← JSONL conversation history
├── skills/                  ← Markdown skill files
└── usage/                   ← Token usage data
```

**Request flow:**

```
Inbound message (TUI / REST / WS / Telegram / Discord)
  → Queue check (per-session, prevents concurrent runs)
  → Lane acquisition (concurrency limits: main/cron/subagent)
  → History loading + compaction (summarize at 80% of maxTokens)
  → Agent execution with retry (classify error → backoff or compact → retry)
  → Message persistence (JSONL sessions)
  → Cleanup (release lane, drain queued messages)
```

<br>

## Documentation

| Document | Description |
|----------|-------------|
| [DOCS.md](DOCS.md) | Full reference documentation |
| [GUIDE.md](GUIDE.md) | User guide with examples |
| [featuresDocs/](featuresDocs/) | Deep-dive feature docs |

Feature docs cover: [agent system](featuresDocs/agent-system.md), [memory](featuresDocs/memory-system.md), [Telegram bots](featuresDocs/telegram-bots.md), [gateway server](featuresDocs/gateway-server.md), [runtime](featuresDocs/runtime.md), [tools](featuresDocs/tools.md), [extensions](featuresDocs/extensions.md), [configuration](featuresDocs/configuration.md), [CLI](featuresDocs/cli-commands.md), [TUI](featuresDocs/tui.md), [pairing](featuresDocs/pairing-otp.md).

<br>

## License

MIT
