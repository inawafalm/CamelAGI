# CamelAGI Extensions

CamelAGI ships with five extension systems that add automation, safety, and customization on top of the core agent loop. Each extension is optional and can be configured independently through `~/.camelagi/config.yaml`.

---

## Table of Contents

1. [Compaction](#compaction)
2. [Cron Jobs](#cron-jobs)
3. [Skills](#skills)
4. [Hooks](#hooks)
5. [Approvals](#approvals)

---

## Compaction

**Source:** `src/runtime/compact.ts`

Compaction prevents the conversation context from exceeding the model's token window by automatically summarizing older messages and flushing durable facts to memory files.

### How It Works

1. **Token estimation** -- After each turn, the total token count is estimated using a 4-characters-per-token heuristic (`CHARS_PER_TOKEN = 4`).

2. **Trigger threshold** -- Compaction fires when the estimated token count reaches **80%** of the configured `maxTokens` (`COMPACTION_TRIGGER_RATIO = 0.8`).

3. **History split** -- The conversation is divided into two parts:
   - **Old messages** -- everything before the last `keepTurns` user turns.
   - **Recent messages** -- the last `keepTurns` turns (default 6), preserved verbatim.
   - A "turn" boundary is defined by each `user` role message.
   - If there are fewer turns than `keepTurns`, compaction is skipped (nothing old enough to summarize).

4. **Memory flush** -- Before summarizing, the old messages are sent to the model with a dedicated prompt that extracts durable facts (decisions, preferences, file paths, dates). The extracted bullets are appended to a daily memory file at `~/.camelagi/workspace/memory/YYYY-MM-DD.md` under a timestamped `## HH:MM:SS (auto-flush)` heading. If the combined text of old messages is shorter than 200 characters, the flush is skipped (nothing worth extracting). The input is capped at 30,000 characters (`MEMORY_FLUSH_MAX_CHARS`). If the model returns `"NOTHING"` or fewer than 10 characters, nothing is written. Memory flush is best-effort; failures are silently ignored.

5. **Summarize** -- The old messages are then summarized by the model. The summary replaces the old messages as a single `user` message wrapped in `[Previous conversation summary]` / `[End of summary — conversation continues below]` markers.

6. **Validation** -- After summarization, the compacted result is compared against the original. If the compacted history's estimated token count is **not smaller** than the original, compaction is **skipped** with a warning to stderr: `"⚠ Compaction skipped: result (X tokens) >= original (Y tokens)"`. This prevents pathological cases where the summary is longer than the input.

7. **Result** -- The compacted history is `[summary message, ...recent messages]`, significantly reducing token count while preserving context.

### Configuration

```yaml
compaction:
  enabled: true       # Enable/disable automatic compaction (default: true)
  maxTokens: 100000   # Token budget; compaction triggers at 80% of this value
  keepTurns: 6         # Number of recent user turns to preserve verbatim
```

### Manual Trigger

- **TUI:** Type `/compact` to trigger compaction immediately regardless of token count.
- **API:** The gateway exposes compaction through the session management endpoints.

---

## Cron Jobs

**Source:** `src/extensions/cron.ts`

Cron jobs let you schedule recurring or one-shot agent runs. They execute the agent with a configured prompt, save the conversation to a dedicated session, and support error backoff.

### Two Sources of Jobs

| Source | Location | Mutability |
|--------|----------|------------|
| **Config-defined** | `config.yaml` under `cron:` array | Read-only at runtime |
| **Runtime-defined** | `~/.camelagi/cron/jobs.json` | Full CRUD via tools and CLI |

Runtime jobs are persisted to `~/.camelagi/cron/jobs.json` (JSON format with `version` and `jobs` array). They survive server restarts.

### Job Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Unique identifier |
| `name` | string | Human-readable name |
| `schedule` | string | Schedule expression (see formats below) |
| `prompt` | string | The message sent to the agent |
| `session` | string? | Session ID (defaults to `cron-{id}`) |
| `enabled` | boolean | Whether the job is active |
| `deleteAfterRun` | boolean? | Auto-remove after one-shot execution (default `true` for one-shots) |

### Schedule Formats

**Repeating interval:**

```
5m      # every 5 minutes
1h      # every hour
1d      # every day
30s     # every 30 seconds
```

Supported units: `s` (seconds), `m` (minutes), `h` (hours), `d` (days).

**Cron expression (5-field, limited):**

```
*/5 * * * *     # every 5 minutes (interval extracted from minute field)
*/15 * * * *    # every 15 minutes
```

> **Important limitation:** Only `*/N` patterns in the minute field are supported. Full cron scheduling semantics (day-of-week, hour, month, etc.) are **not** evaluated — the engine converts `*/N` to a simple N-minute interval.
>
> **Non-`*/N` cron expressions** (e.g., `0 9 * * *`) will silently fall back to a **1-minute interval**, which is almost certainly not what you intend. Use duration syntax instead:
> - `0 9 * * *` (daily at 9am) → use `1d` instead
> - `0 */2 * * *` (every 2 hours) → use `2h` instead
>
> The CLI `cron add` command will warn when a non-`*/N` cron expression is detected.

**One-shot relative:**

```
+20m    # run once, 20 minutes from now
+2h     # run once, 2 hours from now
```

When a runtime job uses a relative one-shot schedule (`+20m`), it is converted to an absolute ISO timestamp at creation time so it survives server restarts.

**One-shot absolute (ISO 8601):**

```
2026-03-14T09:00:00Z    # run once at this exact time
```

### Execution Behavior

- Repeating jobs run immediately on start, then schedule the next run after each completion.
- One-shot jobs wait for their delay/timestamp, run once, then auto-delete (unless `deleteAfterRun` is `false`).
- Each job runs the agent with up to 10 turns and a 120-second timeout.
- Conversation history is saved to the job's session (`cron-{id}` by default).

### Error Handling and Backoff

On consecutive errors, the next run is delayed using an escalating backoff schedule:

| Consecutive Errors | Backoff Delay |
|--------------------|---------------|
| 1 | 30 seconds |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 15 minutes |
| 5+ | 60 minutes |

The backoff resets to zero on a successful run.

### Runtime Management

- **`addRuntimeJob(job)`** -- Creates and persists a new job. Auto-starts if the server is running.
- **`removeRuntimeJob(id)`** -- Stops and deletes a runtime job.
- **`runJobNow(id)`** -- Triggers any job (config or runtime) immediately, returning the agent's response.
- **`getAllJobStatuses()`** -- Returns status of all jobs (active and inactive), including `lastRunAt`, `lastStatus`, `lastError`, and `running` state.
- **`stopAllCronJobs()`** -- Stops all active jobs (used during shutdown).

### Storage

Runtime jobs are stored at:

```
~/.camelagi/cron/jobs.json
```

Format:

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "daily-summary",
      "name": "Daily Summary",
      "schedule": "1d",
      "prompt": "Summarize today's notes",
      "enabled": true,
      "source": "runtime",
      "createdAt": 1710000000000
    }
  ]
}
```

### Config Example

```yaml
cron:
  - id: morning-brief
    name: Morning Brief
    schedule: "1d"
    prompt: "Give me a morning briefing"
    enabled: true
  - id: check-health
    name: Health Check
    schedule: "*/30 * * * *"
    prompt: "Check system health"
    enabled: true
```

---

## Skills

**Source:** `src/extensions/skills.ts`

Skills are reusable instruction sets that get injected into the system prompt. They let you teach CamelAGI domain-specific behavior without modifying core code.

### Directory Structure

```
~/.camelagi/skills/
  my-skill/
    SKILL.md           # Required: skill definition
  another-skill/
    SKILL.md
```

Each skill lives in its own subdirectory under `~/.camelagi/skills/`. The directory name is used as the skill name unless overridden in frontmatter. Only directories containing a `SKILL.md` file are recognized.

### SKILL.md Format

A skill file consists of optional YAML frontmatter followed by the skill content (Markdown):

```markdown
---
name: code-reviewer
description: Reviews code for best practices
---
# Code Review Skill

When asked to review code:
1. Check for security vulnerabilities
2. Verify error handling
3. Suggest performance improvements
...
```

**Frontmatter fields (all optional):**

| Field | Default | Description |
|-------|---------|-------------|
| `name` | Directory name | Display name of the skill |
| `description` | `""` (empty) | Short one-line description |

If the `---` frontmatter block is missing, the entire file content is treated as the skill body.

### System Prompt Injection

Skills are formatted into an `## Active Skills` section in the system prompt:

```
## Active Skills

### code-reviewer -- Reviews code for best practices

[skill content here]

### another-skill

[skill content here]
```

Skills are added in filesystem order until the total character budget is exhausted.

### Size Limits

The total combined size of all skill content injected into the system prompt is capped at **30,000 characters** (`MAX_SKILLS_TOTAL_CHARS`). Skills are added sequentially; once the limit is reached, remaining skills are silently dropped. Keep individual skills concise to ensure all of them fit.

### TUI

- `/skills` -- Lists all loaded skills by name.

---

## Hooks

**Source:** `src/extensions/hooks.ts`

Hooks are shell scripts (`.sh`) or JavaScript files (`.js`) that run at specific lifecycle points during agent execution. They provide a way to add logging, notifications, auditing, or custom side effects without modifying the agent code.

### Four Lifecycle Points

| Hook Point | When It Fires | Typical Uses |
|------------|---------------|--------------|
| `before_prompt` | Before the user's message is sent to the model | Logging, input sanitization |
| `after_response` | After the model returns a response | Notifications, analytics |
| `before_tool` | Before a tool call is executed | Auditing, access control |
| `after_tool` | After a tool call completes | Result logging, post-processing |

### File Naming Convention

Hook scripts must follow the pattern:

```
{hook_point}.{name}.{sh|js}
```

**Examples:**

```
~/.camelagi/hooks/
  before_prompt.log.sh
  after_response.notify.sh
  before_tool.audit.sh
  after_tool.record.js
  before_tool.security-check.sh
```

- The hook point must be one of the four valid points listed above.
- The name can contain dots (parts between the first dot and the file extension are joined).
- Files not ending in `.sh` or `.js` are ignored.
- Files with fewer than three dot-separated parts are ignored.

### Environment Variables

Context is passed to hook scripts via environment variables prefixed with `CAMELAGI_HOOK_`:

| Variable | Always Set | Description |
|----------|-----------|-------------|
| `CAMELAGI_HOOK_POINT` | Yes | The lifecycle point (`before_prompt`, etc.) |
| `CAMELAGI_HOOK_SESSION` | If available | Current session ID |
| `CAMELAGI_HOOK_MESSAGE` | `before_prompt` | The user's message |
| `CAMELAGI_HOOK_RESPONSE` | `after_response` | The model's response (truncated to 10,000 chars) |
| `CAMELAGI_HOOK_TOOL` | `before_tool`, `after_tool` | Name of the tool being called |
| `CAMELAGI_HOOK_TOOL_ARGS` | `before_tool`, `after_tool` | JSON-encoded tool arguments |
| `CAMELAGI_HOOK_TOOL_RESULT` | `after_tool` | Tool execution result (truncated to 10,000 chars) |

The full process environment is also inherited, so hooks have access to `PATH`, `HOME`, and other standard variables.

### Timeout Behavior

Each hook script has a **10-second timeout** (`HOOK_TIMEOUT_MS = 10_000`). If a script exceeds this limit, it is killed and an error is logged to stderr. The agent continues normally -- hook failures never block the agent loop.

Scripts are executed synchronously (`execSync`) with `stdio: "pipe"`, meaning their stdout/stderr is captured but not displayed to the user. Errors are written to the process stderr stream.

### Example Hook Scripts

**Logging all tool calls (`before_tool.log.sh`):**

```bash
#!/bin/bash
echo "$(date -Iseconds) TOOL=$CAMELAGI_HOOK_TOOL ARGS=$CAMELAGI_HOOK_TOOL_ARGS" >> ~/.camelagi/hooks/tool.log
```

**Desktop notification on response (`after_response.notify.sh`):**

```bash
#!/bin/bash
osascript -e "display notification \"CamelAGI responded\" with title \"CamelAGI\""
```

**Audit write operations (`before_tool.audit.sh`):**

```bash
#!/bin/bash
if [ "$CAMELAGI_HOOK_TOOL" = "Write" ] || [ "$CAMELAGI_HOOK_TOOL" = "Edit" ]; then
  echo "$(date -Iseconds) WRITE session=$CAMELAGI_HOOK_SESSION tool=$CAMELAGI_HOOK_TOOL args=$CAMELAGI_HOOK_TOOL_ARGS" >> ~/.camelagi/audit.log
fi
```

### Configuration

Hooks are enabled/disabled globally:

```yaml
hooks:
  enabled: true    # Set to false to skip all hooks
```

The `~/.camelagi/hooks/` directory is created automatically when needed via `ensureHooksDir()`.

---

## Approvals

**Source:** `src/extensions/approvals.ts`, `src/extensions/approval-forward.ts`

The approval system gates dangerous tool calls behind user confirmation. It prevents the agent from executing write operations, shell commands, or other side-effecting actions without explicit consent.

### Three Modes

| Mode | Behavior |
|------|----------|
| `off` | All tool calls execute immediately. Zero friction. This is the default. |
| `smart` | Read-only tools are auto-approved; write/exec tools require approval. |
| `always` | Every tool call requires explicit approval. |

### Auto-Approved Tools in Smart Mode

The following tools are considered read-only and are auto-approved when the mode is `smart`:

- `Read`
- `Glob`
- `Grep`
- `WebSearch`
- `WebFetch`
- `memory_search`
- `memory_get`

All other tools (including `Bash`, `Write`, `Edit`, `Agent`, `apply_patch`) require approval in smart mode.

### Allowlist Syntax and Patterns

The allowlist lets you pre-approve specific tool calls so they bypass the approval prompt even in `smart` or `always` mode. Entries are stored in the config under `approvals.allowlist`.

**Bare tool name** -- matches all calls to that tool:

```
Read
Glob
```

**Tool with pattern** -- matches calls where the relevant argument matches the glob:

```
Bash:npm *           # Allow any npm command
Bash:git status *    # Allow git status
Write:/tmp/*         # Allow writing to /tmp
Edit:src/*.ts        # Allow editing TypeScript files in src/
apply_patch:*        # Allow all patches
```

Pattern matching rules:
- For `Bash` tools, the pattern is matched against the `command` argument.
- For `Write` and `Edit` tools, the pattern is matched against the `file_path` argument.
- For `apply_patch`, only the wildcard `*` pattern is supported (blanket allow).
- Glob matching uses `*` as a wildcard that matches any characters.

**Auto-generated allowlist entries:**

When a user selects "Allow Always" for a tool call, an entry is automatically added to the allowlist:
- `Bash` commands: the first word of the command is extracted (e.g., `npm install foo` becomes `Bash:npm *`).
- `Write`/`Edit` calls: the exact file path is added (e.g., `Edit:src/main.ts`).
- Other tools: the bare tool name is added.

### Approval Flow

1. Before each tool call, `checkApproval()` is called.
2. If the mode is `off`, or the tool/args match the allowlist, or the tool is read-only in `smart` mode: the call proceeds immediately (returns `null`).
3. Otherwise, an `ApprovalRequest` is created with a unique ID, tool name, arguments, and a human-readable preview.
4. The request is emitted as an event, and `waitForDecision()` blocks until the user responds or the timeout expires.
5. The user submits one of three decisions:
   - **Allow Once** -- execute this call only.
   - **Allow Always** -- execute this call and add it to the allowlist for future calls.
   - **Deny** -- reject the tool call.

### Preview Format

The approval prompt shows a preview of what the tool will do:

| Tool | Preview Format |
|------|---------------|
| `Bash` | First 200 characters of the command |
| `Write` | `write -> /path/to/file` |
| `Edit` | `edit -> /path/to/file` |
| `Agent` | `spawn agent: [first 100 chars of prompt]` |
| `apply_patch` | `patch (N lines)` |
| Other | `toolName(JSON args truncated to 120 chars)` |

### Approval Channels

**TUI (interactive terminal):**

When running in the TUI, approval prompts appear inline. The user can approve or deny directly from the terminal.

**Telegram (inline buttons):**

When the agent is running headless (via HTTP API, cron job, or boot), approval requests can be forwarded to a Telegram chat. The `approval-forward.ts` module sends a message with three inline keyboard buttons:

- "Allow" (`allow-once`)
- "Always" (`allow-always`)
- "Deny" (`deny`)

The Telegram bot used for forwarding is the same bot configured for the Telegram channel. It is registered at startup via `registerForwardBot()`.

**Headless forwarding config:**

```yaml
approvals:
  forwardTo: 123456789    # Your Telegram user/chat ID
```

If no bot is registered or `forwardTo` is not set, the forwarding silently fails and the timeout/fallback behavior takes over.

### Timeout and Fallback

When waiting for a decision, a timeout is applied. If the user does not respond within the timeout period:

- The fallback behavior is configurable as either `"deny"` (reject the call) or `"allow"` (permit it).
- `"deny"` is the safe default for most deployments.
- `"allow"` may be useful for trusted automation pipelines where you want the agent to proceed even if the approval channel is unavailable.

### Config Examples

**Disable approvals (default):**

```yaml
approvals:
  mode: "off"
```

**Smart mode with allowlist:**

```yaml
approvals:
  mode: "smart"
  allowlist:
    - "Bash:git *"
    - "Bash:npm *"
    - "Edit:src/*"
    - "Read"
```

**Always mode with Telegram forwarding:**

```yaml
approvals:
  mode: "always"
  forwardTo: 123456789
  allowlist:
    - "Bash:ls *"
    - "Read"
    - "Glob"
    - "Grep"
```

**Smart mode for a project that only writes to specific directories:**

```yaml
approvals:
  mode: "smart"
  allowlist:
    - "Write:/Users/me/projects/myapp/src/*"
    - "Edit:/Users/me/projects/myapp/src/*"
    - "Bash:npm *"
    - "Bash:node *"
```
