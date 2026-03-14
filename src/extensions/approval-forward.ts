// Approval forwarding: send approval requests to Telegram when running headless
//
// When a tool call needs approval but there's no interactive channel (HTTP API,
// cron, boot), forward the request to a configured Telegram chat with inline buttons.
//
// Config:
//   approvals:
//     forwardTo: 123456789   # your Telegram user/chat ID

import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";

// The first active bot is used for forwarding
let forwardBotRef: Bot | null = null;

/** Register a bot for forwarding approval requests (called by telegram.ts) */
export function registerForwardBot(bot: Bot): void {
  forwardBotRef = bot;
}

/** Unregister on shutdown */
export function unregisterForwardBot(): void {
  forwardBotRef = null;
}

/**
 * Send an approval request to a Telegram chat with inline buttons.
 * Returns true if sent successfully, false if no bot available.
 */
export async function forwardApproval(
  approvalId: string,
  toolName: string,
  preview: string,
  forwardTo: number,
): Promise<boolean> {
  if (!forwardBotRef || !forwardTo) return false;

  try {
    const keyboard = new InlineKeyboard()
      .text("✅ Allow", `approve:${approvalId}:allow-once`)
      .text("♾️ Always", `approve:${approvalId}:allow-always`)
      .text("❌ Deny", `approve:${approvalId}:deny`);

    await forwardBotRef.api.sendMessage(forwardTo, `🔒 ${toolName}\n${preview}`, {
      reply_markup: keyboard,
    });
    return true;
  } catch (err) {
    console.error(`  [approval-forward] failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}
