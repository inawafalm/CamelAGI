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
    const { listSessions, deleteSession } = await import("../session.js");

    if (args[0] === "rm" && args[1]) {
      if (!hasFlag(args, "--yes") && !hasFlag(args, "-y")) {
        const { default: readline } = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) =>
          rl.question(`  Delete session "${args[1]}"? (yes/no): `, resolve),
        );
        rl.close();
        if (answer.trim().toLowerCase() !== "yes") {
          console.log("  Cancelled.");
          process.exit(0);
        }
      }

      deleteSession(args[1]);
      console.log(`Deleted session: ${args[1]}`);
      process.exit(0);
    }

    if (args[0] && args[0] !== "rm") {
      console.error(`Unknown subcommand: ${args[0]}. Use: camelagi sessions [rm <id>]`);
      process.exit(1);
    }

    const sessions = listSessions();
    if (sessions.length === 0) {
      console.log("No sessions.");
    } else {
      for (const s of sessions) {
        const date = new Date(s.createdAt).toLocaleString();
        const label = s.label ? `, ${s.label}` : "";
        console.log(`  ${s.id}  (${s.model}${label}, ${date})`);
      }
    }
    process.exit(0);
  },
});
