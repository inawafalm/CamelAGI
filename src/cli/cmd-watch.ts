// camel watch — monitor a running CamelAGI gateway in real-time

import { register } from "./registry.js";
import { getFlag } from "./parse.js";
import { WebSocket } from "ws";

const c = "\x1b[36m", g = "\x1b[90m", y = "\x1b[33m", r = "\x1b[31m",
      gr = "\x1b[32m", b = "\x1b[1m", x = "\x1b[0m", dim = "\x1b[2m";

register({
  name: "watch",
  description: "Monitor a running gateway",
  usage: `Usage: camelagi watch [url] [options]

Watch live activity on a CamelAGI gateway.

Arguments:
  [url]              Gateway URL (default: ws://127.0.0.1:18305)

Options:
  --token <token>    Auth token (or CAMELAGI_TOKEN env var)

Examples:
  camelagi watch
  camelagi watch ws://192.168.1.10:18305
  camelagi watch wss://my-mac.tailnet.ts.net --token <token>`,
  run: async (args) => {
    let rawUrl = args.find((a) => !a.startsWith("--")) ?? "ws://127.0.0.1:18305";

    // Normalize URL
    if (rawUrl.startsWith("http://")) rawUrl = rawUrl.replace("http://", "ws://");
    else if (rawUrl.startsWith("https://")) rawUrl = rawUrl.replace("https://", "wss://");
    else if (!rawUrl.startsWith("ws://") && !rawUrl.startsWith("wss://")) rawUrl = `ws://${rawUrl}`;

    // Auto-append port if missing (skip .ts.net hostnames)
    const urlObj = new URL(rawUrl);
    if (!urlObj.port && !urlObj.hostname.includes(".ts.net")) {
      urlObj.port = "18305";
      rawUrl = urlObj.toString();
    }

    const token = getFlag(args, "--token") ?? process.env.CAMELAGI_TOKEN;

    // Append token to URL
    if (token) {
      const sep = rawUrl.includes("?") ? "&" : "?";
      rawUrl = `${rawUrl}${sep}token=${encodeURIComponent(token)}`;
    }

    console.log(`\n  ${b}${c}CamelAGI Watch${x}`);
    console.log(`  ${g}Connecting to ${rawUrl.replace(/token=[^&]+/, "token=***")}${x}\n`);

    const ws = new WebSocket(rawUrl);
    let connected = false;
    const events: string[] = [];
    const MAX_EVENTS = 200;

    function addEvent(line: string) {
      events.push(line);
      if (events.length > MAX_EVENTS) events.shift();
      console.log(line);
    }

    function timestamp(): string {
      return `${g}${new Date().toLocaleTimeString()}${x}`;
    }

    ws.on("open", () => {
      connected = true;
      addEvent(`  ${timestamp()} ${gr}●${x} Connected`);
      // Subscribe as watcher
      ws.send(JSON.stringify({ type: "watch" }));
    });

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const type = msg.type as string;

      switch (type) {
        case "watch.snapshot": {
          // Initial state dump
          const uptime = msg.uptime as number;
          const sessions = (msg.sessions as unknown[])?.length ?? 0;
          const activeRuns = msg.activeRuns as number;
          const clients = msg.clients as number;
          const watchers = msg.watchers as number;
          const agents = (msg.agents as string[]) ?? [];
          const model = msg.model as string;
          const tsUrl = msg.tailscaleUrl as string | null;

          const h = Math.floor(uptime / 3600);
          const m = Math.floor((uptime % 3600) / 60);
          const uptimeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;

          console.log(`  ${g}${"─".repeat(50)}${x}`);
          console.log(`  ${b}Gateway${x}  ${gr}online${x} for ${uptimeStr}`);
          console.log(`  ${b}Model${x}    ${model}`);
          if (agents.length > 0) {
            console.log(`  ${b}Agents${x}   ${agents.join(", ")}`);
          }
          console.log(`  ${b}Sessions${x} ${sessions}  ${b}Active${x} ${activeRuns}  ${b}Clients${x} ${clients}  ${b}Watchers${x} ${watchers}`);
          if (tsUrl) {
            console.log(`  ${b}Tailscale${x} ${c}${tsUrl}${x}`);
          }
          console.log(`  ${g}${"─".repeat(50)}${x}`);
          console.log(`\n  ${dim}Watching live events... (Ctrl+C to exit)${x}\n`);
          break;
        }

        case "watch.message": {
          const dir = msg.direction as string;
          const channel = msg.channel as string;
          const sid = (msg.sessionId as string)?.slice(0, 20) ?? "?";
          const text = (msg.text as string)?.slice(0, 120)?.replace(/\n/g, " ") ?? "";
          const arrow = dir === "in" ? `${c}→${x}` : `${gr}←${x}`;
          addEvent(`  ${timestamp()} ${arrow} ${g}[${channel}:${sid}]${x} ${text}`);
          break;
        }

        case "tool_call": {
          const name = msg.name as string ?? "?";
          const sid = (msg._session as string)?.slice(0, 20) ?? "";
          addEvent(`  ${timestamp()} ${y}⚡${x} ${g}[${sid}]${x} Tool: ${c}${name}${x}`);
          break;
        }

        case "tool_result": {
          const sid = (msg._session as string)?.slice(0, 20) ?? "";
          addEvent(`  ${timestamp()} ${gr}✓${x} ${g}[${sid}]${x} Tool result`);
          break;
        }

        case "thinking": {
          const sid = (msg._session as string)?.slice(0, 20) ?? "";
          const thinkState = msg.state as string;
          if (thinkState === "start") {
            addEvent(`  ${timestamp()} ${y}◐${x} ${g}[${sid}]${x} Thinking...`);
          }
          break;
        }

        case "subagent_start": {
          const agentId = msg.agentId as string ?? "sub-task";
          const sid = (msg._session as string)?.slice(0, 20) ?? "";
          addEvent(`  ${timestamp()} ${c}↳${x} ${g}[${sid}]${x} Subagent: ${agentId}`);
          break;
        }

        case "subagent_done": {
          const sid = (msg._session as string)?.slice(0, 20) ?? "";
          addEvent(`  ${timestamp()} ${gr}↲${x} ${g}[${sid}]${x} Subagent done`);
          break;
        }

        case "watch.done": {
          const sid = (msg.session as string)?.slice(0, 20) ?? "";
          addEvent(`  ${timestamp()} ${gr}●${x} ${g}[${sid}]${x} Run complete`);
          break;
        }

        case "watch.retry": {
          const sid = (msg.session as string)?.slice(0, 20) ?? "";
          const kind = msg.kind as string;
          const attempt = msg.attempt as number;
          addEvent(`  ${timestamp()} ${y}↻${x} ${g}[${sid}]${x} Retry #${attempt} (${kind})`);
          break;
        }

        case "error": {
          const message = msg.message as string ?? "Unknown";
          addEvent(`  ${timestamp()} ${r}✗${x} Error: ${message}`);
          break;
        }
      }
    });

    ws.on("error", (err) => {
      if (!connected) {
        console.error(`\n  ${r}✗${x} Cannot connect to gateway`);
        console.error(`    ${err.message}\n`);
        process.exit(1);
      }
      addEvent(`  ${timestamp()} ${r}✗${x} WebSocket error: ${err.message}`);
    });

    ws.on("close", () => {
      if (connected) {
        console.log(`\n  ${y}●${x} Disconnected from gateway\n`);
      }
      process.exit(0);
    });

    // Graceful shutdown
    process.on("SIGINT", () => {
      console.log(`\n  ${g}Disconnecting...${x}`);
      ws.close();
    });

    // Keep alive
    await new Promise(() => {});
  },
});
