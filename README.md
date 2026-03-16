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

CamelAGI is a self-hosted AI assistant that runs on your server and puts you in full control from your phone. One command to set up, then manage everything from Telegram — no terminal needed.

<p align="center">
  <a href="https://camelagi.net"><strong>🌐 CamelAGI.net</strong></a>
</p>

## Contents

- [Built on Claude Agent SDK](#built-on-claude-agent-sdk)
- [Admin Bot — BotFather for Your AI Server](#admin-bot--botfather-for-your-ai-server)
- [Claude Agent SDK vs pi-agent](#claude-agent-sdk-vs-pi-agent)
- [Quick Start](#quick-start)
- [Features](#features)
- [Terminal UI — `camel chat`](#terminal-ui--camel-chat)
- [Developer Experience](#developer-experience)
- [Roadmap](#roadmap)
- [Documentation](#documentation)
- [License](#license)

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

## Quick Start

**Install**
```bash
npm install -g camelagi
```

**Usage**
```bash
camel bootstrap     # Full setup: admin bot + pairing + API config
camel serve         # Start the gateway (after bootstrap)
camel chat          # Terminal UI
```

<br>

## Admin Bot — BotFather for Your AI Server

Create agents, manage config, approve users, monitor sessions, restart bots — all from Telegram. The Admin Bot is a **non-AI Telegram bot** — no LLM calls, no tokens burned, just instant commands. Think [@BotFather](https://t.me/BotFather), but for your entire AI infrastructure.

### Getting Started

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram
2. Run `camel bootstrap` and paste the bot token
3. Send a message to your bot on Telegram — the CLI detects you
4. Approve yourself in the CLI, then enter the OTP in Telegram
5. Pick your AI provider and model (or skip and do it later via `/setup` in Telegram)
6. Done — use `/newagent` in Telegram to create your first AI agent

### Commands

| Category | Command | Description |
|----------|---------|-------------|
| **Agents** | `/newagent` | Create agent wizard |
| | `/agents` | List all agents |
| | `/deleteagent` | Delete an agent |
| | `/soul` | View/edit agent personality |
| **Config** | `/config` | View configuration |
| | `/config <key> <value>` | Update config |
| | `/setup` | API provider wizard |
| **Monitor** | `/status` | System health & stats |
| | `/sessions` | List & manage sessions |
| | `/restart` | Restart agent bots |
| **Security** | `/pairing` | Manage access requests |

<br>

## Features

> Terminal or Telegram — same agent, same tools, same memory.

| | Feature | Description |
|---|---|---|
| ⌨️ | **camel chat — Terminal UI** | Full TUI with streaming, slash commands, model switching, session management, tool output, and markdown rendering |
| 🤖 | **Telegram — Admin Bot** | @BotFather for AI agents. Create, configure, and manage agents entirely from Telegram — instant commands, zero tokens burned |
| 💬 | **Telegram — Agent Bots** | Each agent gets its own Telegram bot. Message it like any chat — it runs tools, reads files, remembers context |
| ⚙️ | **Same Engine** | Both interfaces run the same agent loop, same 10 tools, same two-tier memory. Switch between terminal and Telegram anytime |
| 🧠 | **Agent Memory** | Each agent gets isolated two-tier memory — curated MEMORY.md + daily auto-journaling with recency-boosted search |
| ⏰ | **Cron Jobs** | Schedule AI tasks — daily summaries, monitoring, automations. Manage from Telegram, CLI, or the agent itself |
| 🛡️ | **Tool Approvals** | Human-in-the-loop safety. Approve dangerous operations from Telegram with inline buttons — even headless |
| 💭 | **Extended Thinking** | Claude reasons step by step before answering. Configure depth: off, low, medium, high |
| 🔌 | **Multi-Provider** | Anthropic, OpenAI, OpenRouter, Ollama — any OpenAI-compatible endpoint. Zero vendor lock-in |
| 🔐 | **Secure Pairing** | OTP-based user verification. No hardcoded IDs — pairing code + 5-digit OTP from Telegram |
| 🪝 | **Skills & Hooks** | Teach agents skills via Markdown. Run shell/JS hooks before and after tool calls |
| 🔄 | **Auto Compaction** | Summarizes old turns at 80% capacity. Flushes facts to memory first — nothing is lost |

<br>

## Terminal UI — `camel chat`

Don't want to use Telegram? `camel chat` gives you a full terminal interface with the same agent capabilities.

- Streaming responses with markdown rendering
- Slash commands (`/model`, `/sessions`, `/tools`, `/compact`, `/status`, `/context`)
- Model selector overlay (`Ctrl+L`), session switcher (`Ctrl+P`)
- Tool output toggle (`Ctrl+O`), abort with `Escape`
- Shell execution with `!command`
- Agent creation wizard, SOUL.md editing
- Thinking indicators, subagent progress, approval overlay
- One-shot mode: `camel "your question"` for quick answers

<br>

## Developer Experience

| | **CamelAGI** | **OpenClaw** |
|---|---|---|
| **Codebase size** | ~10K LOC | ~700K+ LOC |
| **AI Agent runtime** | [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) — fully documented by Anthropic, easy to extend | pi-agent & custom abstractions |

<br>

## Roadmap

We're building CamelAGI to be the most capable open-source AI platform — for individuals and businesses alike.

| | Feature | Description |
|---|---|---|
| 📡 | **More Channels** | WhatsApp, Discord, Slack — connect your AI agents to every platform your team already uses |
| 🧩 | **ClawHub Skills** | Browse and install community skills from [clawhub.io](https://clawhub.io) — one command to add new capabilities to any agent |
| 🖥️ | **Native Desktop Apps** | Standalone macOS and Windows apps to run CamelAGI natively — no terminal, no companion app required |
| 🏢 | **Business Ready** | Deploy CamelAGI for your business — finance, accounting, operations, customer support. AI agents that understand your workflows |

<br>

## Documentation

| Document | Description |
|----------|-------------|
| [DOCS.md](DOCS.md) | Full reference documentation |
| [GUIDE.md](GUIDE.md) | User guide with examples |
| [featuresDocs/](featuresDocs/) | Deep-dive feature docs |

<br>

## License

MIT
