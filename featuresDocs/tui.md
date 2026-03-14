# CamelAGI TUI Documentation

## Overview

The CamelAGI TUI (Terminal User Interface) is a full-featured terminal chat client built on the `@mariozechner/pi-tui` library. It does not run the agent directly -- instead it connects to the CamelAGI gateway server over a WebSocket and acts as a thin presentation layer. All agent execution, tool calls, model switching, and session management flow through the gateway.

**Key components:**

- **ChatLog** -- scrollable chat history with user messages, assistant responses (streamed with markdown rendering), tool call blocks, and system notices.
- **CustomEditor** -- multi-line input field with command history and autocomplete.
- **HintBar** -- bottom bar showing the current model, provider, token usage, and a keyboard shortcut reminder.
- **Status area** -- animated spinner with elapsed time during active operations (thinking, tool execution, compaction), or a static status string when idle.
- **Overlays** -- modal `SelectList` popups for model selection, session selection, and tool approval prompts.

The TUI entry point is `runTui(opts)` in `src/tui/tui.ts`. It requires a `wsUrl` option pointing to the gateway's WebSocket endpoint.

---

## Slash Commands

All commands start with `/`. The TUI provides autocomplete for command names as you type.

| Command | Description | Details |
|---|---|---|
| `/help` | Show commands and shortcuts | Prints a complete reference of all commands and keyboard shortcuts. |
| `/model` | Open model selector overlay | Without an argument, opens the model picker (same as Ctrl+L). For OpenRouter providers, it fetches the live model list from the API. |
| `/model <name>` | Switch to a specific model | Sends `model.switch` to the gateway, persists to `config.yaml`, and updates the hint bar. |
| `/config` | Show current configuration | Displays provider, model, base URL, masked API key, and current session ID. |
| `/sessions` | Open session selector overlay | Opens the session picker (same as Ctrl+P). Lists all saved sessions with their model and creation date. |
| `/session <name>` | Switch to a named session | Loads the session's message history into the chat log. Resets the SDK session ID. |
| `/new` | Start a new session | Generates a fresh `session-<timestamp>` ID, clears the chat log, and shows the welcome screen. |
| `/clear` | Clear chat history | Wipes the in-memory message array and chat log. Does not delete the session file. |
| `/tools` | Toggle tool output expand/collapse | Toggles between showing full tool output and collapsed summaries. Same as Ctrl+O. |
| `/skills` | List active skills | Shows skills installed in `~/.camelagi/skills/`. |
| `/think` | Show or set thinking level | Without an argument, shows the current level. With an argument (`off`, `low`, `medium`, `high`), sets the thinking budget, persists it, and notifies the gateway. |
| `/context` | Show context breakdown | Displays a detailed report of all injected workspace files (AGENTS.md, SOUL.md, IDENTITY.md, etc.) with raw and injected character/token counts, plus system prompt size, skill count, tool count, and session history size. |
| `/status` | Show session status | Sends a status request to the gateway and displays session ID, model, provider, message count, history tokens, cumulative API token usage, active runs, and SDK session ID. |
| `/compact` | Force context compaction | Sends a compaction request to the gateway. The gateway compresses the conversation history to free up context window space. |
| `/agents` | List configured agents | Shows all agents from `config.yaml` with their name, model, system prompt excerpt, and Telegram status. |
| `/agents add` | Create a new agent (wizard) | Starts an interactive multi-step wizard. See [Agent Creation Wizard](#agent-creation-wizard) below. |
| `/agents rm <id>` | Remove an agent | Deletes the agent from `config.yaml`. Requires a server restart to take effect. |
| `/soul` | List agent SOUL.md files | Without an argument, lists all agents and their SOUL.md paths. If only one agent exists, shows that agent's SOUL.md directly. |
| `/soul <id>` | View an agent's SOUL.md | Prints the contents of the agent's SOUL.md file. |
| `/soul <id> edit` | Edit an agent's SOUL.md | Opens the file in `$EDITOR` (or `$VISUAL`, falling back to `nano`). The TUI pauses while the editor is open and resumes when it exits. Seeds the workspace first if the file does not exist. |
| `/cancel` | Cancel agent creation | Aborts the `/agents add` wizard if one is in progress. |
| `/setup` | Run setup wizard | Stops the TUI, closes the WebSocket, and launches the interactive setup wizard. Exits the process when done. |
| `/exit` or `/quit` | Exit CamelAGI | Cleanly shuts down the TUI and WebSocket connection. |

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| **Ctrl+L** | Open model selector overlay |
| **Ctrl+P** | Open session selector overlay |
| **Ctrl+O** | Toggle tool output expand/collapse |
| **Escape** | Abort the current request (sends `abort` to gateway) |
| **Ctrl+C** | If the editor has text: clear the input. If the editor is empty: first press shows "press ctrl+c again to exit"; second press within 1 second exits. |
| **Ctrl+D** | Exit immediately |

---

## Shell Command Prefix (!)

Lines starting with `!` are executed as shell commands via `bash -c`. The command runs in the current working directory with a 30-second timeout and 1 MB output buffer.

```
!ls -la
!git status
!cat ~/.camelagi/config.yaml
```

Output (stdout and stderr combined) is displayed as a system message in the chat log, truncated to 40K characters for stdout and 10K for stderr.

---

## Model Selector Overlay

Triggered by `/model` (no argument) or **Ctrl+L**.

1. Resolves the provider preset to get the built-in model list.
2. If the provider is OpenRouter (detected by `baseUrl` containing "openrouter"), it fetches the live model catalog from the OpenRouter API and replaces the preset list.
3. Ensures the currently active model appears in the list.
4. Opens a `SelectList` overlay with up to 15 visible items. You can type to filter.
5. Selecting a model sends `model.switch` to the gateway, persists the choice to `config.yaml`, and updates the hint bar.
6. Press Escape to close the overlay without changing the model.

---

## Session Selector Overlay

Triggered by `/sessions`, `/session` (no argument), or **Ctrl+P**.

Lists all saved sessions with their ID, optional label, model, and creation date. Selecting a session loads its message history into the chat log and resets the SDK session ID. Shows up to 9 items at a time.

---

## Tool Output Toggle

Tool calls from the agent are displayed as collapsible blocks in the chat log. By default, tool output is collapsed -- only the tool name and a brief preview are shown. Toggle with `/tools` or **Ctrl+O** to expand all tool output blocks and see the full results.

The current state is tracked in `state.toolsExpanded` and applied globally to all tool blocks via `chatLog.setToolsExpanded()`.

---

## Autocomplete Behavior

The editor uses `CombinedAutocompleteProvider` from pi-tui, which combines two sources:

1. **Slash commands** -- all registered commands (see the table above) with their descriptions.
2. **File paths** -- filesystem paths relative to the current working directory.

Autocomplete activates as you type `/` (for commands) or file paths. The provider is initialized once when the TUI starts.

---

## WebSocket Event Handling

The TUI receives JSON messages from the gateway on the WebSocket connection. Each message has a `type` field. The handler is in `src/tui/ws-handler.ts`.

| Event Type | Behavior |
|---|---|
| `init` | Stores the SDK session ID for subsequent requests. |
| `stream_text` | Appends streamed text to the assistant's current response. Sets activity to "responding". |
| `thinking` | Shows "thinking deeply..." spinner when `state` is `"start"`, clears on end. |
| `thinking_delta` | Keeps the "thinking deeply..." status alive during extended thinking. |
| `chunk` | Updates the assistant message with a full replacement (non-streaming fallback). |
| `approval_request` | Opens a 3-option `SelectList` overlay: "Allow once", "Always allow", or "Deny". Sends the decision back to the gateway as `approval.decide`. Cancelling the overlay sends "deny". |
| `approval_resolved` | No-op (acknowledged silently). |
| `tool_call` | Starts a tool block in the chat log with the tool name and arguments. Sets activity to "running tool: <name>". |
| `tool_result` | Finishes the tool block with a result preview. Returns activity to "thinking". |
| `subagent_start` | Displays a system message and sets activity to "subagent: <agentId>". |
| `subagent_progress` | Updates the activity status with subagent progress (tool count, duration). |
| `subagent_done` | Displays a completion message and returns activity to "thinking". |
| `usage` | Refreshes the hint bar with updated token counts. |
| `done` | Finalizes the assistant response, commits user and assistant messages to session history, stores the SDK session ID, and sets activity to "idle". |
| `retry` | Displays a retry notice with the error kind and attempt number. |
| `compacted` | Displays "(context compacted)" system message. |
| `error` | Displays the error message and sets activity to "error". |
| `aborted` | Displays "Request aborted." and sets activity to "aborted". |
| `model.switched` | Updates the current model and thinking level, resets SDK session ID, refreshes header and footer. |
| `status` | Displays session status: session ID, model, provider, message count, history tokens, token usage, active runs, and SDK session ID. |

---

## Agent Creation Wizard (/agents add)

The `/agents add` command starts a multi-step interactive wizard. During the wizard, any non-command input is intercepted and routed through the agent creation flow. Use `/cancel` at any point to abort.

**Steps:**

1. **ID** -- Enter a slug identifier (letters, numbers, dashes, underscores). Automatically lowercased and sanitized. Must be unique among existing agents.
2. **Name** -- Enter a display name (e.g., "Coder", "Journal").
3. **Model** -- Enter a model name, or press Enter to use the current default model.
4. **Prompt** -- Enter a one-line description of what the agent does. This goes into the agent's SOUL.md.
5. **Token** -- Enter a Telegram bot token from @BotFather, or type "skip" to skip Telegram integration.

On completion, the wizard:
- Seeds the agent workspace with `SOUL.md`, `TOOLS.md`, `MEMORY.md`, and a `memory/` directory.
- Saves the agent configuration to `config.yaml` (including optional Telegram settings).
- Displays a summary with the agent's directory path and created files.
- Notes that a server restart is required to start the agent's Telegram bot.

---

## SOUL.md Editing (/soul)

Each agent has a `SOUL.md` file in its workspace directory (`~/.camelagi/agents/<id>/`) that defines the agent's personality and identity. The `/soul` command provides quick access:

- `/soul` -- Lists all agents and their SOUL.md paths. If only one agent exists, displays its SOUL.md content directly.
- `/soul <id>` -- Displays the contents of the specified agent's SOUL.md.
- `/soul <id> edit` -- Opens the file in your system editor (`$EDITOR`, `$VISUAL`, or `nano`). The TUI suspends during editing and resumes when the editor exits. If the SOUL.md does not exist yet, it is seeded with a template first.

Changes to SOUL.md require a server restart to take effect.

---

## Context Report (/context)

The `/context` command provides a detailed breakdown of what is injected into the system prompt:

- **Workspace path** and bootstrap file size limit (max characters per file).
- **System prompt** total size in characters and estimated tokens.
- **Injected workspace files** -- for each bootstrap file (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md, MEMORY.md), shows:
  - Status: present or MISSING.
  - Raw size (original file characters and estimated tokens).
  - Injected size (after truncation, characters and estimated tokens).
- **Skill count** and **tool count**.
- **Session messages** count and estimated token size of conversation history.

This is useful for diagnosing context window pressure and understanding what the model sees.

---

## Thinking Mode (/think)

The `/think` command controls the model's extended thinking budget:

- `/think` -- Shows the current thinking level.
- `/think off` -- Disables extended thinking.
- `/think low` -- Minimal thinking budget.
- `/think medium` -- Moderate thinking budget.
- `/think high` -- Maximum thinking budget.

The setting is persisted to `config.yaml` and sent to the gateway as part of a `model.switch` message. When thinking is active, the TUI shows a "thinking deeply..." spinner, driven by `thinking` and `thinking_delta` WebSocket events.

---

## Theme

The TUI uses a warm, muted color palette defined in `src/tui/theme.ts`:

- **Accent**: gold (`#F6C453`) for headings, selections, and spinners.
- **Accent soft**: warm orange (`#F2A65A`) for list bullets and secondary highlights.
- **Text**: light cream (`#E8E3D5`) for body text.
- **Dim**: gray (`#7B7F87`) for secondary information.
- **System text**: cool gray (`#9BA3B2`) for system messages.
- **User messages**: light text (`#F3EEE0`) on a dark background (`#2B2F36`).
- **Tool blocks**: distinct background colors for pending (`#1F2A2F`), success (`#1E2D23`), and error (`#2F1F1F`) states.
- **Code**: warm gold (`#F0C987`) with syntax highlighting via `cli-highlight`.
- **Links**: soft green (`#7DD3A5`).

Markdown rendering supports headings, bold, italic, strikethrough, underline, code (inline and fenced blocks with syntax highlighting), blockquotes, links, horizontal rules, and list bullets.

---

## Status Bar

The bottom hint bar displays a compact summary: `? for shortcuts  ·  <model>  ·  <provider>  ·  <token count> tokens`. The token count appears after at least one API call in the current session.

The status area above the editor shows an animated spinner with elapsed time during busy states (thinking, running tool, responding, subagent, compacting), a static message for transient states (error, aborted, cleared input), or nothing when idle.

---

## Architecture Summary

```
src/tui/
  tui.ts          -- Entry point, UI construction, editor events, WS connection
  commands.ts     -- Slash command dispatch and agent creation wizard
  ws-handler.ts   -- WebSocket message handler (gateway events)
  context.ts      -- Shared TuiCtx and TuiState type definitions
  theme.ts        -- Color palette, markdown theme, editor theme, select list theme
  components/     -- ChatLog, CustomEditor, HintBar, welcome screen
```

The TUI maintains a `TuiState` object with the current configuration, session, messages, model, thinking level, tool expansion state, and agent creation wizard state. This state is shared across modules via the `TuiCtx` context object, which also holds references to all UI components and helper functions.
