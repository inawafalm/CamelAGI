import { register } from "./registry.js";
import { hasFlag } from "./parse.js";

register({
  name: "sessions",
  description: "List saved sessions",
  usage: `Usage: camelagi sessions [subcommand]

List or manage saved chat sessions.

Subcommands:
  (none)          List all sessions (default)
  rm <id>         Delete a session (prompts for confirmation)

Options:
  --yes, -y       Skip confirmation prompt (with rm)

Examples:
  camelagi sessions
  camelagi sessions rm session-abc123
  camelagi sessions rm session-abc123 --yes`,
  run: async (args) => {
    const p = await import("@clack/prompts");
    const { listSessions, deleteSession } = await import("../session.js");

    if (args[0] === "rm" && args[1]) {
      if (!hasFlag(args, "--yes") && !hasFlag(args, "-y")) {
        const ok = await p.confirm({ message: `Delete session "${args[1]}"?` });
        if (p.isCancel(ok) || !ok) {
          p.cancel("Cancelled.");
          return;
        }
      }

      deleteSession(args[1]);
      p.log.success(`Deleted session: ${args[1]}`);
      return;
    }

    if (args[0] && args[0] !== "rm") {
      p.log.error(`Unknown subcommand: ${args[0]}. Use: camelagi sessions [rm <id>]`);
      process.exit(1);
    }

    const sessions = listSessions();
    if (sessions.length === 0) {
      p.log.info("No sessions.");
    } else {
      for (const s of sessions) {
        const date = new Date(s.createdAt).toLocaleString();
        const label = s.label ? `, ${s.label}` : "";
        p.log.info(`${s.id}  (${s.model}${label}, ${date})`);
      }
    }
  },
});
