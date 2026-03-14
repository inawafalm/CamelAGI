import { register } from "./registry.js";
import { getFlag } from "./parse.js";

register({
  name: "chat",
  description: "Interactive REPL",
  usage: `Usage: camelagi chat [options]

Start the interactive TUI chat client.

Options:
  --session <id>   Resume a specific session

Examples:
  camelagi chat
  camelagi chat --session my-session`,
  run: async (args) => {
    const sessionId = getFlag(args, "--session");

    const { startServer } = await import("../serve.js");
    const handle = await startServer({
      port: 0,
      silent: true,
      channels: false,
      boot: false,
      cron: false,
    });

    const wsUrl = `ws://127.0.0.1:${handle.port}`;

    const { runTui } = await import("../tui/tui.js");
    await runTui({ session: sessionId, wsUrl });

    await handle.close();
  },
});
