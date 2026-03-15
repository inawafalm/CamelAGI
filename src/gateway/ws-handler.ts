// Gateway WebSocket handler

import type { WebSocketServer, WebSocket } from "ws";
import { loadConfig } from "../core/config.js";
import { createClient } from "../model.js";
import { buildSystemPrompt } from "../system-prompt.js";
import type { AgentEvent } from "../agent.js";
import { loadMessages, listSessions, deleteSession } from "../session.js";
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
import { checkAuth, send, logMessage, parseTokenFromUrl } from "./state.js";

export function registerWsHandler(wss: WebSocketServer, state: GatewayState): void {
  wss.on("connection", (ws, req) => {
    if (!checkAuth(state, req.headers.authorization ?? parseTokenFromUrl(req.url))) {
      ws.close(4001, "Unauthorized");
      return;
    }

    state.clients.add(ws);
    const alive = { value: true };
    ws.on("pong", () => { alive.value = true; });

    let abortController: AbortController | null = null;
    let currentRunId: string | null = null;
    let sdkSessionId: string | undefined;

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
          case "chat": {
            const sid = (msg.session as string) ?? `ws-${Date.now()}`;
            logMessage(state, "tui", "in", sid, msg.message as string);

            abortController = new AbortController();
            const resumeId = (msg.sdkSessionId as string | undefined) ?? sdkSessionId;

            try {
              const result = await orchestrate({
                sessionId: sid,
                message: msg.message as string,
                config: state.config,
                systemPrompt: state.systemPrompt,
                client: state.client,
                signal: abortController.signal,
                resumeSessionId: resumeId,
                onEvent: (event: AgentEvent) => {
                  if (event.type === "init") {
                    sdkSessionId = event.sessionId;
                  }
                  send(ws, event);
                },
                onRetry: (attempt, kind) => {
                  send(ws, { type: "retry", attempt, kind });
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
                if (result.sdkSessionId) {
                  sdkSessionId = result.sdkSessionId;
                }
                currentRunId = result.runId;

                send(ws, {
                  type: "done",
                  response: result.response,
                  session: sid,
                  runId: result.runId,
                  usage: result.usage,
                  sdkSessionId,
                });
              }
            } finally {
              abortController = null;
              currentRunId = null;
            }
            break;
          }

          case "sessions.list":
            send(ws, { type: "sessions", sessions: listSessions() });
            break;

          case "sessions.delete":
            if (msg.id) deleteSession(msg.id as string);
            send(ws, { type: "sessions", sessions: listSessions() });
            break;

          case "sessions.history": {
            const messages = loadMessages((msg.id ?? msg.session ?? "") as string);
            send(ws, {
              type: "history",
              session: msg.id ?? msg.session,
              messages: messages.map((m) => ({ role: m.role, content: m.content })),
            });
            break;
          }

          case "compact": {
            const compactSid = msg.session as string;
            if (!compactSid) {
              send(ws, { type: "error", message: "session is required" });
              break;
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
            break;
          }

          case "status": {
            const statusSid = (msg.session ?? "") as string;
            const usage = getSessionUsage(statusSid);
            const messages = loadMessages(statusSid);
            const historyChars = messages.reduce((sum, m) => sum + m.content.length, 0);
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
            });
            break;
          }

          case "model.switch": {
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
            break;
          }

          case "abort":
            if (abortController) {
              abortController.abort();
              abortController = null;
              send(ws, { type: "aborted" });
            }
            break;

          case "approval.decide": {
            const id = msg.id as string;
            const decision = msg.decision as ApprovalDecision;
            if (!id || !decision) {
              send(ws, { type: "error", message: "approval.decide requires id and decision" });
              break;
            }
            const resolved = submitDecision(id, decision);
            if (!resolved) {
              send(ws, { type: "error", message: "Approval not found or already resolved" });
            }
            break;
          }

          default:
            send(ws, { type: "error", message: `Unknown type: ${msg.type}` });
        }
      } catch (err: unknown) {
        send(ws, { type: "error", message: errorMessage(err) });
      }
    });

    ws.on("close", () => {
      state.clients.delete(ws);
      if (abortController) abortController.abort();
    });
  });
}
