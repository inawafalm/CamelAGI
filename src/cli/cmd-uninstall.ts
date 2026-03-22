import { register } from "./registry.js";
import { paths } from "../core/config.js";

register({
  name: "uninstall",
  description: "Remove CamelAGI completely (config, data, global CLI)",
  usage: `Usage: camelagi uninstall [options]

Remove CamelAGI: delete ~/.camelagi and unlink the global CLI.

Options:
  --confirm   Skip the confirmation prompt
  --keep-cli  Only delete data, keep the global CLI installed

Examples:
  camelagi uninstall
  camelagi uninstall --confirm`,
  run: async (args) => {
    const p = await import("@clack/prompts");
    const fs = await import("node:fs");
    const { execSync } = await import("node:child_process");
    const { hasFlag } = await import("./parse.js");

    const configDir = paths.configDir;
    const hasData = fs.existsSync(configDir);
    const keepCli = hasFlag(args, "--keep-cli");

    if (!hasData) {
      p.intro("\x1b[36mCamelAGI\x1b[0m uninstall");
      p.log.info("Nothing to remove \u2014 ~/.camelagi does not exist.");
      p.outro("Already clean.");
      return;
    }

    p.intro("\x1b[36mCamelAGI\x1b[0m uninstall");

    // Show what will be deleted
    const items: string[] = [];
    const check = (dir: string, label: string) => {
      const full = `${configDir}/${dir}`;
      if (fs.existsSync(full)) items.push(label);
    };
    check("config.yaml", "Config (config.yaml)");
    check("sessions", "Sessions");
    check("workspace", "Agent workspaces");
    check("usage", "Usage data");
    check("logs", "Logs");
    check("cron", "Cron state");
    check("hooks", "Hooks");
    check("skills", "Skills");

    if (items.length > 0) {
      p.log.warn(`Will delete ~/.camelagi:`);
      for (const item of items) {
        p.log.info(`  \u2022 ${item}`);
      }
    }
    if (!keepCli) {
      p.log.info("  \u2022 Global CLI (npm unlink)");
    }

    if (!hasFlag(args, "--confirm")) {
      const ok = await p.confirm({ message: "Remove everything?" });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Cancelled.");
        return;
      }
    }

    // Delete data
    fs.rmSync(configDir, { recursive: true, force: true });
    p.log.success("~/.camelagi deleted");

    // Unlink global CLI
    if (!keepCli) {
      try {
        execSync("npm uninstall -g camelagi 2>/dev/null", { stdio: "ignore" });
        p.log.success("Global CLI removed");
      } catch {
        p.log.warn("Could not remove global CLI \u2014 run: npm uninstall -g camelagi");
      }
    }

    p.outro("CamelAGI removed. Thanks for trying it out!");
  },
});
