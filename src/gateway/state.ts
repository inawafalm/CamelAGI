// Gateway shared state

import { createHash, timingSafeEqual } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { WebSocket } from "ws";
import type { Config } from "../core/config.js";
import type { Message } from "../core/types.js";
import { loadMessages } from "../session.js";
import { compactHistory } from "../runtime/compact.js";

export interface GatewayState {
  config: Config;
  client: Anthropic;
  systemPrompt: string;
  token: string | undefined;
  silent: boolean;
  clients: Set<WebSocket>;
  watchers: Set<WebSocket>;
  startTime: number;
  tailscaleUrl?: string;
}

/** Timing-safe token comparison — prevents timing attacks that leak token info */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function checkAuth(state: GatewayState, authHeader: string | undefined): boolean {
  if (!state.token) return true;
  if (!authHeader) return false;
  return safeEqual(authHeader, `Bearer ${state.token}`);
}

export function send(ws: WebSocket, data: unknown) {
  if (ws.readyState === 1 /* WebSocket.OPEN */) {
    ws.send(JSON.stringify(data));
  }
}

export function broadcast(state: GatewayState, data: unknown) {
  const json = JSON.stringify(data);
  for (const ws of state.clients) {
    if (ws.readyState === 1) ws.send(json);
  }
}

/** Send an event to all watcher clients */
export function notifyWatchers(state: GatewayState, data: unknown) {
  if (state.watchers.size === 0) return;
  const json = JSON.stringify(data);
  for (const ws of state.watchers) {
    if (ws.readyState === 1) ws.send(json);
  }
}

export function logMessage(
  state: GatewayState,
  channel: string,
  direction: "in" | "out",
  sessionId: string,
  text: string,
) {
  // Notify watchers
  notifyWatchers(state, {
    type: "watch.message",
    channel,
    direction,
    sessionId,
    text: text.slice(0, 500),
    ts: Date.now(),
  });

  if (state.silent) return;
  const arrow = direction === "in" ? `\x1b[36m→\x1b[0m` : `\x1b[32m←\x1b[0m`;
  const tag = `\x1b[90m[${channel}:${sessionId.slice(0, 16)}]\x1b[0m`;
  const preview = text.slice(0, 160).replace(/\n/g, " ");
  const suffix = text.length > 160 ? `\x1b[90m…\x1b[0m` : "";
  console.log(`  ${arrow} ${tag} ${preview}${suffix}`);
}

export function parseTokenFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = url.match(/[?&]token=([^&]+)/);
  return match ? `Bearer ${match[1]}` : undefined;
}

/** Load history + run compaction for a session */
export async function prepareHistory(
  state: GatewayState,
  sid: string,
): Promise<{ history: Message[]; compacted: boolean }> {
  let history = loadMessages(sid);
  const result = await compactHistory(state.client, state.config.model, history, state.config.compaction);
  if (result) {
    return { history: result, compacted: true };
  }
  return { history, compacted: false };
}
