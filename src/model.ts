// Anthropic SDK client for direct API calls (compaction, doctor)

import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./core/config.js";
import type { TokenUsage } from "./core/types.js";
import { DEFAULT_MAX_TOKENS } from "./core/constants.js";

export function createClient(config: Config): Anthropic {
  const apiKey = config.apiKey ?? "not-configured";
  return new Anthropic({ apiKey });
}

export interface ChatResult {
  content: string;
  usage: TokenUsage | null;
}

/** Direct API call — used by compaction and doctor, not by the agent loop */
export async function chatDirect(
  client: Anthropic,
  model: string,
  system: string,
  userContent: string,
): Promise<ChatResult> {
  const response = await client.messages.create({
    model,
    max_tokens: DEFAULT_MAX_TOKENS,
    system,
    messages: [{ role: "user", content: userContent }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return {
    content: text,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: (response.usage as any).cache_read_input_tokens ?? 0,
      cacheWriteTokens: (response.usage as any).cache_creation_input_tokens ?? 0,
    },
  };
}
