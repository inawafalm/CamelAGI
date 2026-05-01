// Gateway WebSocket handler

import type { WebSocketServer, WebSocket } from "ws";
import { loadConfig } from "../core/config.js";
import { createClient } from "../model.js";
import { buildSystemPrompt } from "../system-prompt.js";
import type { AgentEvent } from "../agent.js";
import { loadMessages, listSessions, deleteSession, getSessionMeta } from "../session.js";
import type { SdkTag } from "../session.js";
import { getActiveRunCount } from "../runtime/runs.js";
import { compactHistory } from "../runtime/compact.js";
import { getLaneStats } from "../runtime/lanes.js";
import { orchestrate } from "../runtime/orchestrate.js";
import { getSessionUsage } from "../usage.js";
import { CHARS_PER_TOKEN } from "../core/constants.js";
import { errorMessage } from "../core/errors.js";
import { submitDecision, type ApprovalDecision } from "../extensions/approvals.js";
import type { Config } from "../core/config.js";
import type { GatewayState } from "./state.js";
import { checkAuth, send, logMessage, notifyWatchers, parseTokenFromUrl } from "./state.js";

/** Mutable per-connection state shared across handlers */
interface WsSession {
  abortController: AbortController | null;
  currentRunId: string | null;
  sdkSessionId: string | undefined;
}

// --- Individual message handlers ---

async function handleChat(
  ws: WebSocket, state: GatewayState, session: WsSession, msg: Record<string, unknown>,
): Promise<void> {
  const sid = (msg.session as string) ?? `ws-${Date.now()}`;
  logMessage(state, "tui", "in", sid, msg.message as string);

  session.abortController = new AbortController();
  const resumeId = (msg.sdkSessionId as string | undefined) ?? session.sdkSessionId;
  const requestedSdk = (msg.sdk as SdkTag | undefined) ?? undefined;

  try {
    const result = await orchestrate({
      sessionId: sid,
      message: msg.message as string,
      config: state.config,
      systemPrompt: state.systemPrompt,
      client: state.client,
      signal: session.abortController.signal,
      resumeSessionId: resumeId,
      sdk: requestedSdk,
      onEvent: (event: AgentEvent) => {
        if (event.type === "init") {
          session.sdkSessionId = event.sessionId;
        }
        send(ws, event);
        // Broadcast key events to watchers
        if (["tool_call", "tool_result", "thinking", "subagent_start", "subagent_done", "stream_text"].includes(event.type)) {
          notifyWatchers(state, { ...event as Record<string, unknown>, _session: sid });
        }
      },
      onRetry: (attempt, kind) => {
        send(ws, { type: "retry", attempt, kind });
        notifyWatchers(state, { type: "watch.retry", session: sid, attempt, kind, ts: Date.now() });
      },
      onCompact: (oldCount, newCount) => {
        send(ws, { type: "compacted", oldCount, newCount });
      },
    });

    if (result.queued) {
      send(ws, { type: "queued", session: sid });
    } else {
      if (result.response) {
        logMessage(state, "tui", "out", sid, result.response);
      }
      notifyWatchers(state, { type: "watch.done", session: sid, runId: result.runId, ts: Date.now() });
      if (result.sdkSessionId) {
        session.sdkSessionId = result.sdkSessionId;
      }
      session.currentRunId = result.runId;

      send(ws, {
        type: "done",
        response: result.response,
        session: sid,
        runId: result.runId,
        usage: result.usage,
        sdkSessionId: session.sdkSessionId,
        sdk: result.sdk,
      });
    }
  } finally {
    session.abortController = null;
    session.currentRunId = null;
  }
}

function handleSessionsList(ws: WebSocket): void {
  send(ws, { type: "sessions", sessions: listSessions() });
}

function handleSessionsDelete(ws: WebSocket, msg: Record<string, unknown>): void {
  if (msg.id) deleteSession(msg.id as string);
  send(ws, { type: "sessions", sessions: listSessions() });
}

function handleSessionsHistory(ws: WebSocket, msg: Record<string, unknown>): void {
  const histSid = (msg.id ?? msg.session ?? "") as string;
  const messages = loadMessages(histSid);
  const meta = getSessionMeta(histSid);
  send(ws, {
    type: "history",
    session: histSid,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    sdk: meta?.sdk ?? "claude",
  });
}

async function handleCompact(ws: WebSocket, state: GatewayState, msg: Record<string, unknown>): Promise<void> {
  const compactSid = msg.session as string;
  if (!compactSid) {
    send(ws, { type: "error", message: "session is required" });
    return;
  }
  const history = loadMessages(compactSid);
  const result = await compactHistory(state.client, state.config.model, history, {
    ...state.config.compaction,
    enabled: true,
  });
  send(ws, {
    type: "compacted",
    session: compactSid,
    oldCount: history.length,
    newCount: result ? result.length : history.length,
  });
}

function handleStatus(ws: WebSocket, state: GatewayState, msg: Record<string, unknown>): void {
  const statusSid = (msg.session ?? "") as string;
  const usage = getSessionUsage(statusSid);
  const messages = loadMessages(statusSid);
  const historyChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const meta = getSessionMeta(statusSid);
  send(ws, {
    type: "status",
    session: statusSid,
    model: state.config.model,
    provider: state.config.provider,
    messageCount: messages.length,
    historyTokens: Math.ceil(historyChars / CHARS_PER_TOKEN),
    usage: usage.calls > 0 ? usage : null,
    lanes: getLaneStats(),
    activeRuns: getActiveRunCount(),
    sdk: meta?.sdk ?? "claude",
  });
}

function handleModelSwitch(ws: WebSocket, state: GatewayState, msg: Record<string, unknown>): void {
  try {
    const newModel = msg.model as string | undefined;
    const newThinking = msg.thinking as string | undefined;
    const newEffort = msg.effort as string | undefined;
    if (newModel) state.config = { ...state.config, model: newModel };
    if (newThinking) state.config = { ...state.config, thinking: newThinking as Config["thinking"] };
    if (newEffort) state.config = { ...state.config, effort: newEffort as Config["effort"] };
    state.client = createClient(state.config);
    state.systemPrompt = buildSystemPrompt(state.config.systemPrompt);
    send(ws, { type: "model.switched", model: state.config.model, thinking: state.config.thinking, effort: state.config.effort });
  } catch (err: unknown) {
    send(ws, { type: "error", message: `Model switch failed: ${errorMessage(err)}` });
  }
}

function handleAbort(ws: WebSocket, session: WsSession): void {
  if (session.abortController) {
    session.abortController.abort();
    session.abortController = null;
    send(ws, { type: "aborted" });
  }
}

function handleWatch(ws: WebSocket, state: GatewayState): void {
  state.watchers.add(ws);
  const sessions = listSessions();
  send(ws, {
    type: "watch.snapshot",
    uptime: Math.floor((Date.now() - state.startTime) / 1000),
    sessions,
    activeRuns: getActiveRunCount(),
    lanes: getLaneStats(),
    clients: state.clients.size,
    watchers: state.watchers.size,
    agents: Object.keys(state.config.agents),
    model: state.config.model,
    tailscaleUrl: state.tailscaleUrl ?? null,
  });
}

function handleApprovalDecide(ws: WebSocket, msg: Record<string, unknown>): void {
  const id = msg.id as string;
  const decision = msg.decision as ApprovalDecision;
  if (!id || !decision) {
    send(ws, { type: "error", message: "approval.decide requires id and decision" });
    return;
  }
  const resolved = submitDecision(id, decision);
  if (!resolved) {
    send(ws, { type: "error", message: "Approval not found or already resolved" });
  }
}

// --- Main handler registration ---

export function registerWsHandler(wss: WebSocketServer, state: GatewayState): void {
  wss.on("connection", (ws, req) => {
    if (!checkAuth(state, req.headers.authorization ?? parseTokenFromUrl(req.url))) {
      ws.close(4001, "Unauthorized");
      return;
    }

    state.clients.add(ws);
    const alive = { value: true };
    ws.on("pong", () => { alive.value = true; });

    const session: WsSession = {
      abortController: null,
      currentRunId: null,
      sdkSessionId: undefined,
    };

    ws.on("message", async (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", message: "Invalid JSON" });
        return;
      }

      try {
        switch (msg.type) {
          case "chat":             await handleChat(ws, state, session, msg); break;
          case "sessions.list":    handleSessionsList(ws); break;
          case "sessions.delete":  handleSessionsDelete(ws, msg); break;
          case "sessions.history": handleSessionsHistory(ws, msg); break;
          case "compact":          await handleCompact(ws, state, msg); break;
          case "status":           handleStatus(ws, state, msg); break;
          case "model.switch":     handleModelSwitch(ws, state, msg); break;
          case "abort":            handleAbort(ws, session); break;
          case "watch":            handleWatch(ws, state); break;
          case "approval.decide":  handleApprovalDecide(ws, msg); break;
          default:                 send(ws, { type: "error", message: `Unknown type: ${msg.type}` });
        }
      } catch (err: unknown) {
        send(ws, { type: "error", message: errorMessage(err) });
      }
    });

    ws.on("close", () => {
      state.clients.delete(ws);
      state.watchers.delete(ws);
      if (session.abortController) session.abortController.abort();
    });
  });
}
