// TelegramChannel: wraps existing src/telegram.ts as a Channel

import type { Channel } from "./types.js";
import type { Config } from "../core/config.js";
import { seedAgentWorkspace } from "../workspace.js";

type TelegramModule = typeof import("../telegram.js");

export class TelegramChannel implements Channel {
  readonly type = "telegram";
  private mod: TelegramModule | null = null;

  private async load(): Promise<TelegramModule> {
    if (!this.mod) this.mod = await import("../telegram.js");
    return this.mod;
  }

  async start(getConfig: () => Config, getSystemPrompt: () => string): Promise<string[]> {
    const config = getConfig();
    const hasBots = config.telegram.botToken || Object.values(config.agents).some((a) => a.telegram?.botToken);
    if (!hasBots) return [];

    const mod = await this.load();
    return mod.startTelegram(getConfig, getSystemPrompt);
  }

  stop(): void {
    if (this.mod) this.mod.stopTelegram();
  }

  async reconcile(getConfig: () => Config, getSystemPrompt: () => string): Promise<void> {
    const mod = await this.load();
    const running = new Set(mod.getActiveBotIds());
    const config = getConfig();

    // Start bots for new agents with telegram config
    const usedTokens = new Set<string>();
    for (const [id, agent] of Object.entries(config.agents)) {
      if (!agent.telegram?.botToken) continue;
      usedTokens.add(agent.telegram.botToken);
      if (running.has(id)) continue;
      try {
        seedAgentWorkspace(id, agent.name);
        await mod.startBot(id, agent.telegram.botToken, getConfig, getSystemPrompt);
        console.log(`[telegram] Hot-started bot: ${id}`);
      } catch {
        // Already starting, or other error
      }
    }

    // Legacy top-level telegram bot
    if (config.telegram.botToken && !usedTokens.has(config.telegram.botToken) && !running.has("telegram")) {
      try {
        await mod.startBot("telegram", config.telegram.botToken, getConfig, getSystemPrompt);
        console.log(`[telegram] Hot-started legacy telegram bot`);
      } catch {}
    }

    // Stop bots whose agents were removed from config
    for (const id of running) {
      if (id === "telegram") {
        if (!config.telegram.botToken || usedTokens.has(config.telegram.botToken)) {
          mod.stopBot(id);
          console.log(`[telegram] Stopped bot: ${id} (token removed or claimed by agent)`);
        }
        continue;
      }
      if (!config.agents[id]?.telegram?.botToken) {
        mod.stopBot(id);
        console.log(`[telegram] Stopped bot: ${id} (agent removed)`);
      }
    }
  }

  getActiveAgentIds(): string[] {
    return this.mod ? this.mod.getActiveBotIds() : [];
  }

  async startAgent(agentId: string, getConfig: () => Config, getSystemPrompt: () => string): Promise<void> {
    const config = getConfig();
    const agent = config.agents[agentId];
    const token = agentId === "telegram" ? config.telegram.botToken : agent?.telegram?.botToken;
    if (!token) throw new Error(`No Telegram bot token for agent "${agentId}"`);
    const mod = await this.load();
    await mod.startBot(agentId, token, getConfig, getSystemPrompt);
  }

  stopAgent(agentId: string): boolean {
    return this.mod ? this.mod.stopBot(agentId) : false;
  }
}
