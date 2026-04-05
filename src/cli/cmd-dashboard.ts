import { register } from "./registry.js";
import { exec } from "node:child_process";

register({
  name: "dashboard",
  description: "Open web dashboard (starts server if needed)",
  usage: `Usage: camelagi dashboard [options]

Open the web dashboard in your browser. Starts the gateway server if not already running.

Options:
  --port <number>      Port to listen on (default: from config)
  --no-open            Don't open browser automatically

Examples:
  camelagi dashboard
  camelagi dashboard --port 3000`,
  run: async (args) => {
    const { getFlag, hasFlag, getFlagInt } = await import("./parse.js");

    let port: number | undefined;
    try {
      port = getFlagInt(args, "--port", 1, 65535);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const noOpen = hasFlag(args, "--no-open");

    // Check if server is already running
    const { loadConfig } = await import("../core/config.js");
    const config = loadConfig();
    const targetPort = port ?? config.serve.port;
    const url = `http://127.0.0.1:${targetPort}`;

    let serverRunning = false;
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      serverRunning = res.ok;
    } catch {}

    if (serverRunning) {
      console.log(`\n  Gateway already running at ${url}`);
      if (!noOpen) {
        const dashUrl = `${url}/dashboard`;
        console.log(`  Opening ${dashUrl}...\n`);
        const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        exec(`${openCmd} ${dashUrl}`);
      }
      return;
    }

    // Start server
    console.log("\n  Starting gateway...\n");
    const { startServer } = await import("../serve.js");
    const handle = await startServer({ port, cron: true, boot: true });

    // Open browser
    if (!noOpen) {
      const dashUrl = `http://127.0.0.1:${handle.port}/dashboard`;
      const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      exec(`${openCmd} ${dashUrl}`);
    }

    // Keep alive
    await new Promise(() => {});
  },
});
