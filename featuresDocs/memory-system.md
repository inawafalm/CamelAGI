# CamelAGI Memory System

The memory system gives CamelAGI persistent knowledge across sessions. It uses a two-tier design: a curated MEMORY.md file for long-term facts and a `memory/` directory of daily markdown notes for append-only journaling. Both tiers are searchable at runtime through dedicated tools and are injected into the system prompt as bootstrap files.

---

## Table of Contents

1. [Two-Tier Memory Architecture](#two-tier-memory-architecture)
2. [Workspace Structure](#workspace-structure)
3. [Bootstrap Files](#bootstrap-files)
4. [System Prompt Assembly](#system-prompt-assembly)
5. [File Truncation Rules](#file-truncation-rules)
6. [Workspace Seeding Functions](#workspace-seeding-functions)
7. [Agent Memory Directory Resolution](#agent-memory-directory-resolution)
8. [Memory Tools](#memory-tools)
9. [Context Report](#context-report)
10. [Per-Agent SOUL.md Customization](#per-agent-soulmd-customization)
11. [Content Examples](#content-examples)

---

## Two-Tier Memory Architecture

### Tier 1: Curated MEMORY.md

`MEMORY.md` lives at the root of a workspace (global or per-agent). It holds curated, long-term facts -- things the agent should always know. The agent reads and updates this file itself. Think of it as the agent's personal knowledge base.

Typical contents:
- Project architecture summaries
- User preferences and conventions
- Key decisions and their rationale
- Frequently referenced paths, hosts, credentials notes

The agent is instructed to keep MEMORY.md tidy and relevant.

### Tier 2: Daily Notes (memory/*.md)

The `memory/` subdirectory holds dated markdown files following the naming convention `YYYY-MM-DD.md`. These are append-only daily logs. When a daily file already exists, the agent appends to it rather than overwriting.

Typical contents:
- Session summaries
- Tasks completed
- Decisions made during a conversation
- Notes for future reference

Together, the two tiers give the agent both a clean reference document (MEMORY.md) and a chronological trail of activity (memory/*.md).

---

## Workspace Structure

CamelAGI maintains two levels of workspace: **global** and **per-agent**.

### Global Workspace

```
~/.camelagi/workspace/
  AGENTS.md        # Agent instructions and guidelines
  SOUL.md          # Personality and tone
  IDENTITY.md      # Name, vibe, emoji
  USER.md          # User profile
  TOOLS.md         # Environment-specific tool notes
  MEMORY.md        # Curated long-term memory
  memory/          # Daily notes (YYYY-MM-DD.md files)
```

The global workspace is created by `seedWorkspace()` and serves as the default when no agent ID is specified.

### Per-Agent Workspace

```
~/.camelagi/agents/<agentId>/
  SOUL.md          # Agent-specific personality override
  TOOLS.md         # Agent-specific tool notes
  MEMORY.md        # Agent-specific curated memory
  memory/          # Agent-specific daily notes
```

Per-agent workspaces are created by `seedAgentWorkspace()`. They allow each agent to have its own identity, memory, and tool configuration. When loading bootstrap files for an agent, the system checks the agent directory first and falls back to the global workspace if a file is not found there. The one exception is `USER.md`, which always comes from the global workspace (the user is the same across all agents).

---

## Bootstrap Files

Six markdown files are loaded into the system prompt at startup. They are processed in the following fixed order:

| File | Required | Purpose |
|------|----------|---------|
| **AGENTS.md** | Yes | Core agent instructions. Defines behavioral guidelines, session memory workflow, and tool usage conventions. This is the only required bootstrap file. |
| **SOUL.md** | No | Personality and tone. Controls how the agent communicates -- its voice, boundaries, and approach to continuity. When present, the system prompt includes an instruction to embody its persona. |
| **IDENTITY.md** | No | The agent's name, emoji, and vibe. A lightweight identity card. |
| **USER.md** | No | User profile information (name, timezone, projects, preferences). Always loaded from the global workspace, never from per-agent directories. |
| **TOOLS.md** | No | Environment-specific notes for the agent: SSH hosts, project conventions, preferred languages, framework choices. |
| **MEMORY.md** | No | Curated long-term memory. Facts, decisions, and context the agent should carry across sessions. |

### Loading Precedence

For a given agent, each bootstrap file (except USER.md) is resolved as:

1. Check `~/.camelagi/agents/<agentId>/<filename>` -- use it if it exists.
2. Otherwise fall back to `~/.camelagi/workspace/<filename>`.

`USER.md` always resolves to `~/.camelagi/workspace/USER.md` regardless of agent context.

---

## System Prompt Assembly

The system prompt is assembled in `buildSystemPrompt()` (defined in `src/system-prompt.ts`) in the following order:

1. **Base identity** -- the `basePrompt` string passed in by the caller.
2. **Safety section** -- rules about unauthorized access, destructive operations, and respecting boundaries.
3. **Available Tools** -- a listing of all tools (exec, read, write, edit, apply_patch, fetch, web_search, memory_search, memory_get, subagent, subagent_list).
4. **Current Date & Time** -- ISO date, time, and timezone from the host system.
5. **Runtime metadata** -- hostname, OS, Node version, cwd, workspace path.
6. **Project Context (bootstrap files)** -- each non-missing bootstrap file is injected under a `## <filename>` heading. Files are truncated if necessary (see below). If SOUL.md is present, an extra instruction is added: "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies."
7. **Truncation note** -- if any file was truncated, a note is appended telling the agent to use the read tool for full contents.
8. **Memory section** -- reports the number of daily memory files available and the memory directory path. Instructs the agent to use `memory_search` to find past context.
9. **Skills** -- any loaded skill definitions (from `~/.camelagi/skills/`), filtered by the deny list.

Each section is joined with newline separators into a single string.

---

## File Truncation Rules

Bootstrap files are truncated to fit within token budgets. The constants (defined in `src/core/constants.ts`) are:

| Constant | Value | Meaning |
|----------|-------|---------|
| `MAX_BOOTSTRAP_FILE_CHARS` | 20,000 | Maximum characters per individual bootstrap file |
| `MAX_BOOTSTRAP_TOTAL_CHARS` | 150,000 | Maximum total characters across all bootstrap files |
| `CHARS_PER_TOKEN` | 4 | Approximation used for token estimation |

### Truncation Algorithm

The `truncateFile()` function in `src/workspace.ts` applies the following logic:

1. If the file content is within the budget, return it as-is.
2. Otherwise, split into **head** and **tail**:
   - **Head**: first 70% of the budget (`HEAD_RATIO = 0.7`)
   - **Tail**: last 20% of the budget (`TAIL_RATIO = 0.2`)
   - The remaining 10% is consumed by the truncation marker.
3. The output is: `<head>\n\n[...truncated, read file for full content...]\n\n<tail>`

The per-file budget is the lesser of `MAX_BOOTSTRAP_FILE_CHARS` and the remaining room in `MAX_BOOTSTRAP_TOTAL_CHARS`. If the remaining budget drops below 64 characters, no more files are loaded.

This design preserves the beginning of the file (where headers and key context usually live) and the end (where the most recent entries often are), while indicating that content was omitted in the middle.

---

## Workspace Seeding Functions

### seedWorkspace()

**Location:** `src/workspace.ts`

Creates the global workspace at `~/.camelagi/workspace/` and populates it with default template files. Only writes a file if it does not already exist (safe to call multiple times).

What it creates:
- `~/.camelagi/workspace/` directory
- `~/.camelagi/workspace/memory/` directory
- Template versions of: AGENTS.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md
- An example skill template at `~/.camelagi/skills/_example/SKILL.md`

Note: MEMORY.md is not seeded by `seedWorkspace()` -- it is only created by `seedAgentWorkspace()` or by the agent itself.

### seedAgentWorkspace(agentId, name, description?)

**Location:** `src/workspace.ts`

Creates a per-agent workspace at `~/.camelagi/agents/<agentId>/` with agent-specific bootstrap files.

What it creates:
- `~/.camelagi/agents/<agentId>/` directory
- `~/.camelagi/agents/<agentId>/memory/` directory
- **SOUL.md** -- personalized with the agent's name and optional description, plus default personality traits, boundaries, and a continuity note ("Each session, you wake up fresh. These files are your memory.")
- **TOOLS.md** -- a skeleton for agent-specific setup notes
- **MEMORY.md** -- an empty curated memory file with an HTML comment placeholder

All files are only written if they do not already exist, so customizations are preserved across calls.

### ensureAgentDirs(agentId)

**Location:** `src/workspace.ts`

A lower-level helper that ensures the agent directory and its `memory/` subdirectory exist. Called by `seedAgentWorkspace()`.

---

## Agent Memory Directory Resolution

### agentMemoryDir(agentId?)

**Location:** `src/workspace.ts`

Resolves the root directory for memory operations:

- If `agentId` is provided: returns `~/.camelagi/agents/<agentId>/`
- If `agentId` is omitted or undefined: returns `~/.camelagi/workspace/`

This function is used throughout the codebase to scope memory tools, bootstrap file loading, and the memory section of the system prompt to the correct directory.

---

## Memory Tools

Two tools provide runtime access to the memory system. They are defined in `src/tools/memory.ts` and can be scoped to any root directory via `createScopedMemoryTools(rootDir)`.

### memory_search

**Purpose:** Full-text keyword search across MEMORY.md and all files in `memory/`.

**Parameters:**
- `query` (string, required) -- keywords or phrase to search for
- `maxResults` (number, optional, default: 6) -- maximum results to return

**Scoring Algorithm:**

1. **Discover files:** Collects MEMORY.md (if it exists) and all `.md` files in the `memory/` subdirectory.
2. **Split into paragraphs:** Each file is split on double newlines (`\n\n`) or newlines followed by a heading marker (`\n#`). Empty paragraphs are filtered out.
3. **Tokenize query:** The query string is lowercased and split on whitespace into keywords.
4. **Score each paragraph:** For each paragraph, each keyword is counted by splitting the lowercased paragraph text on the keyword and taking `(occurrences - 1)`. The paragraph's raw score is the sum of all keyword occurrence counts.
5. **Recency boost:** The raw score is multiplied by a recency factor derived from the file name:
   - `MEMORY.md` → 1.0x (curated, always relevant)
   - Today's daily note → 1.5x
   - Yesterday's daily note → 1.3x
   - This week (2-7 days old) → 1.1x
   - Older or undated files → 1.0x
6. **Filter:** Paragraphs with a score of 0 are discarded.
7. **Sort and limit:** Results are sorted by boosted score descending and capped at `maxResults`.

**Output format:**
```
[1] memory/2026-03-14.md (score: 4.5)
Snippet of the matching paragraph (up to 500 chars)...

---

[2] MEMORY.md (score: 2)
Another matching snippet...

Searched 8 file(s).
```

Scores are displayed as integers when whole, or with 1 decimal place when fractional (due to recency boost).

**No-results feedback:**

The tool provides contextual feedback when no results are found:

- No memory files exist: `"No memory files found. The memory directory is empty."`
- Files exist but no matches: `"No memory matches found. Searched N file(s) (X.X KB total). Try different keywords."`
- Results found: a footer line `"Searched N file(s)."` is appended

### memory_get

**Purpose:** Read a specific memory file by relative path.

**Parameters:**
- `filePath` (string, required) -- relative path within the workspace, e.g., `"MEMORY.md"` or `"memory/2026-03-09.md"`
- `from` (number, optional) -- starting line number (1-indexed, default: 1)
- `lines` (number, optional) -- number of lines to read (default: all)

**Security checks:**
- Only allows paths that are `MEMORY.md`, `memory.md`, or start with `memory/`.
- Validates that the resolved path does not escape the root directory (path traversal protection).

**Output format:** Lines prefixed with line numbers, e.g.:
```
1: # My Memory
2:
3: ## Projects
4: - CamelAGI: personal AI assistant
```

### Scoping

`createScopedMemoryTools(rootDir)` returns both tools bound to a specific root directory. This enables per-agent memory isolation. Both agent execution paths (Claude Agent SDK in `agent-sdk.ts` and OpenAI-compatible in `agent-openai.ts`) scope memory tools per agent via `createScopedMemoryTools(agentMemoryDir(agentId))`. The module also exports global defaults (`memorySearchTool`, `memoryGetTool`) bound to the global workspace for backward compatibility with TUI, HTTP, and legacy Telegram interfaces.

Memory flushing during context compaction is also agent-scoped: when `compactHistory()` receives an `agentId`, flushed notes are written to `~/.camelagi/agents/<agentId>/memory/` instead of the global workspace.

---

## Context Report

The `/context` TUI command calls `getContextReport()` from `src/system-prompt.ts` to produce a diagnostic view of the system prompt.

The report includes:

| Field | Description |
|-------|-------------|
| `workspace` | Path to the workspace directory |
| `bootstrapMaxPerFile` | Per-file character limit (20,000) |
| `bootstrapMaxTotal` | Total character limit across all files (150,000) |
| `systemPromptChars` | Total character count of the assembled system prompt |
| `systemPromptTokens` | Estimated token count (chars / 4) |
| `files` | Per-file breakdown: name, status (OK / TRUNCATED / MISSING), raw chars, raw tokens, injected chars, injected tokens |
| `skillCount` | Number of loaded skills |
| `toolCount` | Number of available tools |

This helps diagnose situations where bootstrap files are being truncated or are missing, and gives visibility into how much of the context window the system prompt consumes.

---

## Per-Agent SOUL.md Customization

When a new agent is created via `seedAgentWorkspace()`, it gets its own SOUL.md tailored with the agent's name and optional description. This file can be freely edited after creation.

The per-agent SOUL.md takes precedence over the global one during bootstrap file loading. This means each agent can have a completely different personality, tone, and set of boundaries while sharing the same USER.md (since the user is constant).

The system prompt builder detects when SOUL.md is present and adds the instruction: "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies." This ensures the model actually uses the personality definition rather than falling back to generic assistant behavior.

---

## Content Examples

### Example SOUL.md (Global Default)

```markdown
# Soul

## Personality
- Genuine, direct, and resourceful
- Have opinions when asked -- don't hedge everything
- Be concise but thorough when it matters
- Adapt tone to context (casual chat vs technical work)

## Boundaries
- Respect user privacy
- Be honest about limitations
- Don't pretend to know things you don't
```

### Example SOUL.md (Per-Agent)

```markdown
# CodeReviewer

A meticulous code review assistant that focuses on correctness and maintainability.

## Personality
- Genuine, direct, and resourceful
- Have opinions -- don't hedge everything
- Be concise but thorough when it matters
- Adapt tone to context

## Boundaries
- Private things stay private
- When in doubt, ask before acting externally
- Be honest about limitations

## Continuity
Each session, you wake up fresh. These files are your memory.
Read them. Update them. They're how you persist.
```

### Example MEMORY.md

```markdown
# CamelAGI Memory

## Project Overview
- Personal AI assistant at ~/Desktop/CamelAGI/CamelAGI/
- TypeScript, ES modules, Node.js 20+
- 31 TypeScript files, ~3,656 LOC

## Architecture
- Agent: Simple while-loop (OpenAI SDK) with tool policy, hooks, retry
- Gateway: Express + WebSocket with run tracking, compaction, retry
- TUI: pi-tui with autocomplete, overlays, /context /status /compact

## Key Decisions
- LangChain removed; uses openai SDK + zod-to-json-schema only
- Anthropic via OpenAI compat layer at api.anthropic.com/v1/
- All providers through single OpenAI SDK client
```

### Example Daily Note (memory/2026-03-13.md)

```markdown
## 2026-03-13

### Session: Documentation
- Wrote memory-system.md documentation
- Reviewed workspace.ts, system-prompt.ts, tools/memory.ts

### Decisions
- Documented the two-tier memory architecture
- Noted that USER.md always loads from global workspace
```

---

## Limitations

- **Non-recursive discovery:** `discoverMemoryFiles()` only reads `.md` files directly inside `memory/`. Subdirectories within `memory/` are not traversed.
- **Keyword-only search:** Scoring is based on exact keyword substring matching. There is no stemming, fuzzy matching, or semantic/embedding-based search.
- **No cross-agent search:** Each agent's memory tools are scoped to its own directory. There is no built-in way to search across all agents' memories simultaneously.

---

## Source Files

| File | Role |
|------|------|
| `src/workspace.ts` | Workspace seeding, bootstrap file loading, truncation, path resolution |
| `src/system-prompt.ts` | System prompt assembly, context report generation |
| `src/tools/memory.ts` | memory_search and memory_get tool definitions, scoped tool factory, recency boost |
| `src/runtime/compact.ts` | Context compaction, agent-scoped memory flush |
| `src/core/constants.ts` | Character limits and token estimation constant |
