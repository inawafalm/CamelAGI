# CamelAGI Agent System

## Overview

The CamelAGI agent system uses a **dual-path architecture** that routes execution to one of two backends depending on the model being used:

1. **Claude Agent SDK path** (`agent-sdk.ts`) -- Full-featured agent with built-in tools, thinking/extended thinking, subagent spawning, MCP server integration, and approval gating. Used for Claude models.
2. **OpenAI-compatible path** (`agent-openai.ts`) -- Streaming chat completions via the OpenAI SDK. Works with any provider that exposes an OpenAI-compatible API (OpenAI, Anthropic compatibility layer, local models, etc.). Used for all non-Claude models.

Both paths share a common interface (`AgentOpts`, `RunResult`, `AgentEvent`) defined in `src/agent/types.ts`, so the rest of the system (TUI, gateway, Telegram channel) is backend-agnostic.

### File Map

| File | Purpose |
|------|---------|
| `src/agent.ts` | Entry point -- model detection, hooks, routing |
| `src/agent/agent-sdk.ts` | Claude SDK path (tools, thinking, subagents) |
| `src/agent/agent-openai.ts` | OpenAI-compatible streaming path |
| `src/agent/types.ts` | Shared types: `AgentOpts`, `RunResult`, `AgentEvent` |
| `src/agent/tool-adapter.ts` | Converts `ToolDef` to Claude SDK `tool()` calls |
| `src/extensions/hooks.ts` | Lifecycle hook runner |
| `src/extensions/approvals.ts` | Approval gating for dangerous tools |

---

## Path Selection

The entry point `runAgent()` in `src/agent.ts` decides which backend to use with a simple check:

```typescript
function isClaudeModel(model: string): boolean {
  return model.startsWith("claude-") || model.includes("/claude-");
}

const useSdk = isClaudeModel(model) && !opts?.baseUrl;
```

**Rules:**
- If the model name starts with `"claude-"` or contains `"/claude-"` **and** no custom `baseUrl` is set, the Claude SDK path is used.
- Everything else (GPT-4, Llama, Mistral, Gemini, or Claude with a custom base URL) goes through the OpenAI-compatible path.
- Setting a custom `baseUrl` forces the OpenAI path even for Claude models, which is useful for proxies or alternative endpoints.

---

## Think-Act Loop

### Claude SDK Path

The SDK path delegates the think-act loop to the Claude Agent SDK's `query()` function. It operates as an agentic loop internally:

1. The model receives the prompt and system instructions.
2. It generates a response, which may include tool calls.
3. Tools are executed (with pre/post hooks and approval checks).
4. Results are fed back to the model.
5. The loop continues until the model produces a final text response or `maxTurns` is reached.

The loop is configured via:

```typescript
const q = query({
  prompt: userMessage,
  options: {
    model,
    systemPrompt: effectiveSystemPrompt,
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep",
                   "WebSearch", "WebFetch", "Agent"],
    mcpServers: { camelagi: mcpServer },
    maxTurns: opts?.maxTurns ?? 25,  // DEFAULT_MAX_TURNS
    permissionMode: "bypassPermissions",
    thinking,
    // ...
  },
});
```

The result is consumed as an async iterator, yielding `result`, `system`, and `stream_event` messages.

### OpenAI-Compatible Path

The OpenAI path implements a full tool loop using OpenAI's function-calling API:

1. History and the new user message are assembled into a messages array.
2. Custom tools (`memory_search`, `memory_get`, `apply_patch`, `cron`) are converted to OpenAI function-calling format using `adaptToolDefToOpenAI()` (Zod 4's native `.toJSONSchema()`).
3. A streaming `chat.completions.create()` call is made with `tools` parameter.
4. Streamed deltas are accumulated for both content and tool calls (arguments arrive as chunks that are concatenated).
5. If the response contains `tool_calls`, each tool is executed with pre/post hooks (`before_tool`, `after_tool`), results are appended as `tool` messages, and the loop continues.
6. The loop runs until the model returns a response with no tool calls, or `maxTurns` is reached.
7. If the last message is a tool result and no final text was produced, one more call is made without tools to get a summary.

This path does not support thinking, subagents, or approval gating -- but it provides full tool execution, hooks, and streaming for any OpenAI-compatible provider (OpenAI, DeepSeek, Ollama, OpenRouter, etc.).

---

## Agent Events

All events are emitted via the `onEvent` callback in `AgentOpts`. The TUI, gateway, and Telegram channel consume these to render output.

| Event Type | Fields | Description | Path |
|------------|--------|-------------|------|
| `tool_call` | `id`, `name`, `args` | A tool is about to be executed | Both |
| `tool_result` | `id`, `name`, `preview` | A tool finished; `preview` is first 150 chars of output | Both |
| `chunk` | `text` | Final complete response text | Both |
| `stream_text` | `text` | Incremental text delta (streaming) | Both |
| `thinking` | `state: "start" \| "end"` | Extended thinking block boundary | SDK |
| `thinking_delta` | `text` | Incremental thinking text delta | SDK |
| `init` | `sessionId` | SDK session initialized with an ID | SDK |
| `subagent_start` | `agentId`, `taskId?` | A subagent task was spawned | SDK |
| `subagent_progress` | `agentId`, `toolCount?`, `duration?` | Subagent progress update | SDK |
| `subagent_done` | `agentId`, `toolUseId?` | Subagent task completed | SDK |
| `usage` | `inputTokens`, `outputTokens`, `cacheReadTokens?`, `cacheWriteTokens?` | Token usage report | Both |
| `approval_request` | `id`, `toolName`, `preview` | Tool call requires user approval | SDK |
| `approval_resolved` | `id`, `decision` | Approval decision was made | SDK |

### Event Type Definition

```typescript
export type AgentEvent =
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; preview: string }
  | { type: "chunk"; text: string }
  | { type: "stream_text"; text: string }
  | { type: "thinking"; state: "start" | "end" }
  | { type: "thinking_delta"; text: string }
  | { type: "init"; sessionId: string }
  | { type: "subagent_start"; agentId: string; taskId?: string }
  | { type: "subagent_progress"; agentId: string; toolCount?: number; duration?: number }
  | { type: "subagent_done"; agentId: string; toolUseId?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number;
      cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: "approval_request"; id: string; toolName: string; preview: string }
  | { type: "approval_resolved"; id: string; decision: string };
```

---

## Tool Policy (Allow/Deny Filtering)

The `toolPolicy` option lets you restrict which tools the agent can use:

```typescript
interface AgentOpts {
  toolPolicy?: { allow: string[]; deny: string[] };
  // ...
}
```

### How It Works

- **SDK path:** The `deny` list is passed as `disallowedTools` to the SDK's `query()` options. The SDK itself enforces the restriction.
- **OpenAI path:** All custom tools are registered via `adaptToolDefToOpenAI()`. The tool policy `deny` list is not yet enforced on this path (planned improvement).

### Configuration Example

```yaml
# In ~/.camelagi/config.yaml
tools:
  allow: []         # empty = allow all (default)
  deny:
    - Bash          # prevent shell execution
    - Write         # prevent file writes
```

### Built-in Tools (SDK Path)

The SDK path exposes these built-in tools:

| Tool | Description |
|------|-------------|
| `Read` | Read file contents |
| `Write` | Write/create files |
| `Edit` | Edit existing files |
| `Bash` | Execute shell commands |
| `Glob` | File pattern matching |
| `Grep` | Content search (ripgrep) |
| `WebSearch` | Web search |
| `WebFetch` | Fetch web pages |
| `Agent` | Spawn a subagent |

Additionally, custom tools are registered via an MCP server:

| Custom Tool | Description |
|-------------|-------------|
| `memory_search` | Full-text search across memory files |
| `memory_get` | Read a specific memory file |
| `patch` | Apply unified diff patches |
| `cron` | Schedule recurring tasks |

---

## Hooks Integration

Lifecycle hooks are shell scripts or JS handlers placed in `~/.camelagi/hooks/`. They fire at four points in the agent lifecycle.

### Hook Points

| Hook Point | When It Fires | Context Variables |
|------------|---------------|-------------------|
| `before_prompt` | Before the user message is sent to the model | `CAMELAGI_HOOK_SESSION`, `CAMELAGI_HOOK_MESSAGE` |
| `after_response` | After the model returns a final response | `CAMELAGI_HOOK_SESSION`, `CAMELAGI_HOOK_RESPONSE` |
| `before_tool` | Before a tool is executed (both paths) | `CAMELAGI_HOOK_SESSION`, `CAMELAGI_HOOK_TOOL`, `CAMELAGI_HOOK_TOOL_ARGS` |
| `after_tool` | After a tool finishes (both paths) | `CAMELAGI_HOOK_SESSION`, `CAMELAGI_HOOK_TOOL`, `CAMELAGI_HOOK_TOOL_RESULT` |

### Hook Execution

- `before_prompt` and `after_response` run in the main `runAgent()` entry point (both paths).
- `before_tool` and `after_tool` run in the SDK path's `PreToolUse`/`PostToolUse` callbacks, and in the OpenAI path's tool loop before/after each tool execution.
- Hooks are executed synchronously via `execSync` with a 10-second timeout (`HOOK_TIMEOUT_MS`).
- Hook failures are logged to stderr but do not abort the agent.
- Hooks are only active when `opts.hooksEnabled` is `true`.

### File Naming Convention

```
~/.camelagi/hooks/{point}.{name}.sh
~/.camelagi/hooks/{point}.{name}.js
```

Examples:
```
before_tool.log.sh          # log every tool call
after_response.notify.sh    # send a notification after response
before_prompt.validate.js   # validate user input
```

### Configuration

```yaml
# In ~/.camelagi/config.yaml
hooks:
  enabled: true   # default: false
```

---

## Abort and Timeout Handling

### AbortSignal

Both paths support cancellation via `AbortSignal`:

```typescript
interface AgentOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  // ...
}
```

**SDK path:** The signal is bridged to an `AbortController` that is passed to the SDK:

```typescript
const abortController = opts?.signal ? new AbortController() : undefined;
if (opts?.signal && abortController) {
  if (opts.signal.aborted) abortController.abort();
  else opts.signal.addEventListener("abort", () => abortController.abort(), { once: true });
}
```

**OpenAI path:** The signal is checked before the request and after every streamed chunk:

```typescript
if (opts?.signal?.aborted) throw new Error("Aborted");
// ... inside the stream loop:
if (opts?.signal?.aborted) throw new Error("Aborted");
```

### Timeout Composition

The caller typically creates a combined signal using `AbortSignal.any()`:

```typescript
const signals = [userAbortSignal];
if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
const combined = AbortSignal.any(signals);
```

This allows both user-initiated abort (e.g., pressing Escape in TUI) and timeout-based abort to work through the same mechanism.

---

## Thinking and Effort Modes

Extended thinking lets Claude show its reasoning process before producing a final answer.

### Thinking Configuration

```typescript
interface AgentOpts {
  thinking?: string;           // "off" | any other value enables adaptive thinking
  effort?: "low" | "medium" | "high" | "max";
  // ...
}
```

**How thinking is applied (SDK path only):**

```typescript
const thinking = opts?.thinking && opts.thinking !== "off"
  ? { type: "adaptive" as const }
  : { type: "disabled" as const };
```

- When `thinking` is set to anything other than `"off"`, adaptive thinking is enabled. The model decides when and how much to think.
- When `thinking` is `"off"` or unset, thinking is disabled entirely.

**Effort mode** controls how much computation the model uses:

| Effort | Behavior |
|--------|----------|
| `low` | Quick, minimal reasoning |
| `medium` | Balanced (default when not specified) |
| `high` | Thorough reasoning |
| `max` | Maximum effort, most thorough |

### Thinking Events

When thinking is active, the TUI receives these events to display thinking state:

```
thinking { state: "start" }     -- thinking block begins
thinking_delta { text: "..." }  -- incremental thinking text
thinking { state: "end" }       -- thinking block ends
stream_text { text: "..." }     -- final answer text
```

### Configuration Example

```yaml
# In ~/.camelagi/config.yaml
thinking: "adaptive"   # enable extended thinking
effort: "high"         # use high effort mode
```

---

## Subagent Spawning (SDK Path Only)

The Claude SDK path supports spawning subagents via the built-in `Agent` tool. Subagents are independent agent instances that execute a subtask and return results.

### How It Works

1. The main agent calls the `Agent` tool with a prompt.
2. The SDK spawns a child agent with its own tool access and turn budget.
3. The parent agent receives progress updates and the final result.

### Subagent Events

Three events track subagent lifecycle:

| Event | Fields | Description |
|-------|--------|-------------|
| `subagent_start` | `agentId`, `taskId?` | Subagent task created |
| `subagent_progress` | `agentId`, `toolCount?`, `duration?` | Periodic progress (tool count, elapsed time) |
| `subagent_done` | `agentId`, `toolUseId?` | Subagent completed its task |

These are derived from SDK system messages:

```typescript
if (sysMsg.subtype === "task_started") {
  emit({ type: "subagent_start", agentId: sysMsg.agent_id ?? "subagent", taskId: sysMsg.task_id });
}
```

### Scoped Memory

Each subagent gets its own scoped memory directory. When `agentId` is provided, memory tools read/write to an agent-specific subdirectory:

```typescript
function getToolDefs(agentId?: string): ToolDef[] {
  const memRoot = agentMemoryDir(agentId);
  const scopedMemory = agentId
    ? createScopedMemoryTools(memRoot)
    : { search: memorySearchTool, get: memoryGetTool };
  return [scopedMemory.search, scopedMemory.get, patchTool, cronTool];
}
```

---

## Approval Integration

The approval system gates dangerous tool calls behind user confirmation. It operates within the SDK path's `PreToolUse` hook.

### Approval Modes

| Mode | Behavior |
|------|----------|
| `off` | No approval required (default) |
| `smart` | Auto-approve read-only tools; ask for writes, exec, and agents |
| `always` | Ask for every tool call |

### Read-Only Tools (Auto-Approved in Smart Mode)

```
Read, Glob, Grep, WebSearch, WebFetch, memory_search, memory_get
```

### Approval Flow

```
Tool call triggered
    |
    v
checkApproval(toolName, args, mode, allowlist)
    |
    |-- mode is "off"? --> execute immediately
    |-- in allowlist?   --> execute immediately
    |-- mode is "smart" and tool is read-only? --> execute immediately
    |
    v
Emit approval_request event
    |
    v
waitForDecision(id, timeoutMs, fallback)
    |
    |-- "allow-once"   --> execute this time
    |-- "allow-always" --> execute + add to allowlist
    |-- "deny"         --> block with reason
    |-- timeout        --> use fallback (deny or allow)
```

### Approval Forwarding

When no direct approval channel is available (e.g., headless gateway mode), approvals can be forwarded to a Telegram user:

```typescript
approvals?: {
  mode: ApprovalMode;
  allowlist: string[];
  timeoutSeconds: number;
  fallback: "deny" | "allow";
  forwardTo?: number;           // Telegram user ID
};
```

### Allowlist Patterns

The allowlist supports glob patterns for fine-grained control:

| Pattern | Matches |
|---------|---------|
| `Read` | All Read tool calls |
| `Bash:git *` | Bash commands starting with `git` |
| `Write:/path/to/file.ts` | Writing to a specific file |
| `Edit:/src/*` | Editing any file under `/src/` |
| `apply_patch:*` | All patch operations |

### Configuration Example

```yaml
# In ~/.camelagi/config.yaml
approvals:
  mode: smart
  allowlist:
    - Read
    - Glob
    - Grep
    - "Bash:git *"
    - "Bash:npm *"
  timeoutSeconds: 120
  fallback: deny
  forwardTo: 123456789  # Telegram user ID (optional)
```

---

## Tool Adapter

The `tool-adapter.ts` module bridges CamelAGI's `ToolDef` interface to both the Claude Agent SDK and OpenAI function-calling formats:

**Claude SDK adapter** (`adaptToolDef`):
```typescript
export function adaptToolDef(def: ToolDef) {
  return tool(
    def.name,
    def.description,
    def.schema.shape,           // Zod shape -> SDK params
    async (args) => {
      const result = await def.execute(args as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );
}
```

**OpenAI adapter** (`adaptToolDefToOpenAI`):
```typescript
export function adaptToolDefToOpenAI(def: ToolDef): OpenAITool {
  const jsonSchema = def.schema.toJSONSchema();  // Zod 4 native
  delete jsonSchema.$schema;
  return {
    type: "function",
    function: { name: def.name, description: def.description, parameters: jsonSchema },
  };
}
```

Both adapters eliminate per-tool boilerplate. Any `ToolDef` is automatically converted to the appropriate format. The OpenAI adapter uses Zod 4's built-in `.toJSONSchema()` method for reliable schema conversion.

---

## Configuration Reference

### AgentOpts Interface

```typescript
export interface AgentOpts {
  maxTurns?: number;          // Max think-act iterations (default: 25)
  signal?: AbortSignal;       // Cancellation signal
  onEvent?: (event: AgentEvent) => void;  // Event callback
  timeoutMs?: number;         // Timeout in milliseconds
  toolPolicy?: {              // Tool allow/deny lists
    allow: string[];
    deny: string[];
  };
  hooksEnabled?: boolean;     // Enable lifecycle hooks
  sessionId?: string;         // Session ID for hooks/usage tracking
  thinking?: string;          // "off" to disable, anything else enables adaptive
  effort?: "low" | "medium" | "high" | "max";  // Reasoning effort level
  resumeSessionId?: string;   // Resume a previous SDK session
  maxBudgetUsd?: number;      // Max spend for this run (SDK only)
  agentId?: string;           // Agent ID for scoped memory
  provider?: string;          // Provider hint ("openai", "anthropic")
  baseUrl?: string;           // Custom API base URL
  approvals?: {               // Approval gating config
    mode: ApprovalMode;       // "off" | "smart" | "always"
    allowlist: string[];      // Pre-approved tool patterns
    timeoutSeconds: number;   // How long to wait for a decision
    fallback: "deny" | "allow";  // Default if timeout
    forwardTo?: number;       // Telegram user ID for forwarding
  };
}
```

### RunResult Interface

```typescript
export interface RunResult {
  response: string;           // Final text response
  newMessages: Message[];     // User + assistant messages to append to history
  usage: TokenUsage | null;   // Token usage (may be null)
  sessionId?: string;         // SDK session ID (for resume)
}
```

### YAML Configuration Examples

**Minimal (defaults):**

```yaml
model: claude-sonnet-4-20250514
apiKey: sk-ant-...
```

**Full-featured:**

```yaml
model: claude-sonnet-4-20250514
apiKey: sk-ant-...
maxTurns: 30
timeoutSeconds: 300
thinking: adaptive
effort: high

tools:
  allow: []
  deny:
    - Agent            # disable subagent spawning

hooks:
  enabled: true

approvals:
  mode: smart
  allowlist:
    - Read
    - Glob
    - Grep
    - "Bash:git *"
  timeoutSeconds: 120
  fallback: deny
```

**OpenAI-compatible provider:**

```yaml
model: gpt-4o
apiKey: sk-...
provider: openai
# Tools (memory, patch, cron) work via function-calling
# No thinking or subagents
```

**Custom base URL (forces OpenAI path even for Claude models):**

```yaml
model: claude-sonnet-4-20250514
apiKey: sk-ant-...
baseUrl: https://my-proxy.example.com/v1
# Uses OpenAI-compatible path because baseUrl is set
# Custom tools available via function-calling
```

---

## Session Resume (SDK Path Only)

The SDK path supports resuming a previous session. When `resumeSessionId` is provided:

- History is **not** prepended to the prompt (the SDK already has it).
- The SDK resumes from the previous session state.

When not resuming, history is prepended to the user prompt wrapped in structured tags (keeping the system prompt clean and constant-size):

```typescript
if (!opts?.resumeSessionId && history.length > 0) {
  const historyText = history.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
  effectivePrompt = `<previous_conversation>\n${historyText}\n</previous_conversation>\n\n${userMessage}`;
}
```

This approach avoids bloating the system prompt with conversation history, which would waste tokens on every turn and grow quadratically.

The returned `RunResult.sessionId` can be stored and passed as `resumeSessionId` in a subsequent call.

---

## Environment Notes

- The agent entry point deletes `process.env.CLAUDECODE` to prevent "nested session" errors when running inside Claude Code.
- The SDK path sets `permissionMode: "bypassPermissions"` and `allowDangerouslySkipPermissions: true` because CamelAGI handles permissions through its own approval system.
- The working directory is set to `process.cwd()` for the SDK, so file tools operate relative to where CamelAGI was launched.
- Token usage is recorded per-session via `recordUsage()` for both paths when a `sessionId` is available.
