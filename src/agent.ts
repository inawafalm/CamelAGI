// Agent: routes to Claude Agent SDK or Cursor SDK based on opts.sdk

import { runHooks } from "./extensions/hooks.js";
import type { Message } from "./core/types.js";

export type { RunResult, AgentEvent, AgentOpts } from "./agent/types.js";
import type { RunResult, AgentOpts } from "./agent/types.js";

// Clear CLAUDECODE env var to prevent "nested session" error
delete process.env.CLAUDECODE;

export async function runAgent(
  apiKey: string,
  model: string,
  systemPrompt: string,
  history: Message[],
  userMessage: string,
  opts?: AgentOpts,
): Promise<RunResult> {
  if (opts?.hooksEnabled) {
    await runHooks("before_prompt", { sessionId: opts.sessionId, message: userMessage });
  }

  let result: RunResult;

  if (opts?.sdk === "cursor") {
    const { runAgentCursor } = await import("./agent/agent-cursor.js");
    result = await runAgentCursor(apiKey, model, systemPrompt, history, userMessage, opts);
  } else {
    // Default: Claude Agent SDK
    const { runAgentSdk } = await import("./agent/agent-sdk.js");
    result = await runAgentSdk(apiKey, model, systemPrompt, history, userMessage, opts);
  }

  if (opts?.hooksEnabled) {
    await runHooks("after_response", { sessionId: opts.sessionId, response: result.response });
  }

  return result;
}
