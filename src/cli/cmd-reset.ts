import { register } from "./registry.js";
import { paths } from "../core/config.js";
import { hasFlag } from "./parse.js";

register({
  name: "reset",
  description: "Delete all config, sessions, agents (fresh start)",
  usage: `Usage: camelagi reset [options]

Delete ALL data in ~/.camelagi (config, sessions, agents, workspaces).

Options:
  --confirm   Skip the confirmation prompt

Examples:
  camelagi reset
  camelagi reset --confirm`,
  run: async (args) => {
    const p = await import("@clack/prompts");
    const fs = await import("node:fs");

    const configDir = paths.configDir;

    if (!fs.existsSync(configDir)) {
      p.log.info("Nothing to reset \u2014 ~/.camelagi does not exist.");
      return;
    }

    if (!hasFlag(args, "--confirm")) {
      p.log.warn("This will delete ALL config, sessions, agents, and workspaces.");
      const ok = await p.confirm({ message: "Are you sure?" });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Cancelled.");
        return;
      }
    }

    fs.rmSync(configDir, { recursive: true, force: true });
    p.log.success("~/.camelagi deleted. Run \x1b[36mcamel setup\x1b[0m to start fresh.");
  },
});
