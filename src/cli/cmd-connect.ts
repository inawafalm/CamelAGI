// camel connect — connect TUI to a remote CamelAGI gateway

import { register } from "./registry.js";
import { getFlag } from "./parse.js";

register({
  name: "connect",
  description: "Connect to a remote gateway",
  usage: `Usage: camelagi connect <url> [options]

Connect the TUI to a remote CamelAGI gateway.

Arguments:
  <url>              Gateway URL (e.g. ws://192.168.1.10:18305, wss://my-mac.ts.net)

Options:
  --token <token>    Auth token (or set CAMELAGI_TOKEN env var)
  --session <id>     Resume a specific session

Remote access options:
  1. Tailscale Serve — private tailnet HTTPS (recommended)
     camelagi connect wss://my-mac.tailnet.ts.net

  2. Direct with token — LAN only
     camelagi connect ws://192.168.1.10:18305 --token <token>

  3. SSH tunnel — forward port, then connect as localhost
     ssh -N -L 18305:127.0.0.1:18305 user@server
     camelagi chat

Examples:
  camelagi connect ws://192.168.1.10:18305 --token my-secret
  camelagi connect wss://my-mac.tailnet.ts.net
  camelagi connect 192.168.1.10:18305 --token my-secret`,
  run: async (args) => {
    const rawUrl = args.find((a) => !a.startsWith("--"));
    if (!rawUrl) {
      console.error("Error: URL is required.\n");
      console.error("Usage: camelagi connect <url> [--token <token>] [--session <id>]");
      process.exit(1);
    }

    // Normalize URL to ws:// or wss://
    let wsUrl: string;
    if (rawUrl.startsWith("ws://") || rawUrl.startsWith("wss://")) {
      wsUrl = rawUrl;
    } else if (rawUrl.startsWith("http://")) {
      wsUrl = rawUrl.replace("http://", "ws://");
    } else if (rawUrl.startsWith("https://")) {
      wsUrl = rawUrl.replace("https://", "wss://");
    } else {
      wsUrl = `ws://${rawUrl}`;
    }

    const token = getFlag(args, "--token") ?? process.env.CAMELAGI_TOKEN;
    const sessionId = getFlag(args, "--session");

    // Build HTTP URL for health check
    const httpUrl = wsUrl
      .replace(/^ws:\/\//, "http://")
      .replace(/^wss:\/\//, "https://");

    // Health check — verify gateway is reachable
    try {
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`${httpUrl}/health`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        console.error(`Error: Gateway returned ${res.status}. Check URL and token.`);
        process.exit(1);
      }
      console.log(`  Connected to ${httpUrl}`);
    } catch (err) {
      console.error(`Error: Cannot reach gateway at ${httpUrl}/health`);
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // Append token as query param (gateway supports ?token=xxx for WebSocket auth)
    if (token) {
      const sep = wsUrl.includes("?") ? "&" : "?";
      wsUrl = `${wsUrl}${sep}token=${encodeURIComponent(token)}`;
    }

    const { runTui } = await import("../tui/tui.js");
    await runTui({ session: sessionId, wsUrl });
  },
});
