// Agent config resolution for Telegram

import type { Config } from "../core/config.js";
import { buildSystemPrompt } from "../system-prompt.js";
import type { ResolvedAgent } from "./types.js";

export interface RuntimeOverrides {
  model?: string;
  thinking?: Config["thinking"];
  effort?: Config["effort"];
  briefMode?: boolean;
}

const BRIEF_MODE_INSTRUCTION = `

## Response Style (Telegram)
You're replying in a Telegram chat — keep responses short and conversational, like a text message. Lead with the answer. Skip markdown formatting (no headers, no code fences unless asked). If the answer needs depth, give the key point first then offer to elaborate. Be helpful, not verbose.`;

/** Resolve an agent's config from current config state (supports hot-reload) */
export function resolveAgent(
  agentId: string,
  config: Config,
  globalSystemPrompt: string,
  overrides?: RuntimeOverrides,
): ResolvedAgent {
  if (agentId === "telegram") {
    // Legacy top-level telegram config
    const briefMode = overrides?.briefMode ?? true;
    return {
      id: "telegram",
      name: "CamelAGI",
      model: overrides?.model ?? config.model,
      systemPrompt: globalSystemPrompt + (briefMode ? BRIEF_MODE_INSTRUCTION : ""),
      thinking: overrides?.thinking ?? config.thinking,
      effort: overrides?.effort ?? config.effort,
      maxTurns: config.maxTurns,
      allowedUsers: config.telegram.allowedUsers,
      mentionOnly: config.telegram.groups.mentionOnly,
      briefMode,
    };
  }

  const agent = config.agents[agentId];
  const basePrompt = agent?.systemPrompt ?? config.systemPrompt;
  const briefMode = overrides?.briefMode ?? (agent?.telegram?.briefMode ?? true);
  const prompt = buildSystemPrompt(basePrompt, config.skills, agentId);
  return {
    id: agentId,
    name: agent?.name ?? agentId,
    model: overrides?.model ?? agent?.model ?? config.model,
    systemPrompt: prompt + (briefMode ? BRIEF_MODE_INSTRUCTION : ""),
    thinking: overrides?.thinking ?? (agent?.thinking ?? config.thinking) as Config["thinking"],
    effort: overrides?.effort ?? (agent?.effort ?? config.effort) as Config["effort"],
    maxTurns: agent?.maxTurns ?? config.maxTurns,
    allowedUsers: agent?.telegram?.allowedUsers ?? [],
    mentionOnly: agent?.telegram?.groups?.mentionOnly ?? true,
    briefMode,
  };
}
