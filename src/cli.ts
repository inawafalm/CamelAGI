#!/usr/bin/env node
// camelagi CLI — gateway-first architecture
// All agent execution flows through the gateway server.

import { resolve, allCommands } from "./cli/registry.js";
import { printUpdateNotice } from "./core/update-check.js";

// Register all commands (side-effect imports)
import "./cli/cmd-reset.js";
import "./cli/cmd-bootstrap.js";
import "./cli/cmd-setup.js";
import "./cli/cmd-doctor.js";
import "./cli/cmd-config.js";
import "./cli/cmd-cron.js";
import "./cli/cmd-daemon.js";
import "./cli/cmd-logs.js";
import "./cli/cmd-serve.js";
import "./cli/cmd-agents.js";
import "./cli/cmd-soul.js";
import "./cli/cmd-sessions.js";
import "./cli/cmd-chat.js";
import "./cli/cmd-pairing.js";

const args = process.argv.slice(2);

// Non-blocking update check on every invocation
printUpdateNotice();

// camelagi --version / -v
if (args[0] === "--version" || args[0] === "-v") {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

// camelagi --help / -h / (no args)
if (args[0] === "--help" || args[0] === "-h" || args.length === 0) {
  const commands = allCommands();
  const maxLen = Math.max(...commands.map((c) => c.name.length));
  console.log(`
camelagi - Personal AI assistant

Usage:
  camelagi "your message"          One-shot message
  camelagi <command> [options]     Run a command

Commands:`);
  for (const cmd of commands) {
    console.log(`  ${cmd.name.padEnd(maxLen + 2)}${cmd.description}`);
  }
  console.log(`
Environment:
  ANTHROPIC_API_KEY    Anthropic API key
  OPENAI_API_KEY       OpenAI API key
  CAMELAGI_MODEL      Model override (e.g. gpt-4o)
  CAMELAGI_PROVIDER   Provider override (anthropic|openai)
  CAMELAGI_TOKEN      Auth token for gateway server
  TELEGRAM_BOT_TOKEN   Telegram bot token

Config file: ~/.camelagi/config.yaml
`);
  process.exit(0);
}

// Dispatch to registered command
const cmd = resolve(args[0]);
if (cmd) {
  if (args[1] === "--help" || args[1] === "-h") {
    console.log(cmd.usage ?? `Usage: camelagi ${cmd.name}\n\n${cmd.description}`);
    process.exit(0);
  }
  await cmd.run(args.slice(1));
} else if (args[0] && !args[0].startsWith("-")) {
  // camelagi "your message" — one-shot mode via embedded gateway
  const message = args.join(" ");

  const { startServer } = await import("./serve.js");
  const handle = await startServer({
    port: 0,
    silent: true,
    channels: false,
    boot: false,
    cron: false,
  });

  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, session: `oneshot-${Date.now()}` }),
    });

    const data = await res.json() as { response?: string; error?: string };

    if (res.ok) {
      console.log(data.response);
    } else {
      console.error(`Error: ${data.error}`);
      process.exit(1);
    }
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await handle.close();
  }
}
