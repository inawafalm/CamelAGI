// Agent config resolution for Telegram
// Builds on the channel-agnostic resolveAgentBase and adds Telegram-specific fields.

import type { Config } from "../core/config.js";
import type { ResolvedAgent } from "./types.js";
import { resolveAgentBase } from "../channels/handler.js";

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
  // Use channel-agnostic base resolution (handles override cascade)
  const baseId = agentId === "telegram" ? "default" : agentId;
  const base = resolveAgentBase(baseId, config, globalSystemPrompt, overrides);

  // Telegram-specific fields
  const agent = agentId !== "telegram" ? config.agents[agentId] : undefined;
  const briefMode = overrides?.briefMode ?? (agent?.telegram?.briefMode ?? true);

  return {
    ...base,
    id: agentId,
    systemPrompt: base.systemPrompt + (briefMode ? BRIEF_MODE_INSTRUCTION : ""),
    allowedUsers: agentId === "telegram"
      ? config.telegram.allowedUsers
      : (agent?.telegram?.allowedUsers ?? []),
    mentionOnly: agentId === "telegram"
      ? config.telegram.groups.mentionOnly
      : (agent?.telegram?.groups?.mentionOnly ?? true),
    briefMode,
  };
}
