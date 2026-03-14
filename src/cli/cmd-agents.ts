import { register } from "./registry.js";
import { loadConfig, saveConfig, ensureDirs } from "../core/config.js";
import { hasFlag } from "./parse.js";

register({
  name: "agents",
  description: "List configured agents",
  usage: `Usage: camelagi agents [subcommand]

List or manage configured agents.

Subcommands:
  (none)          List all agents (default)
  rm <id>         Remove an agent (prompts for confirmation)

Options:
  --yes, -y       Skip confirmation prompt (with rm)

Examples:
  camelagi agents
  camelagi agents rm mybot
  camelagi agents rm mybot --yes`,
  run: async (args) => {
    ensureDirs();
    const config = loadConfig();

    if (args[0] === "rm" && args[1]) {
      const agents = { ...(config.agents ?? {}) } as Record<string, unknown>;
      if (!agents[args[1]]) {
        console.error(`Agent "${args[1]}" not found.`);
        process.exit(1);
      }

      if (!hasFlag(args, "--yes") && !hasFlag(args, "-y")) {
        const { default: readline } = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) =>
          rl.question(`  Remove agent "${args[1]}"? (yes/no): `, resolve),
        );
        rl.close();
        if (answer.trim().toLowerCase() !== "yes") {
          console.log("  Cancelled.");
          process.exit(0);
        }
      }

      delete agents[args[1]];
      saveConfig({ agents });
      console.log(`Removed agent: ${args[1]}`);
      process.exit(0);
    }

    if (args[0] && args[0] !== "rm") {
      console.error(`Unknown subcommand: ${args[0]}. Use: camelagi agents [rm <id>]`);
      process.exit(1);
    }

    const agentEntries = Object.entries(config.agents ?? {});
    if (agentEntries.length === 0) {
      console.log("No agents configured. Use /agents add in the TUI or edit config.yaml.");
    } else {
      for (const [id, a] of agentEntries) {
        const parts = [a.model ?? config.model];
        if (a.telegram?.botToken) parts.push("telegram");
        console.log(`  ${id}  (${a.name}, ${parts.join(", ")})`);
      }
    }
    process.exit(0);
  },
});
