import { register } from "./registry.js";
import { getFlag, getFlagInt } from "./parse.js";

register({
  name: "serve",
  description: "Start gateway server",
  usage: `Usage: camelagi serve [options]

Start the gateway server (Express + WebSocket).

Options:
  --port <number>      Port to listen on (1-65535, default: from config)
  --host <address>     Host to bind to (default: from config, typically 127.0.0.1)
                       Use 0.0.0.0 for remote access
  --generate-token     Generate a random auth token, save to config, and exit

Examples:
  camelagi serve
  camelagi serve --port 3000 --host 0.0.0.0
  camelagi serve --generate-token`,
  run: async (args) => {
    // --generate-token: create and save a random token, then exit
    if (args.includes("--generate-token")) {
      const { randomBytes } = await import("node:crypto");
      const { saveConfig } = await import("../core/config.js");
      const token = randomBytes(32).toString("hex");
      saveConfig({ serve: { token } });
      console.log(`\n  Token generated and saved to config:\n`);
      console.log(`  \x1b[36m${token}\x1b[0m\n`);
      console.log(`  Set this on your client: CAMELAGI_TOKEN=${token}\n`);
      process.exit(0);
    }

    let port: number | undefined;
    try {
      port = getFlagInt(args, "--port", 1, 65535);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const host = getFlag(args, "--host");

    const { startServer } = await import("../serve.js");
    await startServer({ port, host, cron: true, boot: true });
    // startServer keeps the process alive
  },
});
