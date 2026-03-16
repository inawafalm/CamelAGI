// Gateway server: Express + WebSocket — single orchestration point
// Routes and WS logic are in gateway/*.ts

import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type Anthropic from "@anthropic-ai/sdk";
import { loadConfig, ensureDirs, onConfigSaved, type Config } from "./core/config.js";
import { createClient } from "./model.js";
import { seedWorkspace } from "./workspace.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { startCronJob, stopAllCronJobs, startRuntimeJobs, setCronContext, type CronJob } from "./extensions/cron.js";
import { configureLane, Lane } from "./runtime/lanes.js";
import { runBoot } from "./boot.js";
import { errorMessage } from "./core/errors.js";
import { log as slog } from "./core/log.js";
import { HEARTBEAT_INTERVAL_MS } from "./core/constants.js";
import type { GatewayState } from "./gateway/state.js";
import { registerRoutes } from "./gateway/routes.js";
import { registerWsHandler } from "./gateway/ws-handler.js";
import { requestLogger } from "./gateway/logger.js";
import { rateLimit } from "./gateway/rate-limit.js";
import { csrfProtection } from "./gateway/csrf.js";
import fs from "node:fs";

export interface ServeOpts {
  port?: number;
  host?: string;
  channels?: boolean;
  cron?: boolean;
  boot?: boolean;
  silent?: boolean;
}

export interface ServerHandle {
  port: number;
  close: () => Promise<void>;
  config: Config;
  client: Anthropic;
  systemPrompt: string;
}

export async function startServer(opts: ServeOpts = {}): Promise<ServerHandle> {
  ensureDirs();
  seedWorkspace();
  const config = loadConfig();
  // Startup config logged below in the formatted block

  const state: GatewayState = {
    config,
    client: createClient(config),
    systemPrompt: buildSystemPrompt(config.systemPrompt, config.skills),
    token: config.serve.token,
    silent: !!opts.silent,
    clients: new Set<WebSocket>(),
    startTime: Date.now(),
  };

  configureLane(Lane.Main, config.lanes.main);
  configureLane(Lane.Cron, config.lanes.cron);
  configureLane(Lane.Subagent, config.lanes.subagent);

  // Immediately sync in-memory state on every saveConfig call (no debounce)
  onConfigSaved((fresh) => {
    state.config = fresh;
    state.systemPrompt = buildSystemPrompt(fresh.systemPrompt, fresh.skills);
  });

  // Set cron context so runtime-added jobs can auto-start
  setCronContext(state.config, state.systemPrompt);

  const requestedPort = opts.port ?? config.serve.port;
  const host = opts.host ?? config.serve.host;
  const log = opts.silent ? (..._a: unknown[]) => {} : console.log;

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(csrfProtection());
  if (!opts.silent) {
    app.use(requestLogger());
  }
  app.use(rateLimit(config.serve.rateLimit));

  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  // Heartbeat
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const ws of state.clients) {
      if (!alive.get(ws)) {
        state.clients.delete(ws);
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Track pong per-client in WS handler
  wss.on("connection", (ws) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
  });

  // Register handlers
  registerRoutes(app, state);
  registerWsHandler(wss, state);

  // Start listening
  const actualPort = await new Promise<number>((resolve) => {
    server.listen(requestedPort, host, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : requestedPort);
    });
  });

  const agents = Object.keys(state.config.agents);
  const apiStatus = state.config.apiKey ? "\x1b[32mset\x1b[0m" : "\x1b[33mnot set\x1b[0m";

  console.log("");
  console.log(`  \x1b[36m╭─────────────────────────────────────╮\x1b[0m`);
  console.log(`  \x1b[36m│\x1b[0m  \x1b[1m\x1b[36mCamelAGI\x1b[0m  gateway                  \x1b[36m│\x1b[0m`);
  console.log(`  \x1b[36m├─────────────────────────────────────┤\x1b[0m`);
  console.log(`  \x1b[36m│\x1b[0m  HTTP   http://${host}:${actualPort}${" ".repeat(Math.max(0, 19 - String(actualPort).length - host.length))} \x1b[36m│\x1b[0m`);
  console.log(`  \x1b[36m│\x1b[0m  WS     ws://${host}:${actualPort}${" ".repeat(Math.max(0, 21 - String(actualPort).length - host.length))} \x1b[36m│\x1b[0m`);
  console.log(`  \x1b[36m│\x1b[0m  API    ${apiStatus}${" ".repeat(Math.max(0, state.config.apiKey ? 27 : 23))} \x1b[36m│\x1b[0m`);
  if (agents.length > 0) {
    const agentStr = agents.join(", ");
    console.log(`  \x1b[36m│\x1b[0m  Agents ${agentStr}${" ".repeat(Math.max(0, 29 - agentStr.length))} \x1b[36m│\x1b[0m`);
  }
  console.log(`  \x1b[36m╰─────────────────────────────────────╯\x1b[0m`);
  console.log("");

  // Boot script
  if (opts.boot !== false && state.config.boot) {
    try {
      const bootResult = await runBoot(state.config, state.systemPrompt);
      if (bootResult.status === "ran") {
        log(`  BOOT.md: ${bootResult.response?.slice(0, 80) ?? "done"}`);
      } else if (bootResult.status === "failed") {
        log(`  BOOT.md failed: ${bootResult.error}`);
      }
    } catch { /* best effort */ }
  }

  // Channels (Telegram, Discord, Slack, etc.)
  if (opts.channels !== false) {
    try {
      const { loadChannels, startAllChannels } = await import("./channels/index.js");
      await loadChannels(state.config);
      const started = await startAllChannels(() => state.config, () => state.systemPrompt);
      for (const [type, ids] of started) {
        log(`  ${type}: ${ids.length} bot(s) started [${ids.join(", ")}]`);
      }
    } catch (err: unknown) {
      slog.error("channels", "Failed to start", { error: errorMessage(err) });
    }
  }

  // Cron (config-defined + runtime-defined)
  if (opts.cron !== false) {
    const cronOpts = {
      onRun: (id: string, response: string) => { log(`  Cron ${id}: ${response.slice(0, 80)}`); },
      onError: (id: string, err: Error) => { slog.error("cron", `Job ${id} failed`, { jobId: id, error: err.message }); },
    };

    const enabledJobs = state.config.cron.filter((j: CronJob) => j.enabled);
    for (const job of enabledJobs) {
      startCronJob({ ...job, source: "config" }, state.config, state.systemPrompt, cronOpts);
    }

    const runtimeCount = startRuntimeJobs(state.config, state.systemPrompt, cronOpts);
    const totalCount = enabledJobs.length + runtimeCount;
    if (totalCount > 0) {
      log(`  ${totalCount} cron job(s) started (${enabledJobs.length} config, ${runtimeCount} runtime)`);
    }
  }

  // Config hot-reload
  const channelsEnabled = opts.channels !== false;
  const configWatcher = watchConfig(state.config, (newConfig) => {
    const oldAgentKeys = Object.keys(state.config.agents);
    const newAgentKeys = Object.keys(newConfig.agents);
    state.config = newConfig;
    state.systemPrompt = buildSystemPrompt(state.config.systemPrompt, state.config.skills);
    // Only log if agents actually changed
    if (oldAgentKeys.join(",") !== newAgentKeys.join(",")) {
      console.log(`  \x1b[90m${new Date().toLocaleTimeString()}\x1b[0m \x1b[36m›\x1b[0m \x1b[90m[config]\x1b[0m Agents: [${newAgentKeys.join(", ")}]`);
    }
    configureLane(Lane.Main, state.config.lanes.main);
    configureLane(Lane.Cron, state.config.lanes.cron);
    configureLane(Lane.Subagent, state.config.lanes.subagent);
    setCronContext(state.config, state.systemPrompt);

    // Reconcile channels: start new bots, stop removed ones
    if (channelsEnabled) {
      import("./channels/index.js")
        .then(({ reconcileAllChannels }) => reconcileAllChannels(() => state.config, () => state.systemPrompt))
        .catch(() => {});
    }
  });

  // Close handle
  const close = async () => {
    clearInterval(heartbeat);
    configWatcher?.close();
    stopAllCronJobs();
    for (const ws of state.clients) ws.close(1001, "Server shutting down");
    try {
      const { stopAllChannels } = await import("./channels/index.js");
      stopAllChannels();
    } catch { /* channels not loaded */ }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  if (!opts.silent) {
    const shutdown = async () => {
      console.log("\nShutting down...");
      await close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  return { port: actualPort, close, config: state.config, client: state.client, systemPrompt: state.systemPrompt };
}


function watchConfig(
  _initialConfig: Config,
  onChange: (config: Config) => void,
): fs.FSWatcher | null {
  try {
    const configDir = `${process.env.HOME}/.camelagi`;
    // Watch the DIRECTORY, not the file — so we detect config.yaml being created
    // (e.g. after a reset + onboarding)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    let debounce: NodeJS.Timeout | null = null;
    const watcher = fs.watch(configDir, (_event, filename) => {
      if (filename !== "config.yaml") return;
      // Silent — only log on error
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        try {
          const newConfig = loadConfig();
          onChange(newConfig);
        } catch (err) {
          console.error(`[watchConfig] Failed to reload config:`, err);
        }
      }, 500);
    });
    // Silent — watcher active
    return watcher;
  } catch (err) {
    console.error(`[watchConfig] FAILED to set up watcher:`, err);
    return null;
  }
}
