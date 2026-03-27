// Draft stream: native Telegram streaming via sendMessageDraft (Bot API 9.5)
//
// Uses sendMessageDraft for smooth, flicker-free streaming.
// Falls back to sendMessage + editMessageText if sendMessageDraft fails.

import type { Bot } from "grammy";
import { markdownToTelegramHtml } from "./format.js";

export interface DraftStream {
  update: (text: string) => void;
  flush: () => Promise<void>;
  getMessageId: () => number | null;
}

let draftCounter = 0;

export function createDraftStream(
  chatId: number,
  api: Bot["api"],
  opts: { throttleMs?: number; minInitialChars?: number } = {},
): DraftStream {
  const minInitialChars = opts.minInitialChars ?? 30;
  const draftId = ++draftCounter;

  let messageId: number | null = null;
  let lastSentText = "";
  let pendingText = "";
  let inflight: Promise<void> | null = null;
  let useNative = true; // try sendMessageDraft first
  let timer: NodeJS.Timeout | null = null;

  // Fallback throttle (only used if native fails)
  const throttleMs = opts.throttleMs ?? 1200;
  let lastSentAt = 0;

  const sendNative = async (text: string): Promise<boolean> => {
    const trimmed = text.slice(0, 4096);
    if (!trimmed || trimmed === lastSentText) return true;
    try {
      const html = markdownToTelegramHtml(trimmed);
      await (api as any).sendMessageDraft(chatId, draftId, html, { parse_mode: "HTML" });
      lastSentText = trimmed;
      return true;
    } catch {
      try {
        await (api as any).sendMessageDraft(chatId, draftId, text.slice(0, 4096));
        lastSentText = text.slice(0, 4096);
        return true;
      } catch {
        return false; // native not supported, fall back
      }
    }
  };

  const sendFallback = async (text: string, isFinal: boolean): Promise<void> => {
    const trimmed = text.slice(0, 4096);
    if (!trimmed) return;
    if (trimmed === lastSentText && messageId) return;
    if (!messageId && !isFinal && trimmed.length < minInitialChars) return;

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

  const doUpdate = async (text: string, isFinal: boolean) => {
    if (inflight) await inflight;

    const run = async () => {
      if (useNative) {
        const ok = await sendNative(text);
        if (!ok) {
          useNative = false;
          await sendFallback(text, isFinal);
        }
      } else {
        await sendFallback(text, isFinal);
      }
    };

    inflight = run();
    await inflight;
    inflight = null;
  };

  const scheduleFlush = () => {
    if (useNative) {
      // Native: no throttle needed, send immediately
      if (pendingText && pendingText !== lastSentText) {
        doUpdate(pendingText, false);
      }
      return;
    }
    // Fallback: throttle edits
    if (timer) return;
    const elapsed = Date.now() - lastSentAt;
    const wait = Math.max(0, throttleMs - elapsed);
    timer = setTimeout(async () => {
      timer = null;
      if (pendingText && pendingText !== lastSentText) {
        await doUpdate(pendingText, false);
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
        await doUpdate(pendingText, true);
      }
      // If we used native streaming, send the final message as a real message
      if (useNative && lastSentText) {
        try {
          const html = markdownToTelegramHtml(lastSentText);
          const sent = await api.sendMessage(chatId, html, { parse_mode: "HTML" });
          messageId = sent.message_id;
        } catch {
          try {
            const sent = await api.sendMessage(chatId, lastSentText);
            messageId = sent.message_id;
          } catch { /* ignore */ }
        }
      }
    },
    getMessageId() { return messageId; },
  };
}
