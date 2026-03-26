// Heartbeat runner: periodic agent execution based on HEARTBEAT.md

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../core/config.js";
import { runAgent } from "../agent.js";
import { loadMessages, saveMessage } from "../session.js";
import { agentMemoryDir, isHeartbeatEmpty } from "../workspace.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { log as slog } from "../core/log.js";

const HEARTBEAT_SESSION = "heartbeat";

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 30 * 60_000; // default 30m
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s": return value * 1000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    case "d": return value * 86_400_000;
    default: return 30 * 60_000;
  }
}

export function startHeartbeat(
  config: Config,
  opts?: {
    onRun?: (response: string) => void;
    onSkip?: (reason: string) => void;
    onError?: (err: Error) => void;
  },
): void {
  stopHeartbeat();
  if (!config.heartbeat?.enabled) return;
  if (!config.apiKey) return;

  const intervalMs = parseInterval(config.heartbeat.interval);

  const run = async () => {
    try {
      // Read HEARTBEAT.md from global workspace
      const heartbeatPath = path.join(agentMemoryDir(), "HEARTBEAT.md");
      if (!fs.existsSync(heartbeatPath)) {
        opts?.onSkip?.("HEARTBEAT.md not found");
        return;
      }

      const content = fs.readFileSync(heartbeatPath, "utf-8");
      if (isHeartbeatEmpty(content)) {
        opts?.onSkip?.("empty");
        return;
      }

      // Build heartbeat-specific system prompt (AGENTS.md + TOOLS.md + HEARTBEAT.md)
      const systemPrompt = buildSystemPrompt(
        config.systemPrompt,
        config.skills,
        undefined,
        "heartbeat",
      );

      const prompt = config.heartbeat.prompt;
      const history = loadMessages(HEARTBEAT_SESSION);

      const result = await runAgent(config.apiKey!, config.model, systemPrompt, history, prompt, {
        maxTurns: 10,
        timeoutMs: 120_000,
        provider: config.provider,
        baseUrl: config.baseUrl,
      });

      saveMessage(HEARTBEAT_SESSION, { role: "user", content: prompt }, config.model, "heartbeat");
      if (result.response) {
        saveMessage(HEARTBEAT_SESSION, { role: "assistant", content: result.response }, config.model, "heartbeat");
      }

      opts?.onRun?.(result.response);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      opts?.onError?.(error);
    }
  };

  heartbeatTimer = setInterval(run, intervalMs);
  slog.info("heartbeat", `Started with interval ${config.heartbeat.interval}`);
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
