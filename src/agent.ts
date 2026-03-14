// Agent: dual-path execution — routes to Claude SDK or OpenAI-compatible
// This is a barrel that re-exports types and the main entry point.

import { runHooks } from "./extensions/hooks.js";
import { runAgentSdk } from "./agent/agent-sdk.js";
import { runAgentOpenAI } from "./agent/agent-openai.js";
import type { Message } from "./core/types.js";

export type { RunResult, AgentEvent, AgentOpts } from "./agent/types.js";
import type { RunResult, AgentOpts } from "./agent/types.js";

// Clear CLAUDECODE env var to prevent "nested session" error
delete process.env.CLAUDECODE;

/** Check if a model should use the Claude Agent SDK */
function isClaudeModel(model: string): boolean {
  return model.startsWith("claude-") || model.includes("/claude-");
}

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

  const useSdk = isClaudeModel(model) && !opts?.baseUrl;
  const result = useSdk
    ? await runAgentSdk(apiKey, model, systemPrompt, history, userMessage, opts)
    : await runAgentOpenAI(apiKey, model, systemPrompt, history, userMessage, opts);

  if (opts?.hooksEnabled) {
    await runHooks("after_response", { sessionId: opts.sessionId, response: result.response });
  }

  return result;
}
