#!/usr/bin/env node
// camelagi CLI — gateway-first architecture
// All agent execution flows through the gateway server.

import { resolve, allCommands } from "./cli/registry.js";
import { printUpdateNotice } from "./core/update-check.js";
import { VERSION } from "./core/version.js";

// Register all commands (side-effect imports)
import "./cli/cmd-reset.js";
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
import "./cli/cmd-install.js";
import "./cli/cmd-uninstall.js";

const args = process.argv.slice(2);

// Non-blocking update check on every invocation
printUpdateNotice();

// camelagi --version / -v
if (args[0] === "--version" || args[0] === "-v") {
  console.log(VERSION);
  process.exit(0);
}

// camelagi --help / -h / (no args)
if (args[0] === "--help" || args[0] === "-h" || args.length === 0) {
  const commands = allCommands();

  const c = "\x1b[36m", g = "\x1b[90m", b = "\x1b[1m", x = "\x1b[0m";

  // Group commands by category
  const groups: Record<string, { name: string; desc: string }[]> = {
    "Getting Started": [],
    "Server": [],
    "Agents & Sessions": [],
    "Configuration": [],
    "Maintenance": [],
  };

  const categorize: Record<string, string> = {
    bootstrap: "Getting Started", setup: "Getting Started", chat: "Getting Started",
    serve: "Server", daemon: "Server", logs: "Server",
    agents: "Agents & Sessions", soul: "Agents & Sessions", sessions: "Agents & Sessions", pairing: "Agents & Sessions",
    config: "Configuration", cron: "Configuration",
    doctor: "Maintenance", reset: "Maintenance", install: "Maintenance", uninstall: "Maintenance",
  };

  for (const cmd of commands) {
    const cat = categorize[cmd.name] ?? "Maintenance";
    groups[cat].push({ name: cmd.name, desc: cmd.description });
  }

  console.log("");
  console.log(`  ${b}${c}CamelAGI${x} ${g}v${VERSION}${x}`);
  console.log(`  ${g}Your AI, managed from Telegram${x}`);
  console.log("");
  console.log(`  ${b}Usage${x}`);
  console.log(`    ${c}camel${x} ${g}<command>${x}              Run a command`);
  console.log(`    ${c}camel${x} ${g}"your message"${x}         One-shot message`);
  console.log("");

  for (const [group, cmds] of Object.entries(groups)) {
    if (cmds.length === 0) continue;
    console.log(`  ${b}${group}${x}`);
    for (const cmd of cmds) {
      console.log(`    ${c}${cmd.name.padEnd(12)}${x} ${g}${cmd.desc}${x}`);
    }
    console.log("");
  }

  console.log(`  ${g}Config: ~/.camelagi/config.yaml${x}`);
  console.log("");
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
