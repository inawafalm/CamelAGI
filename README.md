<p align="center">
  <img src="assets/logo-bg.png" alt="CamelAGI Logo" width="180" />
</p>

<h1 align="center">CamelAGI</h1>

<p align="center">
  <strong>Open-source AI agent platform built on Claude Agent SDK + Cursor SDK.</strong><br>
  Alternative to OpenClaw — self-hosted, multi-runtime, multi-channel.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript" alt="TypeScript"></a>
  <a href="https://platform.claude.com/docs/en/agent-sdk/overview"><img src="https://img.shields.io/badge/Built%20with-Claude%20Agent%20SDK-orange?logo=anthropic" alt="Claude Agent SDK"></a>
  <a href="https://cursor.com/docs/sdk/typescript"><img src="https://img.shields.io/badge/Built%20with-Cursor%20SDK-purple" alt="Cursor SDK"></a>
  <a href="https://core.telegram.org/bots"><img src="https://img.shields.io/badge/Telegram-Admin%20Bot-26A5E4?logo=telegram" alt="Telegram"></a>
  <a href="https://camelagi.net"><img src="https://img.shields.io/badge/Website-camelagi.net-brown" alt="Website"></a>
</p>

<p align="center">
  <img src="assets/Claude_Logo.png" alt="Claude Logo" width="100" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="assets/Cursor_Logo.png" alt="Cursor Logo" width="100" />
</p>

<p align="center">
  Dual runtime: <strong>Claude Agent SDK</strong> + <strong>Cursor SDK</strong> — switch between them per session.
</p>

<p align="center">
  <img src="assets/camelSetupTUI.gif" alt="CamelAGI Setup" width="700" />
</p>

---

## Install in 30 seconds

```bash
npm i -g camelagi
camel setup
camel serve
```

Use `/newagent` in Telegram to create your first AI agent.

---

## Why CamelAGI

- **Dual SDK runtime** — Claude Agent SDK + Cursor SDK, switchable per session
- Run Claude Code remotely from Telegram  
- Create and manage multiple AI agents  
- Self-hosted with full control  
- Multi-provider support (Anthropic, OpenRouter, or any OpenAI-compatible endpoint)
- Alternative to OpenClaw  

---

## Quick Start

> **Requirements:** Node.js 23+

| Install | Setup & Run | Update |
|:--------|:------------|:-------|
| `npm i -g camelagi` | `camel setup` | `camel update` |

```bash
camel setup
camel serve
camel chat
```

---

## Agent Modes

### 1. LLM Agent (API-based)

Uses your API key (Anthropic, OpenAI, OpenRouter, etc.) to run an AI agent through CamelAGI runtime.

1. Open admin bot in Telegram  
2. Send `/newagent`  
3. Pick name → choose model → paste bot token  
4. Start chatting  

### 2. Claude Code Agent (local CLI)

Runs Claude Code directly on your machine, remote-controlled from Telegram. Same experience as the Claude Code CLI, but from your phone.

> **Requires:** Claude Code installed and logged in on the machine running CamelAGI.
>
> ```bash
> npm i -g @anthropic-ai/claude-code
> claude login
> ```

1. Open admin bot → `/newagent` → select **Claude Code (local CLI)** → paste bot token
2. Or use `/claudecode` in any existing agent bot to start on the fly

#### What Claude Code mode can do

| Category | Capabilities |
|----------|-------------|
| **Session** | Start, stop, new session, resume previous sessions |
| **Models** | Switch between Sonnet 4.6, Opus 4.6, Haiku 4.5 |
| **Code Actions** | `/review`, `/fix`, `/test`, `/commit`, `/pr`, `/refactor`, `/security`, `/explain`, `/init`, `/doc` |
| **Settings** | `/model`, `/effort`, `/workdir`, `/tools`, `/prompt`, `/budget`, `/adddir`, `/worktree` |
| **Voice Input** | Send voice messages — transcribed and processed by Claude Code |
| **Directory Browser** | Navigate folders via Telegram inline buttons |
| **Tool Control** | Toggle individual tools on/off (Bash, Read, Write, Edit, etc.) |
| **Hybrid Mode** | Claude Code gets CamelAGI context — SOUL.md personality, MEMORY.md, daily notes, skills, MCP servers |
| **CamelAGI API** | Claude Code can access cron jobs, sessions, agents, config via the gateway API |
| **Streaming** | Real-time response streaming via native Telegram `sendMessageDraft` |
| **Pinned Status** | "Claude Code ON" pinned in chat, dynamic command menu |

---

## Cursor SDK Runtime

CamelAGI supports the [Cursor SDK](https://cursor.com/docs/sdk/typescript) as an alternative agent runtime alongside Claude Agent SDK. Switch between them at any time — each session remembers which runtime it uses.

### Setup

Get your Cursor API key from [Cursor Dashboard → Integrations](https://cursor.com/settings).

```yaml
# ~/.camelagi/config.yaml
cursorApiKey: "crsr_..."
cursorModel: "composer-2"    # optional, defaults to composer-2
```

Or set the env var: `export CURSOR_API_KEY=crsr_...`

### Switching runtimes

**TUI:**
```
/cursor    — switch to Cursor SDK
/claude    — switch back to Claude SDK
```

**REST API:**
```bash
curl -X POST http://localhost:18305/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "hello", "sdk": "cursor"}'
```

**WebSocket:**
```json
{"type": "chat", "message": "hello", "sdk": "cursor"}
```

Sessions are sticky — the first message sets the runtime, and all subsequent messages on that session use the same one automatically.

---

## Terminal UI

A rich terminal chat interface built with [OpenTUI](https://opentui.dev) + Bun. Requires [Bun](https://bun.sh) installed.

```bash
camel chat           # New TUI (auto-detects Bun)
camel chat --classic # Legacy TUI (pi-tui, no Bun needed)
```

| Feature | Description |
|---------|-------------|
| **Tool Renderers** | Bash output, Edit/Write inline diffs (green/red), Read file display, Search results |
| **Streaming** | Real-time text + thinking blocks with shimmer animation |
| **Slash Commands** | `/model`, `/effort`, `/think`, `/clear`, `/compact`, `/status`, `/sessions`, `/copy`, `/save` |
| **Approval Prompts** | Modal dialog for tool approvals (Allow / Deny) |
| **Activity Indicator** | Multilingual verbs + elapsed time + live token count |
| **Subagent Blocks** | Nested agent execution tracking |
| **Model Picker** | Searchable overlay for switching models |
| **Permission Modes** | Shift+Tab cycles default → acceptEdits → bypassPermissions |

Falls back to the legacy pi-tui when Bun is not installed.

---

## AI Admin Agent

The admin bot supports natural language alongside wizard commands. Just type normally in the admin bot — no setup needed. Wizard commands (`/setup`, `/newagent`, etc.) still work as before, and `/claudecode` switches the chat into Claude Code mode (same runtime that agent bots use).

> "Create 3 agents: first one called Finance for personal finance with telegram token 123:ABC, second one called Dev for development with the github MCP server, third one called Writer with the writing personality template"

8 AI tools are automatically available to every admin agent:

| Tool | Actions | What it does |
|------|---------|-------------|
| `admin_agents` | list, create, update, delete | Full agent lifecycle with soul templates |
| `admin_config` | get, set, setup_provider | View/modify config, one-shot provider setup |
| `admin_mcp` | list, add, remove | Manage MCP servers (stdio/http/sse) |
| `admin_soul` | read, write | Read/write agent SOUL.md personality |
| `admin_bot` | status, start, stop, restart | Telegram bot lifecycle |
| `admin_sessions` | list, clear | View and bulk-delete sessions |
| `admin_usage` | — | Per-agent token usage and costs |
| `admin_pairing` | list, approve, deny | Manage user access requests |

---

## Features

| Feature | Description |
|---|---|
| Dual SDK Runtime | Claude Agent SDK + Cursor SDK, switchable per session |
| AI Admin Agent | Natural language agent management with admin tools |
| Claude Code via Telegram | Run Claude Code from your phone |
| Telegram Admin Bot | Create and manage agents |
| Telegram Agent Bots | One bot per agent |
| Discord Bots | Mention-based Discord support |
| Terminal UI | Rich TUI with tool renderers, diff views, streaming (Bun + OpenTUI) |
| Agent Memory | MEMORY.md + daily journals |
| Voice Transcription | Voice to text support |
| MCP Servers | External tool servers |
| Extended Thinking | Low / medium / high |
| Cron Jobs | Scheduled AI tasks |
| Usage Tracking | Cost + token monitoring |
| Agent Cloning | Duplicate agent config |
| Tool Approvals | Human approval flow |

For remote access, use [Tailscale](https://tailscale.com): `camel tailscale serve` or `camel tailscale funnel`.

---

## Channels

CamelAGI works across:

- Telegram
- Discord
- Terminal
- Claude Code via Telegram

All channels share the same runtime, tools, and memory.

---

## Admin Bot Commands

| Command | Description |
|---|---|
| `/setup` | Configure provider |
| `/newagent` | Create agent |
| `/agents` | List agents |
| `/agent` | Edit config |
| `/mcp` | Manage MCP servers |
| `/usage` | Usage summary |
| `/status` | System health |
| `/claudecode` | Switch chat into Claude Code mode |

---

## Agent Bot Commands

| Command | Description |
|---|---|
| `/clear` | Clear chat |
| `/compact` | Compact history |
| `/brief` | Toggle short replies |
| `/model` | Switch model |
| `/think` | Thinking depth |
| `/session` | Session info |
| `/usage` | Token usage |

---

## CLI Commands

```bash
camel <command>
```

| Command | Description |
|---|---|
| `setup` | Setup wizard |
| `serve` | Start server |
| `chat` | Terminal UI |
| `agents` | List agents |
| `config` | Edit config |
| `cron` | Manage cron jobs |
| `doctor` | Health checks |
| `update` | Update CamelAGI |

---

## Why CamelAGI vs OpenClaw

| | CamelAGI | OpenClaw |
|---|---|---|
| Runtime | Claude Agent SDK | pi-agent-core |
| Telegram Control | Native | Limited |
| Claude Code | Built-in | No |
| Memory | Two-tier markdown | Vector DB |
| Updates | Anthropic runtime improvements | Manual abstraction updates |

---

## Configuration

```yaml
provider: anthropic
model: claude-sonnet-4
telegramBotToken: "123456:ABC"

agents:
  coder:
    model: claude-sonnet-4
    thinkingLevel: medium
```

---

## Architecture

```text
Inbound message (TUI / REST / WS / Telegram)
→ SDK resolution (Claude or Cursor, sticky per session)
→ Queue check
→ Context load + compaction
→ Agent execution (Claude Agent SDK or Cursor SDK via gateway)
→ Tool use
→ Save session (with SDK tag)
```

---

## Documentation

- DOCS.md  
- GUIDE.md  
- featuresDocs/  

---

## License

MIT
