// Draft stream: throttled message editing for Telegram streaming

import type { Bot } from "grammy";
import { markdownToTelegramHtml } from "./format.js";

export interface DraftStream {
  update: (text: string) => void;
  flush: () => Promise<void>;
  getMessageId: () => number | null;
}

export function createDraftStream(
  chatId: number,
  api: Bot["api"],
  opts: { throttleMs?: number; minInitialChars?: number } = {},
): DraftStream {
  const throttleMs = opts.throttleMs ?? 1200;
  const minInitialChars = opts.minInitialChars ?? 30;

  let messageId: number | null = null;
  let lastSentText = "";
  let pendingText = "";
  let inflight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastSentAt = 0;

  const sendOrEdit = async (text: string, isFinal: boolean): Promise<void> => {
    if (inflight) await inflight;
    const trimmed = text.slice(0, 4096);
    if (!trimmed) return;
    if (trimmed === lastSentText && messageId) return;
    if (!messageId && !isFinal && trimmed.length < minInitialChars) return;

    const doSend = async () => {
      const html = markdownToTelegramHtml(trimmed);
      try {
        if (!messageId) {
          const sent = await api.sendMessage(chatId, html, { parse_mode: "HTML" });
          messageId = sent.message_id;
        } else {
          await api.editMessageText(chatId, messageId, html, { parse_mode: "HTML" });
        }
        lastSentText = trimmed;
        lastSentAt = Date.now();
      } catch {
        // Fallback: send without formatting if HTML parsing fails
        try {
          if (!messageId) {
            const sent = await api.sendMessage(chatId, trimmed);
            messageId = sent.message_id;
          } else {
            await api.editMessageText(chatId, messageId, trimmed);
          }
          lastSentText = trimmed;
          lastSentAt = Date.now();
        } catch { /* ignore */ }
      }
    };

    inflight = doSend();
    await inflight;
    inflight = null;
  };

  const scheduleFlush = () => {
    if (timer) return;
    const elapsed = Date.now() - lastSentAt;
    const wait = Math.max(0, throttleMs - elapsed);
    timer = setTimeout(async () => {
      timer = null;
      if (pendingText && pendingText !== lastSentText) {
        await sendOrEdit(pendingText, false);
      }
    }, wait);
  };

  return {
    update(text: string) {
      pendingText = text;
      scheduleFlush();
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (inflight) await inflight;
      if (pendingText && pendingText !== lastSentText) {
        await sendOrEdit(pendingText, true);
      }
    },
    getMessageId() { return messageId; },
  };
}
