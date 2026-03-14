// Telegram helpers: group detection, mention handling, chunked sending, polling

import type { Bot } from "grammy";
import { BlockChunker } from "../chunker.js";

export function isGroupChat(chatType: string): boolean {
  return chatType === "group" || chatType === "supergroup";
}

export function shouldRespondInGroup(
  text: string,
  replyToBotId: number | undefined,
  botId: number,
  botUsername: string,
): boolean {
  if (replyToBotId === botId) return true;
  if (botUsername && text.includes(`@${botUsername}`)) return true;
  return false;
}

export function stripMention(text: string, botUsername: string): string {
  if (!botUsername) return text;
  return text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim();
}

export async function sendChunked(ctx: any, response: string) {
  if (response.length <= 4096) {
    await ctx.reply(response);
    return;
  }

  const chunks: string[] = [];
  const chunker = new BlockChunker({
    minChars: 800,
    maxChars: 3500,
    breakPreference: "paragraph",
    onChunk: (chunk: string) => chunks.push(chunk),
  });
  chunker.append(response);
  chunker.flush();

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

export function startPolling(b: Bot, label: string) {
  const INITIAL_DELAY = 2000;
  const MAX_DELAY = 30_000;
  const BACKOFF_FACTOR = 1.8;
  let delay = INITIAL_DELAY;

  const launch = () => {
    b.start({
      drop_pending_updates: true,
      onStart: () => {
        console.log(`  [${label}] polling...`);
        delay = INITIAL_DELAY;
      },
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const is409 = msg.includes("409") || msg.includes("Conflict");
      const isNetwork = msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT")
        || msg.includes("ENOTFOUND") || msg.includes("fetch failed");

      if (is409 || isNetwork) {
        console.error(`  [${label}] ${is409 ? "conflict" : "network error"}, retrying in ${Math.round(delay / 1000)}s...`);
        setTimeout(launch, delay);
        delay = Math.min(delay * BACKOFF_FACTOR, MAX_DELAY);
      } else {
        console.error(`  [${label}] fatal: ${msg}`);
      }
    });
  };

  launch();
}

export function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
