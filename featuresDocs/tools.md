# CamelAGI Tools Documentation

CamelAGI provides a layered tool system: **built-in SDK tools** supplied by the Claude Agent SDK runtime, and **custom tools** defined as `ToolDef` objects within the CamelAGI codebase. Both categories are registered with the agent at startup and governed by a unified tool-policy mechanism.

---

## Table of Contents

1. [Overview](#overview)
2. [Built-in SDK Tools](#built-in-sdk-tools)
3. [Custom Tools](#custom-tools)
   - [apply_patch](#apply_patch)
   - [memory_search](#memory_search)
   - [memory_get](#memory_get)
   - [cron](#cron)
   - [subagent / subagent_list](#subagent--subagent_list)
4. [Tool Filtering (Allow / Deny)](#tool-filtering-allow--deny)
5. [Tool Policy Implementation](#tool-policy-implementation)
6. [Tool Adapter (Zod to JSON Schema)](#tool-adapter-zod-to-json-schema)
   - [Claude SDK Adapter](#claude-sdk-adapter-adapttooldef)
   - [OpenAI Adapter](#openai-adapter-adapttooldeftoopenai)
7. [How Tools Are Registered in the Agent](#how-tools-are-registered-in-the-agent)

---

## Overview

CamelAGI's agent has access to up to 13 tools at runtime:

| Tool             | Source       | Purpose                                      |
|------------------|--------------|----------------------------------------------|
| Read             | SDK built-in | Read file contents                           |
| Write            | SDK built-in | Create or overwrite files                    |
| Edit             | SDK built-in | Targeted string replacement in files         |
| Bash             | SDK built-in | Run shell commands                           |
| Glob             | SDK built-in | File pattern matching                        |
| Grep             | SDK built-in | Regex content search                         |
| WebSearch        | SDK built-in | Search the web                               |
| WebFetch         | SDK built-in | Fetch URLs / HTTP requests                   |
| Agent            | SDK built-in | Spawn subagents for subtasks                 |
| apply_patch      | Custom       | Multi-file diff patching                     |
| memory_search    | Custom       | Keyword search across memory files           |
| memory_get       | Custom       | Read a specific memory file                  |
| cron             | Custom       | Manage scheduled tasks at runtime            |

The built-in tools are declared in the `BUILTIN_TOOLS` array in `src/agent/agent-sdk.ts` and passed as `allowedTools` to the SDK's `query()` call. The custom tools are served through an MCP (Model Context Protocol) server created at runtime.

On the OpenAI-compatible path, custom tools are converted to OpenAI's function-calling format via `adaptToolDefToOpenAI()` and executed in a tool loop. Built-in SDK tools are not available on this path.

---

## Built-in SDK Tools

These tools are provided by the `@anthropic-ai/claude-agent-sdk` package. CamelAGI does not implement them; it simply enables them by name.

### Read

Reads the contents of a file from the local filesystem. Returns content with line numbers. Supports reading text files, images (multimodal), PDFs (page ranges), and Jupyter notebooks.

### Write

Creates a new file or overwrites an existing file with the provided content. The agent should prefer Edit for partial modifications.

### Edit

Performs exact string replacements within an existing file. Takes an `old_string` and `new_string` pair. The `old_string` must be unique within the file, or `replace_all` can be set to change every occurrence.

### Bash

Executes shell commands (bash) on the host machine. Commands run with a default timeout. The working directory persists between calls, but shell state (variables, aliases) does not.

### Glob

Fast file-pattern matching using glob syntax (e.g., `**/*.ts`, `src/**/*.md`). Returns matching file paths sorted by modification time. Preferred over `find` or `ls` for locating files by name.

### Grep

Regex-powered content search built on ripgrep. Supports multiple output modes (`content`, `files_with_matches`, `count`), glob filtering, file-type filtering, context lines, and multiline patterns. Preferred over shell `grep` or `rg` invocations.

### WebSearch

Searches the web and returns structured results with titles, URLs, and snippets. Used when the agent needs up-to-date information not available in the local codebase or memory.

### WebFetch

Fetches content from URLs via HTTP. Supports GET, POST, PUT, DELETE methods. Used for retrieving web pages, API responses, or downloading resources.

### Agent (Subagent)

Spawns a child agent in an isolated session to handle a subtask. The parent agent can delegate complex or independent work to subagents. Progress events (`subagent_start`, `subagent_progress`, `subagent_done`) are emitted so the TUI or gateway can track child-agent activity.

---

## Custom Tools

Custom tools are defined as `ToolDef` objects (see `src/core/types.ts`):

```typescript
interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodObject<any>;   // Zod schema for parameters
  execute: (args: Record<string, unknown>) => Promise<string>;
}
```

Each custom tool has a Zod schema that defines its parameters. Optional parameters use the `.nullable().optional()` pattern for OpenAI SDK compatibility.

---

### apply_patch

**Source:** `src/tools/patch.ts`

Applies multi-file patches to create, modify, or delete files in a single tool call. This is the most efficient tool for making coordinated changes across multiple files.

#### Patch Format

The patch uses a custom diff format with three operation types:

**Add File** -- creates a new file with the given content:

```
*** Add File: path/to/new.ts
+line 1
+line 2
+line 3
```

**Update File** -- modifies an existing file using context-anchored hunks:

```
*** Update File: path/to/existing.ts
@@ context line to locate the hunk
 unchanged line (space prefix)
-line to remove (minus prefix)
+line to add (plus prefix)
```

**Delete File** -- removes a file from disk:

```
*** Delete File: path/to/old.ts
```

Multiple operations can appear in a single patch. The patch can optionally be wrapped in a fenced code block (triple backticks) and/or `*** Begin Patch` / `*** End Patch` markers -- the parser strips both.

#### How It Works

1. **Parsing** (`parsePatch`): The raw patch string is split into lines. The parser iterates through, recognizing `*** Add File:`, `*** Update File:`, and `*** Delete File:` headers. For update operations, `@@ context` lines start new hunks, and `+`, `-`, and space-prefixed lines form the diff within each hunk.

2. **Chunk Application** (`applyChunks`): For update operations, each hunk is applied sequentially:
   - The **context line** (from `@@ ...`) is located in the file. The search first tries exact match, then falls back to trimmed (whitespace-insensitive) match.
   - The old lines (context + removed lines) are matched starting from the context position, searching forward first, then backward.
   - The matched range is spliced out and replaced with the new lines (context + added lines).

3. **Dry-Run Validation**: For multi-file patches, all update operations are validated before any writes happen. File contents are read, chunks are matched, and results are staged in memory. If any chunk fails to match, the entire patch is aborted before modifying any files.

4. **Atomic File Operations**: All file writes use atomic write (write to `.tmp.{pid}` file, then `rename()` over the target). This prevents partial writes if the process is interrupted.
   - **add**: Creates parent directories (`mkdirSync` recursive), atomic writes content, returns `A path`.
   - **delete**: Removes the file (`unlinkSync`), returns `D path`. Handles already-missing files gracefully.
   - **update**: Reads file, applies chunks, atomic writes result, returns `M path`.

5. **Rollback on Failure**: If any operation fails during the write phase, all previously-written files are restored to their original contents. This ensures multi-file patches are all-or-nothing.

#### Parameters

| Parameter | Type   | Required | Description                          |
|-----------|--------|----------|--------------------------------------|
| patch     | string | Yes      | The patch content in the format above |

---

### memory_search

**Source:** `src/tools/memory.ts`

Searches across `MEMORY.md` and all `memory/*.md` files for past decisions, facts, preferences, and notes. This is the primary tool for recalling prior context.

#### How It Works

1. **File Discovery** (`discoverMemoryFiles`): Scans the memory root directory for `MEMORY.md` and all `.md` files under the `memory/` subdirectory.

2. **Keyword Scoring**: The query is lowercased and split on whitespace into individual keywords. Each discovered file's content is split into paragraphs (separated by double newlines or heading markers `#`). For every paragraph, each keyword's occurrence count is summed to produce a score.

3. **Snippet Extraction**: Paragraphs with a score greater than zero are collected. Each result includes the file name, a snippet (first 500 characters of the paragraph), and the score.

4. **Ranking and Limiting**: Results are sorted by score (descending) and limited to `maxResults` (default: 6).

5. **Output Format**: Results are numbered and separated by `---` dividers:
   ```
   [1] memory/2026-03-09.md (score: 3)
   Paragraph snippet text...

   ---

   [2] MEMORY.md (score: 1)
   Another snippet...
   ```

#### Per-Agent Scoping

When an `agentId` is provided (e.g., for subagents or multi-agent setups), the memory tools are scoped to an agent-specific directory via `createScopedMemoryTools(rootDir)`. This means each agent searches only its own memory files, preventing cross-agent contamination. The global exports (`memorySearchTool`, `memoryGetTool`) use the default workspace directory for backward compatibility.

#### Parameters

| Parameter  | Type    | Required | Description                          |
|------------|---------|----------|--------------------------------------|
| query      | string  | Yes      | Search query (keywords or phrase)    |
| maxResults | number  | No       | Maximum results to return (default: 6) |

---

### memory_get

**Source:** `src/tools/memory.ts`

Reads the full content of a specific memory file. Typically used after `memory_search` to read the complete context of a matched file.

#### How It Works

1. **Path Validation**: Only accepts paths that are `MEMORY.md`, `memory.md`, or start with `memory/`. All other paths are rejected with an error directing the user to the `read` tool.

2. **Path Traversal Protection**: The resolved absolute path is checked to ensure it stays within the memory root directory.

3. **Line Slicing**: Supports optional `from` (1-indexed start line) and `lines` (count) parameters for reading specific sections of large files.

4. **Output Format**: Lines are returned with line numbers:
   ```
   1: # Memory
   2:
   3: ## Project Notes
   4: ...
   ```

#### Parameters

| Parameter | Type   | Required | Description                                              |
|-----------|--------|----------|----------------------------------------------------------|
| filePath  | string | Yes      | Relative path (e.g., `"MEMORY.md"`, `"memory/2026-03-09.md"`) |
| from      | number | No       | Starting line number, 1-indexed (default: 1)             |
| lines     | number | No       | Number of lines to read (default: all)                   |

---

### cron

**Source:** `src/tools/cron.ts`

Manages scheduled tasks (cron jobs) at runtime. The agent can set reminders, schedule recurring tasks, or manage existing jobs on behalf of the user.

#### Actions

**list** -- Show all cron jobs and their status:
- Displays job ID, name, schedule, source (config or runtime), enabled state, running state, last run time/status, and a preview of the prompt.

**add** -- Create a new scheduled job:
- Requires `schedule` and `prompt`.
- Optionally accepts `id` (auto-generated if omitted) and `name` (defaults to ID).
- The job is created via `addRuntimeJob()` from the cron extension.
- Returns a confirmation indicating whether the job is one-shot or repeating.

**remove** -- Delete a runtime-created job:
- Requires `id`.
- Only runtime-created jobs can be removed. Config-defined jobs must be removed by editing `config.yaml`.

**run** -- Trigger a job immediately:
- Requires `id`.
- Executes the job via `runJobNow()` and returns the first 500 characters of the response.

#### Schedule Formats

| Format                  | Type       | Example           | Description                              |
|-------------------------|------------|-------------------|------------------------------------------|
| `Ns`, `Nm`, `Nh`, `Nd` | Repeating  | `5m`, `1h`, `30s` | Runs every N seconds/minutes/hours/days  |
| Cron expression         | Repeating  | `*/5 * * * *`     | Standard 5-field cron expression         |
| `+Nm`, `+Nh`           | One-shot   | `+20m`, `+2h`     | Fires once after N minutes/hours, then auto-deletes |
| ISO 8601 timestamp      | One-shot   | `2026-03-14T09:00:00Z` | Fires once at the exact time, then auto-deletes |

#### Parameters

| Parameter | Type   | Required        | Description                                    |
|-----------|--------|-----------------|------------------------------------------------|
| action    | enum   | Yes             | `"list"`, `"add"`, `"remove"`, or `"run"`      |
| id        | string | For remove/run  | Job ID                                         |
| name      | string | No              | Display name (for add)                         |
| schedule  | string | For add         | Schedule expression (see formats above)        |
| prompt    | string | For add         | The message/task sent to the agent when the job fires |

---

### subagent / subagent_list

**Source:** SDK built-in (`Agent` tool in `BUILTIN_TOOLS`)

These are provided by the Claude Agent SDK's `Agent` tool rather than as custom `ToolDef` objects.

**subagent** (referred to as `Agent` in the SDK): Spawns a child agent in an isolated session. The child agent has its own conversation context and can use all available tools. This is useful for:
- Delegating independent subtasks (e.g., "research X while I work on Y")
- Isolating risky operations
- Parallel task execution

**subagent_list**: Lists all spawned subagents and their current status (started, in-progress, done).

The system prompt references these tools as `subagent` and `subagent_list` for the model's benefit, while the SDK registers them under the `Agent` tool name.

Events emitted during subagent execution:
- `subagent_start` -- a child agent has been spawned (includes `agentId` and `taskId`)
- `subagent_progress` -- periodic update with tool count and elapsed time
- `subagent_done` -- the child agent has completed its task

---

## Tool Filtering (Allow / Deny)

Tool access is controlled via the `tools` section in `~/.camelagi/config.yaml`:

```yaml
tools:
  allow: []    # If non-empty, ONLY these tools are allowed
  deny: []     # These tools are blocked (even if in allow list)
```

- **allow** (whitelist): When non-empty, only the listed tools are permitted. An empty array means "allow all."
- **deny** (blacklist): Any tool name in this list is blocked regardless of the allow list.

Both lists accept tool name strings matching the names used by the SDK and custom tools (e.g., `"Bash"`, `"apply_patch"`, `"cron"`).

This configuration is loaded from the Zod-validated config schema:

```typescript
tools: z.object({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
}).default(() => ({ allow: [], deny: [] })),
```

---

## Tool Policy Implementation

The tool policy flows from config to agent as follows:

1. **Config loading** (`src/core/config.ts`): The `tools.allow` and `tools.deny` arrays are parsed and validated by Zod.

2. **Orchestration** (`src/runtime/orchestrate.ts`): The config's `tools` object is passed to the agent as `toolPolicy`:
   ```typescript
   toolPolicy: config.tools,
   ```

3. **Agent options** (`src/agent/types.ts`): The `AgentOpts` interface carries the policy:
   ```typescript
   toolPolicy?: { allow: string[]; deny: string[] };
   ```

4. **SDK enforcement** (`src/agent/agent-sdk.ts`): The deny list is extracted and passed to the SDK as `disallowedTools`:
   ```typescript
   const disallowedTools = opts?.toolPolicy?.deny?.length
     ? opts.toolPolicy.deny
     : undefined;
   ```
   This is included in the `query()` options, causing the SDK to prevent the model from invoking those tools.

The allow list filtering is handled implicitly through the `allowedTools` array -- only tools listed in `BUILTIN_TOOLS` plus the MCP-served custom tools are available. If a more granular allow list is configured, it restricts this set further.

---

## Tool Adapter (Zod to JSON Schema)

**Source:** `src/agent/tool-adapter.ts`

The tool adapter bridges CamelAGI's `ToolDef` format (which uses Zod schemas) to both the Claude Agent SDK and OpenAI function-calling formats.

### Claude SDK Adapter (`adaptToolDef`)

```typescript
export function adaptToolDef(def: ToolDef) {
  return tool(
    def.name,
    def.description,
    def.schema.shape,
    async (args) => {
      const result = await def.execute(args as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );
}
```

- **Schema conversion**: The Zod schema's `.shape` property is passed directly to the SDK's `tool()`. The SDK accepts Zod shapes natively.
- **Result wrapping**: The `execute` function returns a plain string. The adapter wraps it in the SDK's expected format: `{ content: [{ type: "text", text: result }] }`.

### OpenAI Adapter (`adaptToolDefToOpenAI`)

```typescript
export function adaptToolDefToOpenAI(def: ToolDef): OpenAITool {
  const jsonSchema = def.schema.toJSONSchema();  // Zod 4 native
  delete jsonSchema.$schema;  // OpenAI doesn't want the $schema key
  return {
    type: "function",
    function: { name: def.name, description: def.description, parameters: jsonSchema },
  };
}
```

- **Schema conversion**: Uses Zod 4's built-in `.toJSONSchema()` method for reliable conversion to JSON Schema. The `$schema` meta-key is stripped since OpenAI's API rejects it.
- **Output format**: Returns OpenAI's `ChatCompletionTool` shape with `type: "function"` and `function.parameters` containing the JSON schema.
- **Used by**: The OpenAI-compatible agent path (`agent-openai.ts`) to register custom tools for function-calling.

Both adapters eliminate per-tool boilerplate. Adding a new custom tool requires only creating a `ToolDef` object — the adapters handle format conversion automatically.

---

## How Tools Are Registered in the Agent

The registration flow in `src/agent/agent-sdk.ts`:

1. **Collect custom tool definitions** (`getToolDefs`):
   ```typescript
   function getToolDefs(agentId?: string): ToolDef[] {
     const memRoot = agentMemoryDir(agentId);
     const scopedMemory = agentId
       ? createScopedMemoryTools(memRoot)
       : { search: memorySearchTool, get: memoryGetTool };
     return [scopedMemory.search, scopedMemory.get, patchTool, cronTool];
   }
   ```
   Memory tools are scoped per agent; patch and cron tools are shared.

2. **Create MCP server** (`createCamelAGIMcpServer`):
   ```typescript
   function createCamelAGIMcpServer(agentId?: string) {
     const defs = getToolDefs(agentId);
     return createSdkMcpServer({
       name: "camelagi",
       tools: defs.map(adaptToolDef),
     });
   }
   ```
   Each `ToolDef` is adapted via `adaptToolDef` and served through an MCP server named `"camelagi"`.

3. **Pass to SDK query**:
   ```typescript
   query({
     prompt: userMessage,
     options: {
       allowedTools: [...BUILTIN_TOOLS],          // SDK built-in tools
       mcpServers: { camelagi: mcpServer },       // Custom tools via MCP
       ...(disallowedTools && { disallowedTools }),// Denied tools
       // ...
     },
   });
   ```

4. **Hook integration**: Pre-tool and post-tool hooks are registered via `hooks.PreToolUse` and `hooks.PostToolUse` with a `".*"` matcher, so they fire for every tool call (both built-in and custom). These hooks handle:
   - Lifecycle hook scripts (`~/.camelagi/hooks/`)
   - Approval checks (smart/always mode)
   - Event emission for TUI and gateway consumers
   - Logging tool calls and results to stderr (in CLI mode)

### OpenAI-Compatible Path

The OpenAI path in `src/agent/agent-openai.ts` registers tools differently:

1. **Collect custom tool definitions**: Same `getToolDefs()` function returns `[memorySearchTool, memoryGetTool, patchTool, cronTool]`.
2. **Convert to OpenAI format**: Each `ToolDef` is converted via `adaptToolDefToOpenAI()` to the `{ type: "function", function: { name, description, parameters } }` format.
3. **Pass to API call**: Tools are included in `client.chat.completions.create({ tools, ... })`.
4. **Tool loop**: When the model returns `tool_calls`, each is executed through the same `ToolDef.execute()` function with pre/post hooks, and results are appended as `tool` role messages. The loop continues until no more tool calls or `maxTurns` is reached.

### Adding New Tools

Adding a new custom tool requires only:
1. Creating a `ToolDef` object in `src/tools/`.
2. Adding it to the array returned by `getToolDefs()`.

No other wiring is needed -- both the SDK (adapter, MCP server, hooks) and OpenAI (adapter, tool loop, hooks) paths handle the rest automatically.
