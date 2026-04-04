<p align="center">
  <img src="assets/logo-bg.png" alt="CamelAGI Logo" width="180" />
</p>

<h1 align="center">CamelAGI</h1>

<p align="center">
  <strong>Self-hosted AI agents controlled from Telegram.</strong><br>
  Run Claude Code, create agents, manage tools, and control everything from your phone.
</p>

<p align="center">
  Alternative to OpenClaw, built on Claude Agent SDK.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript" alt="TypeScript"></a>
  <a href="https://platform.claude.com/docs/en/agent-sdk/overview"><img src="https://img.shields.io/badge/Built%20with-Claude%20Agent%20SDK-orange?logo=anthropic" alt="Claude Agent SDK"></a>
  <a href="https://core.telegram.org/bots"><img src="https://img.shields.io/badge/Telegram-Admin%20Bot-26A5E4?logo=telegram" alt="Telegram"></a>
  <a href="https://camelagi.net"><img src="https://img.shields.io/badge/Website-camelagi.net-brown" alt="Website"></a>
</p>

<p align="center">
  <img src="assets/Claude_Logo.png" alt="Claude Logo" width="120" />
</p>

<p align="center">
  Powered by Claude Agent SDK — the same runtime behind Claude Code.
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

- Run Claude Code remotely from Telegram  
- Create and manage multiple AI agents  
- Self-hosted with full control  
- Built on Claude Agent SDK  
- Multi-provider support  
- Alternative to OpenClaw  

---

## Quick Start

> **Requirements:** Node.js 23+

| Install | Setup & Run | Update |
|:--------|:------------|:-------|
| `npm i -g camelagi` | `camel setup` | `camel update` |

<p align="center">
  <img src="assets/camelSetupTUI.gif" alt="CamelAGI Setup" width="700" />
</p>

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

Runs Claude Code directly on your machine, remote-controlled from Telegram.

```bash
npm i -g @anthropic-ai/claude-code
claude login
```

Then:

1. Open admin bot  
2. Send `/newagent`  
3. Select Claude Code mode  
4. Paste bot token  

---

## Features

| Feature | Description |
|---|---|
| Claude Code via Telegram | Run Claude Code from your phone |
| Telegram Admin Bot | Create and manage agents |
| Telegram Agent Bots | One bot per agent |
| Discord Bots | Mention-based Discord support |
| Terminal UI | Full TUI with streaming |
| Agent Memory | MEMORY.md + daily journals |
| Voice Transcription | Voice to text support |
| MCP Servers | External tool servers |
| Extended Thinking | Low / medium / high |
| Cron Jobs | Scheduled AI tasks |
| Usage Tracking | Cost + token monitoring |
| Agent Cloning | Duplicate agent config |
| Tool Approvals | Human approval flow |

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
Inbound message
→ Queue
→ Context load
→ Agent execution
→ Tool use
→ Save session
```

---

## Documentation

- DOCS.md  
- GUIDE.md  
- featuresDocs/  

---

## License

MIT
