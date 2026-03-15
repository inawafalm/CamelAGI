// Agent: routes all models through Claude Agent SDK
// This is a barrel that re-exports types and the main entry point.

import { runHooks } from "./extensions/hooks.js";
import { runAgentSdk } from "./agent/agent-sdk.js";
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

  const result = await runAgentSdk(apiKey, model, systemPrompt, history, userMessage, opts);

  if (opts?.hooksEnabled) {
    await runHooks("after_response", { sessionId: opts.sessionId, response: result.response });
  }

  return result;
}
