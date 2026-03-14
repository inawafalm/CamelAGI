import { register } from "./registry.js";

register({
  name: "daemon",
  description: "Manage launchd daemon (install, uninstall, status)",
  usage: `Usage: camelagi daemon <subcommand>

Manage the macOS launchd background service.

Subcommands:
  status        Show daemon status (default)
  install       Install and start the daemon
  uninstall     Stop and remove the daemon

Examples:
  camelagi daemon
  camelagi daemon install
  camelagi daemon status`,
  run: async (args) => {
    const sub = args[0];
    const { install, uninstall, status } = await import("../daemon.js");

    if (sub === "install") { install(); process.exit(0); }
    if (sub === "uninstall") { uninstall(); process.exit(0); }
    if (sub === "status" || !sub) { status(); process.exit(0); }

    console.error(`Unknown daemon subcommand: ${sub}. Use: install, uninstall, status`);
    process.exit(1);
  },
});
