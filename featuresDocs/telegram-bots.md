# Telegram Bot System

CamelAGI runs a multi-bot Telegram architecture where a single process manages
multiple independent bots. There are two bot types: **admin bots** (control
plane) and **agent bots** (conversational AI). Each bot is backed by a grammY
`Bot` instance and operates via long-polling.

---

## Table of Contents

1. [Multi-Bot Architecture](#multi-bot-architecture)
2. [Bot Lifecycle](#bot-lifecycle)
3. [Admin Bot](#admin-bot)
4. [Agent Bot](#agent-bot)
5. [Draft Streaming](#draft-streaming)
6. [Group Support](#group-support)
7. [Agent Resolution](#agent-resolution)
8. [Duplicate Token Detection](#duplicate-token-detection)
9. [Polling with Retry and Backoff](#polling-with-retry-and-backoff)
10. [Per-Agent Configuration](#per-agent-configuration)
11. [Access Control and Pairing](#access-control-and-pairing)
12. [Config Examples](#config-examples)

---

## Multi-Bot Architecture

The system distinguishes between two bot roles defined per-agent in the YAML
config:

| Role | Flag | Purpose |
|------|------|---------|
| **Admin bot** | `admin: true` | Management control plane. Runs wizards, manages agents, views sessions, restarts bots. Does NOT handle AI conversations. |
| **Agent bot** | `admin: false` (default) | Conversational AI. Receives messages, runs the agent loop, streams responses back. |

Both types are grammY `Bot` instances stored in a shared `activeBots` map
(`Map<string, BotState>`), keyed by agent ID.

### BotState

Every running bot is tracked as a `BotState`:

```typescript
interface BotState {
  bot: Bot;
  botInfo: { id: number; username: string };
  runtimeModels: Map<number, string>; // per-chat model overrides
}
```

`runtimeModels` lets users switch models at runtime via `/model` without
touching the config file. Overrides reset on `/clear` or process restart.

### Entry Point

`src/telegram.ts` is the barrel module. `startTelegram(getConfig, getSystemPrompt)`
iterates over all agents in the config, instantiates the correct bot type for
each, and begins polling. It also handles a legacy path: if `config.telegram.botToken`
is set and no agent reuses the same token, it starts a legacy agent bot with the
ID `"telegram"`.

---

## Bot Lifecycle

### Start (Initial)

`startTelegram()` is called once at process boot. For each agent with a
`telegram.botToken`:

1. Duplicate token check (see [below](#duplicate-token-detection)).
2. If `agent.admin === true`, dynamically imports `setupAdminBot` and creates
   the admin bot.
3. Otherwise, calls `setupAgentBot` to create an agent bot.
4. The bot's `getMe()` is called to populate `botInfo`.
5. `startPolling(bot, label)` begins long-polling.

### Hot-Start

`startBot(agentId, botToken, getConfig, getSystemPrompt)` starts a single bot
after the process is already running. This is used by:

- The `/newagent` wizard (after admin approval).
- Config hot-reload.
- The `/restart` command.

A `startingBots` Set prevents double-starts. If a bot with the same ID is
already in `activeBots` or `startingBots`, the call throws.

### Stop

`stopBot(agentId)` stops polling, clears `runtimeModels`, and removes the bot
from `activeBots`. Returns `false` if the bot was not found.

### Restart

The admin bot's `/restart [agentId]` command calls `stopBot` then `startBot`.
Without an argument, it restarts all non-admin agent bots.

### Full Shutdown

`stopTelegram()` stops all bots, clears the `activeBots` map, and unregisters
the approval-forwarding bot.

---

## Admin Bot

**Source:** `src/telegram/admin-bot.ts`

The admin bot is a management interface. It does not run AI conversations.

### Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message with current API status and agent count. |
| `/help` | Lists all available commands grouped by category. |
| `/setup` | Launches the setup wizard (provider, API key, model). |
| `/newagent` | Launches the new-agent wizard. Requires API key to be set first. |
| `/agents` | Lists all agents with their status (running/stopped), model, and type. |
| `/deleteagent` | Shows inline keyboard to pick and confirm-delete an agent. Stops the bot and removes from config. Workspace files are preserved. |
| `/soul [id] [edit]` | View or edit an agent's `SOUL.md`. Without arguments, shows an inline keyboard to pick an agent. |
| `/config` | Without arguments: displays current config. With `<key> <value>`: updates config (supports dotted keys like `approvals.mode`). |
| `/sessions` | Lists the 15 most recent sessions with age, model, and message count. Shows inline buttons to bulk-delete sessions older than 1 day, 1 week, or 1 month. |
| `/status` | Shows provider, model, API key status, running/stopped bots, session count, and approval mode. |
| `/restart [id]` | Restarts a specific bot or all non-admin bots. |
| `/pairing` | Lists pending user access requests with Approve/Deny inline buttons. |
| `/cancel` | Cancels the currently active wizard. |

### Callback Queries

The admin bot handles several callback query patterns:

| Pattern | Action |
|---------|--------|
| `wizard:<stepId>:<value>` | Advances the active wizard with the selected value. |
| `picksoul:<action>:<id>` | Views or edits an agent's SOUL.md. |
| `pickdelete:<id>` | Shows a delete confirmation for the selected agent. |
| `confirm:delete:<id>` / `confirm:cancel:<id>` | Confirms or cancels agent deletion. |
| `clearsessions:<period>` | Deletes sessions older than 1d, 1w, or 1m. |
| `pairing:approve:<code>` / `pairing:deny:<code>` | Approves (generates OTP) or denies a user pairing request. |
| `botapproval:approve:<agentId>` / `botapproval:deny:<agentId>` | Approves and hot-starts a newly created agent bot, or denies it. |

### Wizards

Wizards are step-by-step conversational flows driven by the wizard engine
(`src/telegram/wizard.ts`). Each wizard is a `WizardDef` containing ordered
steps, validation, and an `onComplete` handler.

#### Wizard Engine

- Wizards are stored per-chat in a `Map<number, ActiveWizard>`.
- Each wizard has a 10-minute timeout. If the user stops responding, the wizard
  auto-cancels and notifies the user.
- Steps can have inline-button `options`, free-text input, `validate` functions,
  `transform` functions, and `skip` predicates.
- The `/cancel` command or timeout cancels the active wizard.
- Only one wizard can be active per chat at a time.

#### Setup Wizard (`/setup`)

Walks through:

1. **Provider** -- inline buttons: Anthropic, OpenAI, OpenRouter, Ollama, Custom.
2. **API Key** -- free text (skipped for Ollama).
3. **Base URL** -- free text (only for Custom provider).
4. **Model** -- free text or pick from preset list.

On completion, saves provider, model, API key, and base URL to the config file.

Provider presets are defined in `PRESETS`:

| Preset | Provider | Models |
|--------|----------|--------|
| anthropic | `anthropic` | claude-sonnet-4, claude-opus-4, claude-haiku-4 |
| openai | `openai` | gpt-4o, gpt-4o-mini, o3, o4-mini |
| openrouter | `openai` (with base URL) | Various cross-provider models |
| ollama | `openai` (localhost:11434) | llama3.3, qwen3, deepseek-r1, gemma3 |

#### New Agent Wizard (`/newagent`)

Walks through:

1. **Name** -- free text, required.
2. **Description** -- one line, written to the agent's `SOUL.md`.
3. **Model** -- "Use default" or "Change" (inline buttons).
4. **Custom model name** -- free text (skipped if default was chosen).
5. **Telegram bot token** -- free text or "Skip Telegram" button.

On completion:

- Generates a unique slug ID from the name (e.g. "Personal Finance" becomes `personalfinance`).
- Validates the bot token by calling `getMe` against the Telegram API.
- Seeds the agent workspace (creates directories and bootstrap files).
- Saves the agent config.
- If a bot token was provided, sends a bot-approval request with Approve/Deny
  buttons. The bot only starts polling after admin approval.

---

## Agent Bot

**Source:** `src/telegram/agent-bot.ts`

Agent bots handle AI conversations. Each agent bot runs the full orchestration
pipeline (agent loop, tool calls, streaming).

### Commands

| Command | Description |
|---------|-------------|
| `/start` | Greeting message. In groups, instructs to mention the bot. In DMs, shows the agent name and model. |
| `/help` | Lists commands and current model/thinking/maxTurns config. |
| `/clear` | Deletes the session and resets runtime model override for the chat. |
| `/status` | Shows agent name, model, thinking mode, message count, estimated token usage, and cumulative API usage. |
| `/model <name>` | Switches the model for the current chat at runtime. Does not persist across restarts. |
| `/compact` | Forces context compaction on the current session's history. |

### Message Handling

When a text message arrives:

1. **Group filtering** -- In groups with `mentionOnly` enabled, the bot only
   responds if the message mentions `@botUsername` or is a reply to one of
   the bot's messages.
2. **Mention stripping** -- `@botUsername` is removed from the message text.
3. **Empty check** -- If the cleaned text is empty, the message is ignored.
4. **Active run check** -- If a run is already active for this session, the
   message is queued via `queueOrProcess`.
5. **Orchestration** -- The message enters the full orchestration pipeline:
   - A `DraftStream` is created for live message editing.
   - Reactions are set on the user's message to indicate status:
     - `eyes` -- message received
     - `thinking_face` -- processing started
     - `wrench` -- tool call in progress
     - `thought_balloon` -- thinking/reasoning active
     - `lock` -- approval required
   - The `onEvent` callback routes `stream_text`, `chunk`, `tool_call`,
     `thinking`, `subagent_start`, and `approval_request` events.
   - For approval requests, an inline keyboard with Allow / Always / Deny
     buttons is sent.
6. **Response delivery** -- After orchestration completes:
   - If the response fits in the draft message (under 4096 chars), the draft
     is flushed as the final message.
   - If the response exceeds 4096 chars, the draft message is deleted and
     the response is sent via `sendChunked`.
   - If no draft message was created, `sendChunked` sends the full response.
7. **Error handling** -- On failure, the error message replaces the draft
   message text, or is sent as a new message.

### Approval Callback Queries

Agent bots handle tool-approval callbacks:

| Pattern | Action |
|---------|--------|
| `approve:<approvalId>:allow-once` | Allows the tool call once. |
| `approve:<approvalId>:allow-always` | Allows the tool and remembers for the session. |
| `approve:<approvalId>:deny` | Denies the tool call. |

### Session IDs

Sessions are scoped per-agent and per-chat:
- Legacy bot: `telegram-<chatId>`
- Named agent: `<agentId>-<chatId>`

---

## Draft Streaming

**Source:** `src/telegram/draft-stream.ts`

Draft streaming provides a "live typing" effect by repeatedly editing a single
Telegram message as the LLM generates tokens.

### How It Works

1. `createDraftStream(chatId, api, opts?)` returns a `DraftStream` with three
   methods: `update(text)`, `flush()`, and `getMessageId()`.
2. On the first `update()` call, once the text exceeds `minInitialChars`
   (default: 30 characters), a new message is sent via `sendMessage`.
3. Subsequent `update()` calls schedule a throttled `editMessageText` to
   avoid hitting Telegram rate limits.
4. `flush()` performs a final edit with the complete text.

### Throttling

- Default throttle interval: **1200ms** between edits.
- A timer tracks elapsed time since the last edit. If an update arrives before
  the throttle window expires, it is buffered and sent when the timer fires.
- Only the latest text is kept; intermediate states are dropped.
- Duplicate edits (same text) are skipped.

### Message Size Limit

All text is truncated to 4096 characters (Telegram's message limit) before
sending or editing. If the final response exceeds 4096 characters, the agent
bot deletes the draft message and re-sends via `sendChunked`, which splits
the response into multiple messages using the BlockChunker (800-3500 chars
per chunk, paragraph-break preference).

---

## Group Support

**Source:** `src/telegram/helpers.ts`

### Group Detection

`isGroupChat(chatType)` returns `true` for `"group"` and `"supergroup"` chat
types.

### Mention-Only Mode

When `mentionOnly` is `true` (the default for named agents), the bot only
responds in groups if:

- The message text contains `@botUsername`, OR
- The message is a direct reply to one of the bot's previous messages
  (checked via `reply_to_message.from.id === botId`).

All other messages in the group are silently ignored.

### Mention Stripping

Before processing, `stripMention(text, botUsername)` removes all occurrences of
`@botUsername` (case-insensitive) from the message text so the AI does not see
the mention as part of the user's question.

### Unauthorized Users in Groups

If an unauthorized user sends a message in a group, the bot silently ignores it
rather than replying with an access-denied message (to avoid noise in shared
groups).

---

## Agent Resolution

**Source:** `src/telegram/resolve.ts`

`resolveAgent(agentId, config, globalSystemPrompt, runtimeModel?)` produces a
`ResolvedAgent` object that merges agent-specific config with global defaults.
This is called on every message, so config changes take effect immediately
without restarting the bot.

### Resolution Rules

| Field | Named Agent | Legacy (`"telegram"`) |
|-------|-------------|----------------------|
| `name` | `agent.name` or falls back to `agentId` | `"CamelAGI"` |
| `model` | `runtimeModel` > `agent.model` > `config.model` | `runtimeModel` > `config.model` |
| `systemPrompt` | `buildSystemPrompt(agent.systemPrompt ?? config.systemPrompt, skills, agentId)` | `globalSystemPrompt` |
| `thinking` | `agent.thinking` > `config.thinking` | `config.thinking` |
| `effort` | `agent.effort` > `config.effort` | `config.effort` |
| `maxTurns` | `agent.maxTurns` > `config.maxTurns` | `config.maxTurns` |
| `allowedUsers` | `agent.telegram.allowedUsers` or `[]` | `config.telegram.allowedUsers` |
| `mentionOnly` | `agent.telegram.groups.mentionOnly` or `true` | `config.telegram.groups.mentionOnly` |

The runtime model override (set via `/model`) takes highest priority but only
persists in memory.

### ResolvedAgent Type

```typescript
interface ResolvedAgent {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  thinking: Config["thinking"];
  effort: Config["effort"];
  maxTurns: number;
  allowedUsers: number[];
  mentionOnly: boolean;
}
```

---

## Duplicate Token Detection

`startTelegram()` prevents two bots from polling with the same Telegram bot
token, which would cause a 409 Conflict error from the Telegram API.

The detection works in two passes:

1. **Collect agent tokens** -- All `agent.telegram.botToken` values are gathered
   into a Set.
2. **Legacy token check** -- The top-level `config.telegram.botToken` is only
   used if no agent already claims the same token.
3. **Agent loop** -- As each agent's token is processed, it is added to a
   `usedTokens` Set. If a subsequent agent has the same token, it is skipped
   with a console warning:
   ```
   [agentId] skipped -- duplicate bot token (already used by another agent)
   ```

---

## Polling with Retry and Backoff

**Source:** `src/telegram/helpers.ts` -- `startPolling(bot, label)`

Polling uses grammY's `bot.start()` with `drop_pending_updates: true` to
avoid processing messages that arrived while the bot was offline.

### Retry Strategy

If polling fails:

- **409 Conflict** (another instance polling the same token) or **network
  errors** (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `fetch failed`): retry
  after a delay with exponential backoff.
- **Other errors**: treated as fatal; logged but not retried.

### Backoff Parameters

| Parameter | Value |
|-----------|-------|
| Initial delay | 2,000 ms |
| Maximum delay | 30,000 ms |
| Backoff factor | 1.8x |

The delay resets to the initial value on successful connection (inside
`onStart`).

---

## Per-Agent Configuration

Each agent can override global defaults. The resolution chain is:
**runtime override > agent config > global config**.

### Configurable Fields per Agent

| Field | Description | Default |
|-------|-------------|---------|
| `name` | Display name shown in Telegram messages | Agent ID |
| `model` | LLM model identifier | Global `config.model` |
| `systemPrompt` | Custom system prompt (base, before skill injection) | Global `config.systemPrompt` |
| `thinking` | Thinking/reasoning mode (`"off"`, `"low"`, `"medium"`, `"high"`) | Global `config.thinking` |
| `effort` | Effort level | Global `config.effort` |
| `maxTurns` | Maximum agent loop turns | Global `config.maxTurns` |
| `telegram.botToken` | Telegram bot token from BotFather | Required |
| `telegram.allowedUsers` | Array of Telegram user IDs allowed to use this bot | `[]` (no restriction) |
| `telegram.groups.mentionOnly` | Only respond when mentioned in groups | `true` |
| `admin` | Whether this is an admin bot | `false` |

---

## Access Control and Pairing

Both admin and agent bots enforce access control when `allowedUsers` is
non-empty. The flow for unauthorized users:

1. User sends a message.
2. Bot checks `allowedUsers` (in-memory config, then file fallback).
3. If not found, a **pairing request** is created with a short code.
4. The admin bot is notified with Approve/Deny inline buttons.
5. On approval, a 5-digit OTP is generated. The user is prompted to enter it.
6. On successful OTP verification, the user is added to an in-memory
   `otpVerifiedUsers` set and gains access for the process lifetime.

In groups, unauthorized users are silently ignored (no access-denied replies).

---

## Config Examples

### Minimal: Single Agent Bot

```yaml
apiKey: sk-xxx
model: claude-sonnet-4-20250514
provider: anthropic

agents:
  assistant:
    name: Assistant
    telegram:
      botToken: "123456:ABC-DEF"
      allowedUsers: [12345678]
```

### Admin + Multiple Agents

```yaml
apiKey: sk-xxx
model: claude-sonnet-4-20250514
provider: anthropic

agents:
  admin:
    name: Admin
    admin: true
    telegram:
      botToken: "111111:ADMIN-TOKEN"
      allowedUsers: [12345678]

  coder:
    name: Coder
    model: claude-opus-4-20250514
    thinking: high
    systemPrompt: "You are a senior software engineer."
    telegram:
      botToken: "222222:CODER-TOKEN"
      allowedUsers: [12345678]

  writer:
    name: Writer
    model: gpt-4o
    effort: high
    telegram:
      botToken: "333333:WRITER-TOKEN"
      allowedUsers: [12345678]
      groups:
        mentionOnly: true
```

### Agent with Custom Provider

```yaml
apiKey: sk-or-xxx
model: anthropic/claude-sonnet-4-20250514
provider: openai
baseUrl: https://openrouter.ai/api/v1

agents:
  helper:
    name: Helper
    model: google/gemini-2.5-pro
    telegram:
      botToken: "444444:HELPER-TOKEN"
```

### Legacy Top-Level Telegram Config

This form is still supported but discouraged. The agent ID is `"telegram"` and
the session ID format is `telegram-<chatId>`.

```yaml
apiKey: sk-xxx
model: gpt-4o
provider: openai

telegram:
  botToken: "555555:LEGACY-TOKEN"
  allowedUsers: [12345678]
  groups:
    mentionOnly: true
```

---

## Source Files

| File | Purpose |
|------|---------|
| `src/telegram.ts` | Entry point, lifecycle management, active bot registry |
| `src/telegram/admin-bot.ts` | Admin bot setup, commands, callback queries, wizards |
| `src/telegram/agent-bot.ts` | Agent bot setup, commands, message handling, streaming |
| `src/telegram/resolve.ts` | Agent config resolution (merges agent + global config) |
| `src/telegram/draft-stream.ts` | Throttled live message editing for streaming responses |
| `src/telegram/helpers.ts` | Group detection, mention handling, chunked sending, polling with retry |
| `src/telegram/wizard.ts` | Generic wizard engine (step-by-step flows with timeout) |
| `src/telegram/wizards.ts` | Setup and new-agent wizard definitions, provider presets, token validation |
| `src/telegram/types.ts` | Shared types (`BotState`, `ResolvedAgent`) |
