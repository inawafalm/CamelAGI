// Agent bot: per-agent Telegram bot — setup, access control, wiring

import { Bot } from "grammy";
import { loadConfig, type Config } from "../core/config.js";
import { registerForwardBot } from "../extensions/approval-forward.js";
import { hasPendingRequest, createPairingRequest } from "../extensions/pairing.js";
import { notifyAdminOfPairing } from "./pairing-notify.js";
import { isGroupChat, startPolling } from "./helpers.js";
import type { BotState } from "./types.js";
import type { BotContext } from "./agent-context.js";
import { isUserAllowed, setCommandMenu } from "./agent-context.js";
import { registerCommands } from "./agent-commands.js";
import { registerClaudeCode } from "./agent-claude-code.js";
import { registerMessageHandlers } from "./agent-messages.js";

export async function setupAgentBot(
  agentId: string,
  botToken: string,
  getConfig: () => Config,
  getSystemPrompt: () => string,
  activeBots: Map<string, BotState>,
): Promise<void> {
  const b = new Bot(botToken);
  const me = await b.api.getMe();

  const ctx: BotContext = {
    agentId,
    botToken,
    bot: b,
    botInfo: { id: me.id, username: me.username ?? "" },
    getConfig,
    getSystemPrompt,
    activeBots,
    runtimeModels: new Map(),
    runtimeThinking: new Map(),
    runtimeEffort: new Map(),
    runtimeBriefMode: new Map(),
    ccPaused: new Set(),
  };

  const state: BotState = {
    bot: b,
    botInfo: ctx.botInfo,
    runtimeModels: ctx.runtimeModels,
    runtimeThinking: ctx.runtimeThinking,
    runtimeEffort: ctx.runtimeEffort,
    runtimeBriefMode: ctx.runtimeBriefMode,
  };
  activeBots.set(agentId, state);

  // Register first bot for approval forwarding (headless -> Telegram)
  if (activeBots.size === 1) {
    registerForwardBot(b);
  }

  // Set global default commands
  await setCommandMenu(ctx, false);

  // ─── Access control middleware ─────────────────────────────────────

  b.use(async (gc, next) => {
    const agent = ctx.getConfig().agents[agentId];
    const allowedUsers = agentId === "telegram"
      ? ctx.getConfig().telegram.allowedUsers
      : (agent?.telegram?.allowedUsers ?? []);
    if (allowedUsers.length === 0) { await next(); return; }

    const userId = gc.from?.id;
    if (!userId) return;
    if (isUserAllowed(ctx, userId)) { await next(); return; }

    // Unauthorized user in group — silent reject
    if (gc.chat && isGroupChat(gc.chat.type)) return;

    // Check if user already has a pending request
    const pending = hasPendingRequest(userId, agentId);
    if (pending) {
      await gc.reply(`Your access request is pending approval.\nCode: ${pending.code}`);
      return;
    }

    // Create new pairing request
    const request = createPairingRequest(
      userId, agentId, gc.chat!.id,
      gc.from?.username, gc.from?.first_name,
    );
    const who = gc.from?.username ? `@${gc.from.username}` : gc.from?.first_name ?? String(userId);
    console.log(`\n  \x1b[33mPairing request from ${who} for agent "${agentId}"\x1b[0m\n  \x1b[90mRun: camel pairing\x1b[0m\n`);
    await gc.reply(
      `Access requested. Waiting for admin approval.\nCode: ${request.code}`,
    );
    notifyAdminOfPairing(request, ctx.getConfig(), activeBots);
  });

  // ─── Register modules (order matters for grammy middleware chain) ──

  registerClaudeCode(ctx);        // command mode guard + CC commands/callbacks
  registerCommands(ctx);           // standard commands
  registerMessageHandlers(ctx);    // text/voice/callback handlers (must be last)

  // ─── Start polling ────────────────────────────────────────────────

  startPolling(b, agentId);
}
