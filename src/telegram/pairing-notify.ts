// Pairing notification: sends approval requests to admin bots with inline buttons

import { InlineKeyboard } from "grammy";
import type { Config } from "../core/config.js";
import type { BotState } from "./types.js";
import type { PairingRequest } from "./pairing.js";

/** Send pairing notification to all admin bots */
export function notifyAdminOfPairing(
  request: PairingRequest,
  config: Config,
  activeBots: Map<string, BotState>,
): void {
  const userLabel = request.username
    ? `@${request.username}`
    : request.firstName ?? String(request.userId);

  const text = [
    `New access request`,
    ``,
    `User: ${userLabel} (${request.userId})`,
    `Agent: ${request.agentId}`,
    `Code: ${request.code}`,
  ].join("\n");

  const keyboard = new InlineKeyboard()
    .text("Approve", `pairing:approve:${request.code}`)
    .text("Deny", `pairing:deny:${request.code}`);

  // Find admin bots and send notification
  for (const [id, agent] of Object.entries(config.agents)) {
    if (!agent.admin) continue;
    const botState = activeBots.get(id);
    if (!botState) continue;

    const allowedUsers = agent.telegram?.allowedUsers ?? [];
    for (const adminUserId of allowedUsers) {
      botState.bot.api.sendMessage(adminUserId, text, { reply_markup: keyboard })
        .catch(() => { /* admin may not have started the bot yet */ });
    }
  }
}

/** Notify user that admin approved — they now have access */
export async function notifyUserApproved(
  request: PairingRequest,
  activeBots: Map<string, BotState>,
): Promise<void> {
  const botState = activeBots.get(request.agentId);
  if (!botState) return;

  try {
    await botState.bot.api.sendMessage(
      request.chatId,
      "Access approved! You can now use this bot.",
    );
  } catch { /* user may have blocked the bot */ }
}

/** Send denial result back to the user */
export async function notifyUserOfDenial(
  request: PairingRequest,
  activeBots: Map<string, BotState>,
): Promise<void> {
  const botState = activeBots.get(request.agentId);
  if (!botState) return;

  try {
    await botState.bot.api.sendMessage(request.chatId, "Access denied.");
  } catch { /* user may have blocked the bot */ }
}
