# CamelAGI Configuration System

This document covers the complete configuration system: file format, schema, environment variable overrides, runtime mechanics, hot-reload, and provider-specific examples.

---

## Config File Location and Format

- **Path**: `~/.camelagi/config.yaml`
- **Format**: YAML, parsed with the `yaml` npm package (`parse` / `stringify`)
- **Source file**: `src/core/config.ts`

The config directory (`~/.camelagi/`) and file are created automatically on first run or when `saveConfig()` is called. If the file does not exist at load time, all values fall back to schema defaults.

---

## Complete Zod Schema Reference

### Top-Level Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | `"anthropic" \| "openai"` | `"anthropic"` | LLM provider identifier. |
| `model` | `string` | `"claude-sonnet-4-20250514"` | Model name passed to the provider. |
| `apiKey` | `string` | _(none)_ | API key for the configured provider. Optional in schema; typically set via env var. |
| `baseUrl` | `string` | _(none)_ | Custom base URL for the provider API. Used for OpenRouter, Ollama, or any OpenAI-compatible endpoint. |
| `systemPrompt` | `string` | `"You are CamelAGI, a helpful AI assistant. You have access to tools for running shell commands, reading/writing files, and fetching URLs. Use them when needed to help the user."` | Base system prompt. Bootstrap files are appended at runtime. |
| `thinking` | `"off" \| "low" \| "medium" \| "high"` | `"off"` | Extended thinking / chain-of-thought budget. |
| `effort` | `"low" \| "medium" \| "high" \| "max"` | `"high"` | Inference effort level. |
| `maxBudgetUsd` | `number` | _(none)_ | Optional spending cap in USD. |
| `maxTurns` | `number` | `25` | Maximum agent loop iterations per run. |
| `timeoutSeconds` | `number` | `300` | Per-run timeout (5 minutes). |
| `boot` | `boolean` | `true` | Whether to run BOOT.md on server start. |

### `serve` -- Gateway Server

| Field | Type | Default | Description |
|---|---|---|---|
| `serve.port` | `number` | `18789` | HTTP/WS listen port. |
| `serve.host` | `string` | `"127.0.0.1"` | Listen address. |
| `serve.token` | `string` | _(none)_ | Bearer token for API authentication. |
| `serve.rateLimit.windowMs` | `number` | `60000` | Rate limit sliding window in milliseconds. |
| `serve.rateLimit.max` | `number` | `60` | Max requests per window. |

### `telegram` -- Telegram Channel

| Field | Type | Default | Description |
|---|---|---|---|
| `telegram.botToken` | `string` | _(none)_ | Telegram bot token for the legacy top-level bot. |
| `telegram.allowedUsers` | `number[]` | `[]` | Telegram user IDs allowed to interact. Empty = no restriction. |
| `telegram.groups.mentionOnly` | `boolean` | `true` | In groups, only respond when mentioned. |
| `telegram.chats` | `Record<string, ChatOverride>` | `{}` | Per-chat overrides (see below). |

**ChatOverride fields** (all optional):
`name`, `model`, `systemPrompt`, `maxTurns`, `thinking` (`"off"|"low"|"medium"|"high"`), `effort` (`"low"|"medium"|"high"|"max"`).

### `compaction` -- Context Compaction

| Field | Type | Default | Description |
|---|---|---|---|
| `compaction.enabled` | `boolean` | `true` | Enable automatic context compaction. |
| `compaction.maxTokens` | `number` | `80000` | Token threshold (compaction triggers at 80% of this). |
| `compaction.keepTurns` | `number` | `6` | Number of recent turns preserved after compaction. |

### `tools` -- Tool Policy

| Field | Type | Default | Description |
|---|---|---|---|
| `tools.allow` | `string[]` | `[]` | Allowlist of tool names. Empty = allow all. |
| `tools.deny` | `string[]` | `[]` | Denylist of tool names. Checked after allowlist. |

### `skills` -- Skill Loader

| Field | Type | Default | Description |
|---|---|---|---|
| `skills.enabled` | `boolean` | `true` | Enable loading skills from `~/.camelagi/skills/`. |
| `skills.deny` | `string[]` | `[]` | Skill names to exclude. |

### `hooks` -- Lifecycle Hooks

| Field | Type | Default | Description |
|---|---|---|---|
| `hooks.enabled` | `boolean` | `false` | Enable lifecycle hooks from `~/.camelagi/hooks/`. |

### `approvals` -- Tool Approval System

| Field | Type | Default | Description |
|---|---|---|---|
| `approvals.mode` | `"off" \| "smart" \| "always"` | `"off"` | Approval mode. `smart` = only for destructive ops. |
| `approvals.allowlist` | `string[]` | `[]` | Tools that never require approval. |
| `approvals.timeoutSeconds` | `number` | `120` | How long to wait for an approval response. |
| `approvals.fallback` | `"deny" \| "allow"` | `"deny"` | Action on approval timeout. |
| `approvals.forwardTo` | `number` | _(none)_ | Telegram chat ID to forward approval requests to when running headless. |

### `retry` -- Error Retry

| Field | Type | Default | Description |
|---|---|---|---|
| `retry.maxRetries` | `number` | `3` | Maximum retry attempts on transient errors. |
| `retry.backoffMs` | `number` | `1000` | Base backoff delay in milliseconds (multiplied per attempt). |

### `lanes` -- Concurrency Lanes

| Field | Type | Default | Description |
|---|---|---|---|
| `lanes.main` | `number` | `3` | Max concurrent runs in the main lane. |
| `lanes.cron` | `number` | `1` | Max concurrent cron runs. |
| `lanes.subagent` | `number` | `5` | Max concurrent sub-agent runs. |

### `agents` -- Multi-Agent Definitions

Type: `Record<string, AgentDef>` -- Default: `{}`

Each agent entry has:

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | _(required)_ | Display name for the agent. |
| `admin` | `boolean` | `false` | Whether this agent has admin privileges. |
| `model` | `string` | _(none)_ | Override model for this agent. |
| `systemPrompt` | `string` | _(none)_ | Override system prompt. |
| `thinking` | `"off" \| "low" \| "medium" \| "high"` | _(none)_ | Override thinking level. |
| `effort` | `"low" \| "medium" \| "high" \| "max"` | _(none)_ | Override effort level. |
| `maxTurns` | `number` | _(none)_ | Override max turns. |
| `telegram` | `object` | _(none)_ | Telegram config for this agent (see below). |

**Agent telegram sub-object:**
- `botToken` (string, required) -- Separate bot token for this agent.
- `allowedUsers` (number[], default `[]`) -- Allowed user IDs.
- `groups.mentionOnly` (boolean, default `true`).

### `cron` -- Scheduled Jobs

Type: `CronJob[]` -- Default: `[]`

Each cron entry:

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | `string` | _(required)_ | Unique job identifier. |
| `name` | `string` | `""` | Human-readable name. |
| `schedule` | `string` | _(required)_ | Schedule expression: duration (`"5m"`, `"1h"`, `"1d"`), `*/N` cron (`"*/5 * * * *"`), one-shot relative (`"+20m"`), or ISO timestamp. See [Extensions docs](extensions.md#schedule-formats) for details and limitations. |
| `prompt` | `string` | _(required)_ | Prompt sent to the agent on each trigger. |
| `session` | `string` | _(none)_ | Session ID to use (optional, for context continuity). |
| `enabled` | `boolean` | `true` | Whether the job is active. |

---

## Environment Variable Overrides

Seven environment variables are recognized. They override values from the YAML file:

| Env Var | Overrides | Notes |
|---|---|---|
| `CAMELAGI_PROVIDER` | `provider` | |
| `CAMELAGI_MODEL` | `model` | |
| `ANTHROPIC_API_KEY` | `apiKey` | Takes priority over `OPENAI_API_KEY`. |
| `OPENAI_API_KEY` | `apiKey` | Only used if `ANTHROPIC_API_KEY` is **not** set. |
| `CAMELAGI_BASE_URL` | `baseUrl` | |
| `CAMELAGI_TOKEN` | `serve.token` | |
| `TELEGRAM_BOT_TOKEN` | `telegram.botToken` | |

The `.env` file is loaded automatically via `dotenv/config`.

---

## Config Precedence

Values are resolved in this order (later wins):

```
1. Zod schema defaults
2. ~/.camelagi/config.yaml (file config)
3. Environment variables (CAMELAGI_*, ANTHROPIC_API_KEY, etc.)
4. Runtime overrides (passed to loadConfig(overrides))
```

In code, `loadConfig()` builds a merged object:

```typescript
const merged = {
  ...fileConfig,          // from YAML
  ...envOverrides,        // from env vars
  ...overrides,           // from function argument
};
return schema.parse(merged);  // Zod fills in defaults for missing fields
```

Note: env vars for nested sections (`CAMELAGI_TOKEN` and `TELEGRAM_BOT_TOKEN`) are applied separately by merging into the existing `serve` / `telegram` sub-objects to avoid clobbering other nested fields.

---

## `loadConfig()` Mechanics

```typescript
export function loadConfig(overrides: Partial<Config> = {}): Config
```

1. If `~/.camelagi/config.yaml` exists, read and parse it as YAML. Otherwise start with `{}`.
2. Spread env var overrides on top of the file config.
3. Spread runtime `overrides` argument on top.
4. For `CAMELAGI_TOKEN`: merge into the existing `serve` sub-object (preserving `port`, `host`, `rateLimit`).
5. For `TELEGRAM_BOT_TOKEN`: merge into the existing `telegram` sub-object (preserving `allowedUsers`, `groups`, `chats`).
6. Pass the merged object through `schema.parse()` -- Zod validates and fills in all defaults.
7. Return the fully typed `Config` object.

---

## `saveConfig()` Mechanics

```typescript
export function saveConfig(values: Record<string, unknown>): void
```

1. Ensure `~/.camelagi/` exists (`mkdirSync` with `recursive: true`).
2. If `config.yaml` exists, read and parse the current contents.
3. Deep-merge the new `values` into the existing config (see deep merge behavior below).
4. Write the merged result back to `config.yaml` as YAML.
5. If an `onConfigSaved` callback is registered, call `loadConfig()` to produce a fresh `Config` (which re-applies env var overrides), then invoke the callback synchronously.

The `onConfigSaved` callback is used by `serve.ts` to immediately update the in-memory gateway state without waiting for the file-watcher debounce.

---

## Deep Merge Behavior

The `deepMerge(target, source)` function follows these rules:

- **Plain objects**: recursively merged (keys from source overwrite or add to target).
- **Arrays**: **replaced entirely**, not concatenated. If `source.tools.deny` is `["exec"]`, it replaces whatever was in `target.tools.deny`.
- **Scalars**: source value overwrites target value.
- **Null / undefined in source**: overwrites the target value (no special handling).

This means if you call `saveConfig({ tools: { deny: ["exec"] } })`, only `tools.deny` is changed; `tools.allow` is preserved because the deep merge recurses into the `tools` object. But arrays like `deny` are replaced wholesale.

---

## Hot-Reload (`watchConfig`)

Defined in `src/serve.ts`. The gateway watches for config changes at runtime.

```typescript
function watchConfig(
  _initialConfig: Config,
  onChange: (config: Config) => void,
): fs.FSWatcher | null
```

Key details:

- **Watches the directory** (`~/.camelagi/`), not the file directly. This ensures detection even if `config.yaml` is deleted and recreated (e.g., after a reset + onboarding flow).
- **Filters by filename**: only reacts when the changed file is `config.yaml`.
- **Debounced**: uses a 500ms `setTimeout` debounce to coalesce rapid writes.
- **On change**: calls `loadConfig()` (re-applies env vars and defaults), then invokes the `onChange` callback.
- **What `onChange` does in serve.ts**:
  - Updates `state.config` and `state.systemPrompt`.
  - Reconfigures concurrency lanes (`Lane.Main`, `Lane.Cron`, `Lane.Subagent`).
  - Updates cron context.
  - Reconciles Telegram bots (starts new agents, stops removed ones).
- **Error handling**: if `loadConfig()` throws (e.g., invalid YAML), the error is logged and the old config remains in effect.

---

## `ensureDirs()` -- Created Directories

Called at startup to guarantee the directory tree exists:

| Directory | Purpose |
|---|---|
| `~/.camelagi/` | Root config directory. |
| `~/.camelagi/sessions/` | Session history storage. |
| `~/.camelagi/workspace/` | Bootstrap files (AGENTS.md, SOUL.md, etc.). |
| `~/.camelagi/hooks/` | Lifecycle hook scripts. |
| `~/.camelagi/skills/` | User-defined skills. |
| `~/.camelagi/usage/` | Token usage tracking data. |
| `~/.camelagi/cron/` | Runtime cron job definitions. |
| `~/.camelagi/logs/` | Log files. |

All directories are created with `recursive: true`, so parent directories are created as needed.

---

## Provider-Specific Config Examples

### Anthropic (default)

```yaml
provider: anthropic
model: claude-sonnet-4-20250514
apiKey: sk-ant-...
```

Or via environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

No `baseUrl` needed -- the OpenAI SDK compatibility layer routes to `api.anthropic.com/v1/`.

### OpenAI

```yaml
provider: openai
model: gpt-4o
apiKey: sk-...
```

Or:

```bash
export CAMELAGI_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export CAMELAGI_MODEL=gpt-4o
```

### OpenRouter

```yaml
provider: openai
model: anthropic/claude-sonnet-4-20250514
apiKey: sk-or-...
baseUrl: https://openrouter.ai/api/v1
```

### Ollama (local)

```yaml
provider: openai
model: llama3
baseUrl: http://localhost:11434/v1
```

No `apiKey` needed for local Ollama.

### Custom OpenAI-Compatible Endpoint

```yaml
provider: openai
model: my-custom-model
apiKey: my-key
baseUrl: https://my-llm-proxy.example.com/v1
```

---

## Full Annotated Config Example

```yaml
# ── Provider ──────────────────────────────────────────────
provider: anthropic                     # "anthropic" | "openai"
model: claude-sonnet-4-20250514         # Model name
apiKey: sk-ant-...                      # API key (prefer env var instead)
# baseUrl: https://custom.api/v1       # Custom endpoint (optional)

# ── Prompt & Behavior ────────────────────────────────────
systemPrompt: "You are CamelAGI, a helpful AI assistant."
thinking: "off"                         # "off" | "low" | "medium" | "high"
effort: "high"                          # "low" | "medium" | "high" | "max"
# maxBudgetUsd: 5.0                    # Spending cap (optional)
maxTurns: 25                            # Max agent loop turns per run
timeoutSeconds: 300                     # Per-run timeout
boot: true                             # Run BOOT.md on server start

# ── Gateway Server ───────────────────────────────────────
serve:
  port: 18789
  host: "127.0.0.1"
  # token: "my-secret-token"           # Bearer auth (optional)
  rateLimit:
    windowMs: 60000                     # 1 minute window
    max: 60                             # 60 requests per window

# ── Telegram ─────────────────────────────────────────────
telegram:
  botToken: "123456:ABC..."             # Legacy top-level bot
  allowedUsers: [12345678]              # Allowed Telegram user IDs
  groups:
    mentionOnly: true                   # Only respond when @mentioned
  chats:                                # Per-chat overrides
    "-100123456789":
      name: "Dev Chat"
      model: claude-sonnet-4-20250514
      maxTurns: 10

# ── Compaction ───────────────────────────────────────────
compaction:
  enabled: true
  maxTokens: 80000                      # Triggers at 80% (~64K tokens)
  keepTurns: 6                          # Keep last 6 turns after compaction

# ── Tools ────────────────────────────────────────────────
tools:
  allow: []                             # Empty = allow all
  deny: []                              # e.g. ["exec"] to block shell

# ── Skills ───────────────────────────────────────────────
skills:
  enabled: true
  deny: []                              # e.g. ["risky-skill"]

# ── Hooks ────────────────────────────────────────────────
hooks:
  enabled: false

# ── Approvals ────────────────────────────────────────────
approvals:
  mode: "off"                           # "off" | "smart" | "always"
  allowlist: []                         # Tools that skip approval
  timeoutSeconds: 120
  fallback: "deny"                      # "deny" | "allow"
  # forwardTo: 12345678                 # Telegram chat for headless approvals

# ── Retry ────────────────────────────────────────────────
retry:
  maxRetries: 3
  backoffMs: 1000                       # Base delay, multiplied per attempt

# ── Concurrency Lanes ───────────────────────────────────
lanes:
  main: 3                              # Max concurrent main runs
  cron: 1                              # Max concurrent cron runs
  subagent: 5                          # Max concurrent sub-agent runs

# ── Agents (multi-bot) ──────────────────────────────────
agents:
  researcher:
    name: "Research Bot"
    admin: false
    model: claude-sonnet-4-20250514
    systemPrompt: "You are a research assistant."
    thinking: "medium"
    effort: "high"
    maxTurns: 15
    telegram:
      botToken: "654321:XYZ..."
      allowedUsers: [12345678]
      groups:
        mentionOnly: true

# ── Cron Jobs ────────────────────────────────────────────
cron:
  - id: daily-summary
    name: "Daily Summary"
    schedule: "1d"                       # every 24 hours (see extensions docs for cron limitations)
    prompt: "Summarize yesterday's activity."
    # session: "summary-session"        # Optional session for continuity
    enabled: true
```
