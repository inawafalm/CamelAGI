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
    const { default: fs } = await import("node:fs");
    const { default: readline } = await import("node:readline");

    const configDir = paths.configDir;

    if (!fs.existsSync(configDir)) {
      console.log("Nothing to reset — ~/.camelagi does not exist.");
      process.exit(0);
    }

    if (!hasFlag(args, "--confirm")) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) =>
        rl.question("\x1b[31m  This will delete ALL config, sessions, agents, and workspaces.\x1b[0m\n  Are you sure? (yes/no): ", resolve),
      );
      rl.close();
      if (answer.trim().toLowerCase() !== "yes") {
        console.log("  Cancelled.");
        process.exit(0);
      }
    }

    fs.rmSync(configDir, { recursive: true, force: true });
    console.log("  \x1b[32m✓\x1b[0m ~/.camelagi deleted. Run \x1b[36mcamelagi bootstrap\x1b[0m to start fresh.");
    process.exit(0);
  },
});
