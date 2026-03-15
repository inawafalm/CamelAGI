// Agent config resolution for Telegram

import type { Config } from "../core/config.js";
import { buildSystemPrompt } from "../system-prompt.js";
import type { ResolvedAgent } from "./types.js";

export interface RuntimeOverrides {
  model?: string;
  thinking?: Config["thinking"];
  effort?: Config["effort"];
}

/** Resolve an agent's config from current config state (supports hot-reload) */
export function resolveAgent(
  agentId: string,
  config: Config,
  globalSystemPrompt: string,
  overrides?: RuntimeOverrides,
): ResolvedAgent {
  if (agentId === "telegram") {
    // Legacy top-level telegram config
    return {
      id: "telegram",
      name: "CamelAGI",
      model: overrides?.model ?? config.model,
      systemPrompt: globalSystemPrompt,
      thinking: overrides?.thinking ?? config.thinking,
      effort: overrides?.effort ?? config.effort,
      maxTurns: config.maxTurns,
      allowedUsers: config.telegram.allowedUsers,
      mentionOnly: config.telegram.groups.mentionOnly,
    };
  }

  const agent = config.agents[agentId];
  const basePrompt = agent?.systemPrompt ?? config.systemPrompt;
  return {
    id: agentId,
    name: agent?.name ?? agentId,
    model: overrides?.model ?? agent?.model ?? config.model,
    systemPrompt: buildSystemPrompt(basePrompt, config.skills, agentId),
    thinking: overrides?.thinking ?? (agent?.thinking ?? config.thinking) as Config["thinking"],
    effort: overrides?.effort ?? (agent?.effort ?? config.effort) as Config["effort"],
    maxTurns: agent?.maxTurns ?? config.maxTurns,
    allowedUsers: agent?.telegram?.allowedUsers ?? [],
    mentionOnly: agent?.telegram?.groups?.mentionOnly ?? true,
  };
}
