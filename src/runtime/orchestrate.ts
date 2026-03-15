// Chat orchestrator: single source of truth for the chat flow
//
// Deduplicates the check-active → queue → acquire-lane → prepare-history →
// run-agent-with-retry → save-messages → release sequence that was previously
// duplicated in routes.ts, ws-handler.ts, and agent-bot.ts.

import type { Config } from "../core/config.js";
import type { Message } from "../core/types.js";
import type { AgentEvent, RunResult } from "../agent/types.js";
import type { ErrorKind } from "./retry.js";
import { runAgent } from "../agent.js";
import { loadMessages, saveMessage } from "../session.js";
import { setActiveRun, clearActiveRun, isRunActive, generateRunId } from "./runs.js";
import { queueOrProcess, drainQueue } from "./queue.js";
import { compactHistory } from "./compact.js";
import { withRetry } from "./retry.js";
import { acquireLane, Lane } from "./lanes.js";
import type Anthropic from "@anthropic-ai/sdk";

export interface OrchestrateOpts {
  sessionId: string;
  message: string;
  config: Config;
  systemPrompt: string;
  client: Anthropic;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  onRetry?: (attempt: number, kind: ErrorKind) => void;
  onCompact?: (oldCount: number, newCount: number) => void;
  agentId?: string;
  resumeSessionId?: string;
  /** Label for session persistence (e.g. "AgentName: ChatTitle") */
  label?: string;
  /** Model override (for per-chat runtime model switching) */
  model?: string;
  /** System prompt override (for agent-specific prompts) */
  agentSystemPrompt?: string;
  /** Thinking override */
  thinking?: Config["thinking"];
  /** Effort override */
  effort?: Config["effort"];
  /** Max turns override */
  maxTurns?: number;
}

export interface OrchestrateResult {
  response: string;
  runId: string;
  sessionId: string;
  usage: RunResult["usage"];
  sdkSessionId?: string;
  queued?: boolean;
}

/**
 * Orchestrate a single chat turn. Handles:
 * - Queue check (if a run is already active on this session)
 * - Lane acquisition
 * - History loading + compaction
 * - Agent execution with retry
 * - Message persistence
 * - Cleanup (clear run, release lane)
 */
export async function orchestrate(opts: OrchestrateOpts): Promise<OrchestrateResult> {
  const {
    sessionId, message, config, systemPrompt, client,
    signal, onEvent, onRetry, onCompact,
    agentId, resumeSessionId, label,
  } = opts;

  const model = opts.model ?? config.model;
  const agentSystemPrompt = opts.agentSystemPrompt ?? systemPrompt;
  const thinking = opts.thinking ?? config.thinking;
  const effort = opts.effort ?? config.effort;
  const maxTurns = opts.maxTurns ?? config.maxTurns;

  // If a run is already active, queue this message
  if (isRunActive(sessionId)) {
    const queueResult = await queueOrProcess(sessionId, message);
    if (queueResult.queued) {
      const response = await queueResult.promise;
      return { response, runId: "", sessionId, usage: null, queued: true };
    }
  }

  const release = await acquireLane(Lane.Main);
  const runId = generateRunId();
  const abortController = signal ? new AbortController() : undefined;

  if (signal && abortController) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  let streaming = false;

  setActiveRun(sessionId, {
    sessionId,
    runId,
    startedAt: Date.now(),
    abort: () => abortController?.abort(),
    isStreaming: () => streaming,
  });

  try {
    // Load + compact history
    let history = loadMessages(sessionId);
    const compacted = await compactHistory(client, model, history, { ...config.compaction, agentId });
    if (compacted) {
      onCompact?.(history.length, compacted.length);
      history = compacted;
    }

    streaming = true;
    const result = await withRetry(
      () => runAgent(config.apiKey!, model, agentSystemPrompt, history, message, {
        maxTurns,
        timeoutMs: config.timeoutSeconds * 1000,
        signal: abortController?.signal,
        onEvent,
        toolPolicy: config.tools,
        hooksEnabled: config.hooks.enabled,
        sessionId,
        thinking,
        effort,
        provider: config.provider,
        baseUrl: config.baseUrl,
        approvals: config.approvals,
        ...(Object.keys(config.mcp.servers).length > 0 && { mcpServers: config.mcp.servers }),
        ...(config.maxBudgetUsd && { maxBudgetUsd: config.maxBudgetUsd }),
        ...(resumeSessionId && { resumeSessionId }),
        ...(agentId && { agentId }),
      }),
      {
        maxRetries: config.retry.maxRetries,
        backoffMs: config.retry.backoffMs,
        onRetry: onRetry
          ? (attempt, kind) => onRetry(attempt, kind)
          : undefined,
        onCompact: async () => {
          const h = loadMessages(sessionId);
          await compactHistory(client, model, h, { ...config.compaction, enabled: true, agentId });
        },
      },
    );
    streaming = false;

    // Persist messages
    saveMessage(sessionId, { role: "user", content: message }, model, label);
    if (result.response) {
      saveMessage(sessionId, { role: "assistant", content: result.response }, model, label);
    }

    return {
      response: result.response,
      runId,
      sessionId,
      usage: result.usage,
      sdkSessionId: result.sessionId,
    };
  } finally {
    clearActiveRun(runId);
    release();

    // Drain queued messages: process the next one, reject the rest
    const queued = drainQueue(sessionId);
    if (queued.length > 0) {
      const next = queued[0];
      orchestrate({ ...opts, message: next.text })
        .then((r) => next.resolve(r.response))
        .catch((err) => next.reject(err instanceof Error ? err : new Error(String(err))));
      for (const q of queued.slice(1)) {
        q.reject(new Error("Superseded by newer message"));
      }
    }
  }
}
