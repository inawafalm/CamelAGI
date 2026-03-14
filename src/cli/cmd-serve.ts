import { register } from "./registry.js";
import { getFlagInt } from "./parse.js";

register({
  name: "serve",
  description: "Start gateway server",
  usage: `Usage: camelagi serve [options]

Start the gateway server (Express + WebSocket).

Options:
  --port <number>   Port to listen on (1-65535, default: from config)

Examples:
  camelagi serve
  camelagi serve --port 3000`,
  run: async (args) => {
    let port: number | undefined;
    try {
      port = getFlagInt(args, "--port", 1, 65535);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const { startServer } = await import("../serve.js");
    await startServer({ port, cron: true, boot: true });
    // startServer keeps the process alive
  },
});
