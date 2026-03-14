# CamelAGI CLI Commands

Complete reference for all `camelagi` CLI commands, their arguments, options, internal behavior, and usage examples.

---

## Table of Contents

1. [Overview](#overview)
2. [Global Flags](#global-flags)
3. [One-Shot Mode](#one-shot-mode)
4. [Command Registry](#command-registry)
5. [Commands Reference](#commands-reference)
   - [bootstrap](#bootstrap)
   - [setup](#setup)
   - [serve](#serve)
   - [chat](#chat)
   - [config](#config)
   - [agents](#agents)
   - [soul](#soul)
   - [sessions](#sessions)
   - [pairing](#pairing)
   - [cron](#cron)
   - [daemon](#daemon)
   - [doctor](#doctor)
   - [logs](#logs)
   - [reset](#reset)
6. [Environment Variables](#environment-variables)

---

## Overview

The `camelagi` CLI is the primary interface for managing and interacting with the CamelAGI personal AI assistant. It follows a gateway-first architecture: all agent execution flows through the gateway server, whether started explicitly (`serve`) or spun up ephemerally for one-shot and chat commands.

```
Usage:
  camelagi "your message"          One-shot message
  camelagi <command> [options]     Run a command
```

When invoked without arguments, with `--help`, or with `-h`, the CLI prints the full help text including all registered commands and environment variables.

---

## Global Flags

| Flag              | Description                    |
| ----------------- | ------------------------------ |
| `--help`, `-h`    | Print help text and exit       |
| `--version`, `-v` | Print version (`0.5.0`) and exit |

### Per-Command Help

Every command supports `--help` / `-h` as its first argument to print command-specific usage information:

```bash
$ camelagi serve --help
Usage: camelagi serve [options]

Start the gateway server (Express + WebSocket).

Options:
  --port <number>   Port to listen on (1-65535, default: from config)

Examples:
  camelagi serve
  camelagi serve --port 3000
```

Commands without a custom `usage` string will print a default: `Usage: camelagi <name>\n\n<description>`.

```bash
$ camelagi --version
0.5.0
```

```bash
$ camelagi --help
camelagi - Personal AI assistant

Usage:
  camelagi "your message"          One-shot message
  camelagi <command> [options]     Run a command

Commands:
  reset       Delete all config, sessions, agents (fresh start)
  bootstrap   First-time setup via Telegram admin bot
  setup       Interactive setup wizard
  doctor      Run health checks
  config      View/edit config (get, set, list)
  cron        Manage cron jobs (list, add, rm, run)
  daemon      Manage launchd daemon (install, uninstall, status)
  logs        Tail server request log
  serve       Start gateway server
  agents      List configured agents
  soul        View/edit agent's SOUL.md in $EDITOR
  sessions    List saved sessions
  chat        Interactive REPL
  pairing     List and approve/deny pending pairing requests

Environment:
  ANTHROPIC_API_KEY    Anthropic API key
  OPENAI_API_KEY       OpenAI API key
  CAMELAGI_MODEL      Model override (e.g. gpt-4o)
  CAMELAGI_PROVIDER   Provider override (anthropic|openai)
  CAMELAGI_TOKEN      Auth token for gateway server
  TELEGRAM_BOT_TOKEN   Telegram bot token

Config file: ~/.camelagi/config.yaml
```

---

## One-Shot Mode

When the first argument is not a recognized command and does not start with `-`, CamelAGI treats the entire argument string as a one-shot message.

**Usage:**
```
camelagi "your message here"
```

**What it does internally:**

1. Joins all CLI arguments into a single message string.
2. Starts an ephemeral embedded gateway server on a random port (`port: 0`) with channels, boot, and cron disabled and output silenced.
3. Sends a `POST /chat` request to the local server with the message and a unique session ID (`oneshot-<timestamp>`).
4. Prints the assistant's response text to stdout (or the error to stderr).
5. Shuts down the ephemeral server and exits.

**Example:**

```bash
$ camelagi "What is the capital of France?"
The capital of France is Paris.
```

```bash
$ camelagi summarize my latest meeting notes
# The entire string "summarize my latest meeting notes" is sent as the message
```

If the request fails, an error message is printed to stderr and the process exits with code 1.

---

## Command Registry

The CLI uses a registry pattern defined in `src/cli/registry.ts` instead of a monolithic if-else chain. Each command file self-registers via a side-effect import.

### How it works

1. **`CliCommand` interface** -- Every command implements this shape:
   ```typescript
   interface CliCommand {
     name: string;
     description: string;
     usage?: string;          // Per-command help text (printed on --help)
     run: (args: string[]) => Promise<void>;
   }
   ```

2. **Registration** -- Each `cmd-*.ts` file calls `register(cmd)` at module load time, which stores the command in an internal `Map<string, CliCommand>`.

3. **Side-effect imports** -- The main `cli.ts` entrypoint imports all command files (e.g., `import "./cli/cmd-serve.js"`) to trigger registration.

4. **Dispatch** -- When the user runs `camelagi <name> [args...]`, the CLI calls `resolve(name)` to look up the command by name. If found, it first checks for `--help` / `-h` as the second argument — if present, prints the command's `usage` string (or a default) and exits. Otherwise, it calls `cmd.run(args)` with the remaining arguments. If not found and the argument doesn't start with `-`, it falls through to one-shot mode.

5. **Argument parsing helpers** -- Common flag parsing utilities are centralized in `src/cli/parse.ts`:

   | Function | Description |
   | --- | --- |
   | `getFlag(args, name)` | Get a flag's string value (e.g., `--port 8080` → `"8080"`) |
   | `getFlagInt(args, name, min?, max?)` | Get a flag as a validated integer with optional range checking |
   | `hasFlag(args, name)` | Check if a boolean flag is present (e.g., `--yes`) |
   | `validateSchedule(schedule)` | Validate a cron schedule string against supported formats |

**Registry API:**
| Function | Description |
| --- | --- |
| `register(cmd)` | Add a command to the registry |
| `resolve(name)` | Look up a command by name, returns `undefined` if not found |
| `allCommands()` | Return all registered commands (used by `--help`) |
| `isRegistered(name)` | Check if a command name is already taken |

---

## Commands Reference

### bootstrap

**Description:** First-time setup via Telegram admin bot.

**Usage:**
```
camelagi bootstrap [bot-token]
```

**Arguments:**

| Argument     | Required | Description                         |
| ------------ | -------- | ----------------------------------- |
| `bot-token`  | No       | Telegram bot token for admin setup  |

**What it does internally:**

Dynamically imports `runBootstrap` from `../bootstrap.js` and invokes it with the optional bot token argument. This starts an interactive Telegram-based bootstrap flow for first-time configuration of CamelAGI.

**Example:**
```bash
$ camelagi bootstrap
# Starts the bootstrap flow using the token from config or env

$ camelagi bootstrap 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
# Starts bootstrap with the specified Telegram bot token
```

---

### setup

**Description:** Interactive setup wizard for configuring CamelAGI.

**Usage:**
```
camelagi setup
```

**Arguments:** None.

**What it does internally:**

Dynamically imports `runSetup` from `../setup.js` and runs an interactive terminal wizard that guides the user through initial configuration (provider, API keys, model selection, etc.). Exits with code 0 upon completion.

**Example:**
```bash
$ camelagi setup
# Launches the interactive setup wizard in the terminal
```

---

### serve

**Description:** Start the gateway server.

**Usage:**
```
camelagi serve [--port <number>]
```

**Options:**

| Option          | Default    | Description                      |
| --------------- | ---------- | -------------------------------- |
| `--port <num>`  | From config | Port number for the HTTP server (1-65535) |

**Input validation:**

The `--port` flag is validated as an integer in the range 1–65535. Invalid values produce a clear error:
```bash
$ camelagi serve --port abc
Error: Invalid value for --port: "abc" (expected a number)

$ camelagi serve --port 99999
Error: --port must be <= 65535
```

**What it does internally:**

Dynamically imports `startServer` from `../serve.js` and starts the gateway server with cron jobs enabled (`cron: true`) and boot tasks enabled (`boot: true`). The server process stays alive indefinitely, handling HTTP and WebSocket connections.

**Example:**
```bash
$ camelagi serve
# Starts the server on the default port from config.yaml

$ camelagi serve --port 8080
# Starts the server on port 8080
```

---

### chat

**Description:** Interactive REPL (TUI) for conversing with the assistant.

**Usage:**
```
camelagi chat [--session <id>]
```

**Options:**

| Option             | Default    | Description                           |
| ------------------ | ---------- | ------------------------------------- |
| `--session <id>`   | New session | Resume an existing session by ID     |

**What it does internally:**

1. Starts an ephemeral embedded gateway server on a random port with channels, boot, and cron disabled.
2. Launches the TUI (terminal user interface) via `runTui`, connecting to the local server over WebSocket.
3. When the TUI exits, the embedded server is shut down.

The TUI provides a full-featured REPL with autocomplete, overlays, and slash commands (`/help`, `/model`, `/context`, `/status`, `/compact`, etc.).

**Example:**
```bash
$ camelagi chat
# Starts a new interactive chat session

$ camelagi chat --session sess-abc123
# Resumes the session with ID "sess-abc123"
```

---

### config

**Description:** View and edit the configuration file (`~/.camelagi/config.yaml`).

**Usage:**
```
camelagi config [list]
camelagi config get <key>
camelagi config set <key> <value>
```

**Subcommands:**

| Subcommand       | Description                              |
| ---------------- | ---------------------------------------- |
| `list` (default) | Print all config keys and values         |
| `get <key>`      | Print the value for a specific key       |
| `set <key> <val>`| Update a config key with a new value     |

**What it does internally:**

- **list / no subcommand:** Loads the config file and prints all key-value pairs. The `apiKey` field is masked, showing only the last 4 characters (e.g., `***abc1`). Object values are printed as JSON.
- **get:** Loads config and prints a single key's value. API keys are masked. Objects are pretty-printed with 2-space indentation.
- **set:** First validates that the key exists in the current config (derived from the Zod schema). If the key is unknown, prints an error listing all valid keys. Otherwise, parses the value (auto-converts `"true"`/`"false"` to booleans and numeric strings to integers), saves it to the config file, and confirms the change.

**Examples:**
```bash
$ camelagi config list
  provider: anthropic
  model: claude-sonnet-4-20250514
  apiKey: ***ab1f
  maxTurns: 50

$ camelagi config get model
claude-sonnet-4-20250514

$ camelagi config set maxTurns 100
Set maxTurns = 100

$ camelagi config set fakeKey value
Unknown config key: "fakeKey"
Valid keys: provider, model, apiKey, baseUrl, systemPrompt, thinking, ...
```

---

### agents

**Description:** List and manage configured agents.

**Usage:**
```
camelagi agents
camelagi agents rm <id> [--yes|-y]
```

**Subcommands:**

| Subcommand   | Description                              |
| ------------ | ---------------------------------------- |
| (default)    | List all configured agents               |
| `rm <id>`    | Remove an agent by its ID (with confirmation) |

**Options:**

| Option        | Description                              |
| ------------- | ---------------------------------------- |
| `--yes`, `-y` | Skip the confirmation prompt (with `rm`) |

**What it does internally:**

- **list (default):** Reads the `agents` section from config and prints each agent's ID, name, model, and whether it has Telegram integration.
- **rm:** Prompts the user for confirmation before deleting. Pass `--yes` or `-y` to skip the prompt. Deletes the specified agent from the config's `agents` map and saves the config. Exits with error if the agent ID is not found.
- **unknown subcommands:** If the first argument is not `rm` or empty, prints an error with usage hint instead of silently falling through to list.

**Examples:**
```bash
$ camelagi agents
  main  (Camel, claude-sonnet-4-20250514, telegram)
  code  (CodeBot, gpt-4o)

$ camelagi agents rm code
  Remove agent "code"? (yes/no): yes
Removed agent: code

$ camelagi agents rm code --yes
Removed agent: code

$ camelagi agents blah
Unknown subcommand: blah. Use: camelagi agents [rm <id>]
```

If no agents are configured:
```bash
$ camelagi agents
No agents configured. Use /agents add in the TUI or edit config.yaml.
```

---

### soul

**Description:** Open an agent's `SOUL.md` personality file in your text editor.

**Usage:**
```
camelagi soul [<agent-id>]
```

**Arguments:**

| Argument     | Required | Description                                              |
| ------------ | -------- | -------------------------------------------------------- |
| `agent-id`   | No       | ID of the agent. Auto-selected if only one agent exists. |

**What it does internally:**

1. Loads config and reads the agents list.
2. If no agent ID is provided and only one agent exists, that agent is auto-selected.
3. If no agent ID is provided and multiple agents exist, prints a usage message listing all agent IDs.
4. Locates the agent's `SOUL.md` file in its memory directory. If it does not exist, seeds the agent workspace with a default `SOUL.md`.
5. Opens the file in the user's preferred editor (`$EDITOR`, `$VISUAL`, or `nano` as fallback) using `spawnSync` with inherited stdio.

**Examples:**
```bash
$ camelagi soul
# Opens SOUL.md for the only configured agent

$ camelagi soul main
# Opens SOUL.md for agent "main"
```

If multiple agents exist and no ID is given:
```bash
$ camelagi soul
Usage: camelagi soul <id>

  main
  code
```

---

### sessions

**Description:** List and manage saved conversation sessions.

**Usage:**
```
camelagi sessions
camelagi sessions rm <id> [--yes|-y]
```

**Subcommands:**

| Subcommand   | Description                       |
| ------------ | --------------------------------- |
| (default)    | List all saved sessions           |
| `rm <id>`    | Delete a session by its ID (with confirmation) |

**Options:**

| Option        | Description                              |
| ------------- | ---------------------------------------- |
| `--yes`, `-y` | Skip the confirmation prompt (with `rm`) |

**What it does internally:**

- **list (default):** Calls `listSessions()` and prints each session's ID, model, optional label, and creation timestamp.
- **rm:** Prompts the user for confirmation before deleting. Pass `--yes` or `-y` to skip the prompt. Calls `deleteSession(id)` to remove the specified session's data and confirms deletion.
- **unknown subcommands:** If the first argument is not `rm` or empty, prints an error with usage hint instead of silently falling through to list.

**Examples:**
```bash
$ camelagi sessions
  sess-abc123  (claude-sonnet-4-20250514, project-review, 3/12/2026, 10:30:00 AM)
  sess-def456  (gpt-4o, 3/11/2026, 2:15:00 PM)

$ camelagi sessions rm sess-def456
  Delete session "sess-def456"? (yes/no): yes
Deleted session: sess-def456

$ camelagi sessions rm sess-def456 --yes
Deleted session: sess-def456

$ camelagi sessions blah
Unknown subcommand: blah. Use: camelagi sessions [rm <id>]
```

If no sessions exist:
```bash
$ camelagi sessions
No sessions.
```

---

### pairing

**Description:** List and interactively approve or deny pending Telegram pairing requests.

**Usage:**
```
camelagi pairing
```

**Arguments:** None.

**What it does internally:**

1. Calls `listPendingRequests()` to retrieve all pending pairing requests.
2. If none exist, prints "No pending pairing requests." and returns.
3. For each request, displays the pairing code, user info (username or first name or user ID), agent ID, and status.
4. For requests with status `"pending"`, prompts the admin interactively to approve or deny:
   - **Approve (`y`):** Calls `approveRequest(code)`, which generates a one-time password (OTP). Prints the OTP for the admin to relay to the user.
   - **Deny (any other input):** Calls `denyRequest(code)`.
5. For requests with status `"otp_pending"`, shows a note that the system is waiting for the user to enter the OTP.

**Example:**
```bash
$ camelagi pairing
  No pending pairing requests.

$ camelagi pairing
  Request: pair-abc123
  User:    @johndoe (12345678)
  Agent:   main
  Status:  pending

  Approve? (y/n): y

  Approved. OTP: 482916
  Tell the user to enter this code in the bot chat.
```

---

### cron

**Description:** Manage scheduled cron jobs that run prompts at specified intervals.

**Usage:**
```
camelagi cron [list]
camelagi cron add --schedule <schedule> --prompt <prompt> [--name <name>] [--id <id>]
camelagi cron rm <id>
camelagi cron run <id>
```

**Subcommands:**

| Subcommand          | Description                                        |
| ------------------- | -------------------------------------------------- |
| `list` (default)    | List all cron jobs (config-defined and runtime)     |
| `add`               | Create a new runtime cron job                       |
| `rm <id>`           | Remove a runtime cron job by ID                     |
| `run <id>`          | Manually trigger a cron job immediately             |

**Options for `add`:**

| Option              | Required | Description                                                  |
| ------------------- | -------- | ------------------------------------------------------------ |
| `--schedule <expr>` | Yes      | Schedule expression: `5m`, `1h`, `1d`, cron syntax (`*/5 * * * *`), `+20m` (one-shot), or ISO timestamp (one-shot) |
| `--prompt <text>`   | Yes      | The prompt to send to the agent when the job fires           |
| `--name <text>`     | No       | Human-readable name for the job (default: "Untitled")        |
| `--id <text>`       | No       | Custom job ID (default: auto-generated `job-<base36-timestamp>`) |

**What it does internally:**

- **list:** Loads both config-defined cron jobs (from `config.yaml`) and runtime jobs (from a separate runtime store). Displays each job with an enabled/disabled indicator, ID, name, schedule, source tag (`(config)` or `(runtime)`), and a truncated preview of the prompt.
- **add:** Validates the schedule format before creating the job. Supported formats: duration (`5m`, `1h`, `1d`), one-shot relative (`+20m`), cron expression (5 fields), and ISO timestamp. Invalid formats produce a clear error. Creates a new runtime job via `addRuntimeJob()`. Runtime jobs are persisted separately from `config.yaml` and will start executing on the next `camelagi serve`.
- **rm:** Removes a runtime job by ID. Config-defined jobs cannot be removed via CLI -- they must be edited in `config.yaml` directly.
- **run:** Starts an ephemeral embedded server, executes the specified job immediately via `runJobNow()`, prints the response, and shuts down.

**Examples:**
```bash
$ camelagi cron list
  * job-abc  Daily Summary  1d  (runtime)
    Summarize today's activity and send a report...

$ camelagi cron add --name "Hourly Check" --schedule "1h" --prompt "Check system status"
Created job: job-lx4k2f (1h)
  Will start on next camelagi serve

$ camelagi cron rm job-abc
Removed job: job-abc

$ camelagi cron run job-abc
Triggering job "job-abc" via embedded server...
Response:
Here is today's summary...

$ camelagi cron add --schedule "xyz" --prompt "test"
Error: Invalid schedule format: "xyz"
  Supported: 5m, 1h, 1d (interval), +20m (one-shot), */5 * * * * (cron), ISO timestamp
```

---

### daemon

**Description:** Manage the macOS launchd daemon for running CamelAGI as a background service.

**Usage:**
```
camelagi daemon [status]
camelagi daemon install
camelagi daemon uninstall
```

**Subcommands:**

| Subcommand          | Description                                        |
| ------------------- | -------------------------------------------------- |
| `status` (default)  | Show whether the daemon is installed and running   |
| `install`           | Install the launchd plist and load the daemon      |
| `uninstall`         | Unload the daemon and remove the launchd plist     |

**What it does internally:**

Dynamically imports the `daemon.js` module and calls the corresponding function (`install`, `uninstall`, or `status`). This manages a macOS `launchd` plist that keeps `camelagi serve` running in the background, auto-restarting on failure.

**Examples:**
```bash
$ camelagi daemon status
# Shows current daemon installation and run status

$ camelagi daemon install
# Installs and starts the launchd daemon

$ camelagi daemon uninstall
# Stops and removes the launchd daemon
```

---

### doctor

**Description:** Run diagnostic health checks on the CamelAGI installation.

**Usage:**
```
camelagi doctor
```

**Arguments:** None.

**What it does internally:**

1. Ensures the `~/.camelagi` directory structure exists.
2. Dynamically imports `runDoctor` and `formatChecks` from `../doctor.js`.
3. Runs all health checks (e.g., config validity, API key presence, model reachability, directory permissions).
4. Prints formatted check results with pass/warn/error indicators.
5. Prints a summary line with counts of OK, warning, and error results.
6. Exits with code 1 if any checks resulted in errors, otherwise exits with code 0.

**Example:**
```bash
$ camelagi doctor

  CamelAGI Doctor

  [ok]   Config file exists
  [ok]   API key configured
  [ok]   Model reachable
  [warn] No Telegram bot token set
  [ok]   Sessions directory writable

  5 checks: 4 ok, 1 warnings, 0 errors
```

---

### logs

**Description:** Tail the gateway server's request log.

**Usage:**
```
camelagi logs [-n <lines>]
```

**Options:**

| Option       | Default | Description                            |
| ------------ | ------- | -------------------------------------- |
| `-n <num>`   | 50      | Number of log lines to display (must be >= 1) |

**Input validation:**

The `-n` flag is validated as a positive integer. Invalid values produce a clear error:
```bash
$ camelagi logs -n abc
Error: Invalid value for -n: "abc" (expected a number)

$ camelagi logs -n -5
Error: -n must be >= 1
```

**What it does internally:**

Dynamically imports `tailLog` from `../gateway/logger.js` and prints the specified number of most recent log lines from the server's request log file.

**Examples:**
```bash
$ camelagi logs
# Prints the last 50 lines of the request log

$ camelagi logs -n 100
# Prints the last 100 lines of the request log
```

---

### reset

**Description:** Delete all CamelAGI data for a completely fresh start.

**Usage:**
```
camelagi reset [--confirm]
```

**Options:**

| Option       | Description                                          |
| ------------ | ---------------------------------------------------- |
| `--confirm`  | Skip the interactive confirmation prompt             |

**What it does internally:**

1. Checks if `~/.camelagi` exists. If not, prints "Nothing to reset" and exits.
2. Unless `--confirm` is passed, prompts the user with a warning that ALL config, sessions, agents, and workspaces will be deleted. The user must type `yes` to proceed.
3. Recursively deletes the entire `~/.camelagi` directory.
4. Prints a confirmation message suggesting to run `camelagi bootstrap` to start fresh.

**Examples:**
```bash
$ camelagi reset
  This will delete ALL config, sessions, agents, and workspaces.
  Are you sure? (yes/no): yes
  ~/.camelagi deleted. Run camelagi bootstrap to start fresh.

$ camelagi reset --confirm
  ~/.camelagi deleted. Run camelagi bootstrap to start fresh.
```

---

## Environment Variables

These environment variables can override or supplement values from `~/.camelagi/config.yaml`:

| Variable             | Description                                            |
| -------------------- | ------------------------------------------------------ |
| `ANTHROPIC_API_KEY`  | Anthropic API key for Claude models                    |
| `OPENAI_API_KEY`     | OpenAI API key for GPT models                          |
| `CAMELAGI_MODEL`    | Override the configured model (e.g., `gpt-4o`)         |
| `CAMELAGI_PROVIDER` | Override the configured provider (`anthropic` or `openai`) |
| `CAMELAGI_TOKEN`    | Auth token for authenticating with the gateway server  |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for the Telegram channel            |
| `EDITOR` / `VISUAL`  | Preferred text editor (used by `soul` command)         |
