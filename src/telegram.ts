// Telegram: multi-bot entry point and lifecycle management
// This is a barrel that re-exports the public API.

import type { Config } from "./core/config.js";
import { seedAgentWorkspace } from "./workspace.js";
import { unregisterForwardBot } from "./extensions/approval-forward.js";
import type { BotState } from "./telegram/types.js";
import { setupAgentBot } from "./telegram/agent-bot.js";
import { startPolling } from "./telegram/helpers.js";

// ─── Module state: active bots ──────────────────────────────────────

const activeBots = new Map<string, BotState>();
const startingBots = new Set<string>(); // lock to prevent double-start

// ─── Main entry: start all bots ─────────────────────────────────────

export async function startTelegram(
  getConfig: () => Config,
  getSystemPrompt: () => string,
): Promise<string[]> {
  const config = getConfig();
  const started: string[] = [];
  const usedTokens = new Set<string>();

  // Collect all agent tokens first to detect duplicates
  const agentTokens = new Set<string>();
  for (const [, agent] of Object.entries(config.agents)) {
    if (agent.telegram?.botToken) agentTokens.add(agent.telegram.botToken);
  }

  // Legacy top-level telegram bot — skip if an agent already uses the same token
  if (config.telegram.botToken && !agentTokens.has(config.telegram.botToken)) {
    usedTokens.add(config.telegram.botToken);
    await setupAgentBot("telegram", config.telegram.botToken, getConfig, getSystemPrompt, activeBots);
    started.push("telegram");
  }

  // Named agents with telegram config
  for (const [id, agent] of Object.entries(config.agents)) {
    if (!agent.telegram?.botToken) continue;
    if (usedTokens.has(agent.telegram.botToken)) {
      console.warn(`  [${id}] skipped — duplicate bot token (already used by another agent)`);
      continue;
    }
    usedTokens.add(agent.telegram.botToken);
    seedAgentWorkspace(id, agent.name);

    if (agent.admin) {
      // Admin agent: use the admin bot (BotFather-style commands + wizards)
      const { setupAdminBot } = await import("./telegram/admin-bot.js");
      const bot = await setupAdminBot(id, agent.telegram.botToken, getConfig, getSystemPrompt, activeBots);
      const me = await bot.api.getMe();
      activeBots.set(id, {
        bot,
        botInfo: { id: me.id, username: me.username ?? "" },
        runtimeModels: new Map(),
      });
      startPolling(bot, id);
    } else {
      await setupAgentBot(id, agent.telegram.botToken, getConfig, getSystemPrompt, activeBots);
    }
    started.push(id);
  }

  return started;
}

// ─── Lifecycle exports ──────────────────────────────────────────────

/** Get IDs of all currently active (polling) bots */
export function getActiveBotIds(): string[] {
  return [...activeBots.keys()];
}

/** Get the active bots map (used by REST routes for notifications) */
export function getActiveBots(): Map<string, BotState> {
  return activeBots;
}

/** Start a single bot by agent ID (hot-start after /newagent or config reload) */
export async function startBot(
  agentId: string,
  botToken: string,
  getConfig: () => Config,
  getSystemPrompt: () => string,
): Promise<void> {
  if (activeBots.has(agentId)) {
    throw new Error(`Bot "${agentId}" is already running`);
  }
  if (startingBots.has(agentId)) {
    throw new Error(`Bot "${agentId}" is already starting`);
  }
  startingBots.add(agentId);
  try {
    const config = getConfig();
    const agent = config.agents[agentId];

    if (agent?.admin) {
      const { setupAdminBot } = await import("./telegram/admin-bot.js");
      const bot = await setupAdminBot(agentId, botToken, getConfig, getSystemPrompt, activeBots);
      const me = await bot.api.getMe();
      activeBots.set(agentId, {
        bot,
        botInfo: { id: me.id, username: me.username ?? "" },
        runtimeModels: new Map(),
      });
      startPolling(bot, agentId);
    } else {
      await setupAgentBot(agentId, botToken, getConfig, getSystemPrompt, activeBots);
    }
  } finally {
    startingBots.delete(agentId);
  }
}

/** Stop a single bot by agent ID */
export function stopBot(agentId: string): boolean {
  const state = activeBots.get(agentId);
  if (!state) return false;
  state.bot.stop();
  state.runtimeModels.clear();
  activeBots.delete(agentId);
  return true;
}

export function stopTelegram() {
  unregisterForwardBot();
  for (const [, state] of activeBots) {
    state.bot.stop();
    state.runtimeModels.clear();
  }
  activeBots.clear();
}
