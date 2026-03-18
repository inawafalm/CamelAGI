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
    const p = await import("@clack/prompts");
    ensureDirs();
    const config = loadConfig();

    if (args[0] === "rm" && args[1]) {
      const agents = { ...(config.agents ?? {}) } as Record<string, unknown>;
      if (!agents[args[1]]) {
        p.log.error(`Agent "${args[1]}" not found.`);
        process.exit(1);
      }

      if (!hasFlag(args, "--yes") && !hasFlag(args, "-y")) {
        const ok = await p.confirm({ message: `Remove agent "${args[1]}"?` });
        if (p.isCancel(ok) || !ok) {
          p.cancel("Cancelled.");
          return;
        }
      }

      delete agents[args[1]];
      saveConfig({ agents });
      p.log.success(`Removed agent: ${args[1]}`);
      return;
    }

    if (args[0] && args[0] !== "rm") {
      p.log.error(`Unknown subcommand: ${args[0]}. Use: camelagi agents [rm <id>]`);
      process.exit(1);
    }

    const agentEntries = Object.entries(config.agents ?? {});
    if (agentEntries.length === 0) {
      p.log.info("No agents configured. Use /newagent in Telegram or edit config.yaml.");
    } else {
      for (const [id, a] of agentEntries) {
        const parts = [a.model ?? config.model];
        if (a.telegram?.botToken) parts.push("telegram");
        p.log.info(`${id}  (${a.name}, ${parts.join(", ")})`);
      }
    }
  },
});
