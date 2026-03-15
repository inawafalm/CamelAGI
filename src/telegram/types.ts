// Telegram shared types

import type { Bot } from "grammy";
import type { Config } from "../core/config.js";

export interface BotState {
  bot: Bot;
  botInfo: { id: number; username: string };
  runtimeModels: Map<number, string>;
  runtimeThinking: Map<number, Config["thinking"]>;
  runtimeEffort: Map<number, Config["effort"]>;
}

export interface ResolvedAgent {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  thinking: Config["thinking"];
  effort: Config["effort"];
  maxTurns: number;
  allowedUsers: number[];
  mentionOnly: boolean;
}
