// Message handlers: incoming messages, text routing, voice, wizard/browse callbacks

import { InlineKeyboard } from "grammy";
import type { AgentEvent } from "../agent.js";
import { createClient } from "../model.js";
import { loadMessages } from "../session.js";
import { isRunActive } from "../runtime/runs.js";
import { queueOrProcess } from "../runtime/queue.js";
import { orchestrate } from "../runtime/orchestrate.js";
import { log as slog } from "../core/log.js";
import { advanceWizard, hasActiveWizard } from "./wizard.js";
import { handleBrowseCallback } from "./dir-browser.js";
import { createDraftStream } from "./draft-stream.js";
import { isGroupChat, shouldRespondInGroup, stripMention, sendChunked } from "./helpers.js";
import { hasTerminal, startTerminal, expandHome, setTerminalSetting } from "./terminal.js";
import { transcribe } from "./transcribe.js";
import { handleTerminalIncoming } from "./agent-claude-code.js";
import type { BotContext } from "./agent-context.js";
import { sid, getAgent, alertAdmin, setCommandMenu } from "./agent-context.js";
import os from "node:os";

// ─── Core message handler ─────────────────────────────────────────────

async function handleIncoming(ctx: BotContext, gc: any, cleanText: string): Promise<void> {
  const config = ctx.getConfig();
  const agent = getAgent(ctx, gc.chat.id);
  const sessionId = sid(ctx, gc.chat.id);

  const chatContext = isGroupChat(gc.chat.type)
    ? (gc.chat as any).title
    : gc.from?.first_name;
  const label = chatContext ? `${agent.name}: ${chatContext}` : agent.name;

  slog.info("telegram", "Incoming message", { agent: agent.name, sessionId, text: cleanText.slice(0, 160) });

  if (isRunActive(sessionId)) {
    await queueOrProcess(sessionId, cleanText);
    return;
  }

  const abortController = new AbortController();
  const client = createClient(config);

  const setReaction = async (emoji: string) => {
    try {
      const reactions = emoji ? [{ type: "emoji" as const, emoji: emoji as any }] : [];
      await gc.api.setMessageReaction(gc.chat.id, gc.message.message_id, reactions);
    } catch {}
  };

  const draft = createDraftStream(gc.chat.id, gc.api);
  let pendingText = "";

  try {
    await setReaction("eyes");
    await gc.replyWithChatAction("typing");
    await setReaction("thinking_face");

    const result = await orchestrate({
      sessionId,
      message: cleanText,
      config,
      systemPrompt: agent.systemPrompt,
      client,
      signal: abortController.signal,
      agentId: ctx.agentId === "telegram" ? undefined : ctx.agentId,
      label,
      model: agent.model,
      agentSystemPrompt: agent.systemPrompt,
      thinking: agent.thinking,
      effort: agent.effort,
      onRetry: async (attempt, kind) => {
        await alertAdmin(ctx, `⚠️ ${agent.name}: ${kind} (attempt ${attempt + 1}/${config.retry.maxRetries})`);
      },
      onError: async (err, kind) => {
        const isFatal = kind === "auth" || kind === "billing";
        const icon = isFatal ? "🚨" : "⚠️";
        await alertAdmin(ctx, `${icon} ${agent.name}: ${kind} — ${err.message.slice(0, 200)}`);
      },
      onEvent: async (event: AgentEvent) => {
        if (event.type === "stream_text") {
          pendingText += event.text;
          draft.update(pendingText);
        } else if (event.type === "chunk") {
          pendingText = event.text;
          draft.update(pendingText);
        } else if (event.type === "tool_call") {
          await setReaction("wrench");
        } else if (event.type === "thinking") {
          if (event.state === "start") await setReaction("thought_balloon");
        } else if (event.type === "subagent_start") {
          await setReaction("wrench");
        } else if (event.type === "approval_request") {
          await setReaction("lock");
          const keyboard = new InlineKeyboard()
            .text("Allow", `approve:${event.id}:allow-once`)
            .text("Always", `approve:${event.id}:allow-always`)
            .text("Deny", `approve:${event.id}:deny`);
          try {
            await gc.api.sendMessage(gc.chat.id, `${event.toolName}\n${event.preview}`, {
              reply_markup: keyboard,
            });
          } catch { /* best effort */ }
        }
      },
    });

    const response = result.response || "(no response)";
    slog.info("telegram", "Response sent", { agent: agent.name, sessionId, text: response.slice(0, 160) });

    pendingText = response;
    draft.update(response);
    await draft.flush();

    const streamMsgId = draft.getMessageId();
    if (streamMsgId && response.length > 4096) {
      try { await gc.api.deleteMessage(gc.chat.id, streamMsgId); } catch {}
      await sendChunked(gc, response);
    } else if (!streamMsgId) {
      await sendChunked(gc, response);
    }

    await setReaction("");
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    slog.error("telegram", "Agent run failed", { agent: agent.name, sessionId, error: errMsg });
    const streamMsgId = draft.getMessageId();
    if (streamMsgId) {
      try { await gc.api.editMessageText(gc.chat.id, streamMsgId, `Error: ${errMsg}`); }
      catch { await gc.reply(`Error: ${errMsg}`); }
    } else {
      await gc.reply(`Error: ${errMsg}`);
    }
    await setReaction("");
  }
}

// ─── Registration ─────────────────────────────────────────────────────

export function registerMessageHandlers(ctx: BotContext): void {
  const { bot: b, ccPaused } = ctx;

  // Wizard + browse callback routing
  b.on("callback_query:data", async (gc) => {
    const data = gc.callbackQuery.data;
    if (data.startsWith("wizard:")) {
      await gc.answerCallbackQuery();
      const value = data.split(":").slice(2).join(":");
      await advanceWizard(gc.chat!.id, value, b);
    } else if (data.startsWith("browse:")) {
      await gc.answerCallbackQuery();
      const value = data.slice("browse:".length);
      await handleBrowseCallback(gc.chat!.id, value, gc.api);
    }
  });

  // Text message routing
  b.on("message:text", async (gc) => {
    // Claude Code mode: manual (/cc) or config-driven (mode: claude-code)
    if (hasTerminal(gc.chat.id)) {
      await handleTerminalIncoming(ctx, gc);
      return;
    }
    const agentCfg = ctx.getConfig().agents[ctx.agentId];
    if (agentCfg?.mode === "claude-code" && !ccPaused.has(gc.chat.id)) {
      const workDir = agentCfg.workDir ? expandHome(agentCfg.workDir) : os.homedir() + "/Desktop";
      startTerminal(gc.chat.id, workDir);
      if (agentCfg.ccApprovals === "acceptEdits") {
        setTerminalSetting(gc.chat.id, "permissionMode", "acceptEdits");
      }
      await setCommandMenu(ctx, true, gc.chat.id);
      await handleTerminalIncoming(ctx, gc);
      return;
    }

    // Advance active wizard with text input
    if (hasActiveWizard(gc.chat.id)) {
      const consumed = await advanceWizard(gc.chat.id, gc.message.text, b);
      if (consumed) return;
    }

    const agent = getAgent(ctx, gc.chat.id);
    const text = gc.message.text;

    if (isGroupChat(gc.chat.type) && agent.mentionOnly) {
      const replyToBotId = gc.message.reply_to_message?.from?.id;
      if (!shouldRespondInGroup(text, replyToBotId, ctx.botInfo.id, ctx.botInfo.username)) {
        return;
      }
    }

    const cleanText = stripMention(text, ctx.botInfo.username);
    if (!cleanText) return;

    await handleIncoming(ctx, gc, cleanText);
  });

  // Voice/audio handler
  b.on(["message:voice", "message:audio"], async (gc) => {
    const config = ctx.getConfig();

    if (!config.voice.enabled || !config.voice.apiKey) {
      const adminEntry = Object.entries(config.agents).find(([, a]) => a.admin);
      const hint = adminEntry
        ? "Voice transcription is not configured. Use /voice in the admin bot to enable it."
        : "Voice transcription is not configured.";
      await gc.reply(hint);
      return;
    }

    try {
      await gc.replyWithChatAction("typing");

      const fileId = gc.message.voice?.file_id ?? gc.message.audio?.file_id;
      if (!fileId) { await gc.reply("Could not read audio file."); return; }

      const file = await gc.api.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${ctx.botToken}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) { await gc.reply("Failed to download voice file."); return; }

      const buffer = Buffer.from(await resp.arrayBuffer());

      if (buffer.length > 20 * 1024 * 1024) {
        await gc.reply("Audio file too large (max 20 MB).");
        return;
      }

      const result = await transcribe(buffer, {
        enabled: true,
        provider: config.voice.provider,
        apiKey: config.voice.apiKey,
        model: config.voice.model,
        language: config.voice.language,
      });

      if (!result.text?.trim()) {
        await gc.reply("(could not transcribe — empty result)");
        return;
      }

      const cleanText = `[Voice] ${result.text.trim()}`;
      slog.info("telegram", "Voice transcribed", {
        agent: ctx.agentId, text: cleanText.slice(0, 160), provider: config.voice.provider,
      });

      await handleIncoming(ctx, gc, cleanText);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      slog.error("telegram", "Voice processing failed", { agent: ctx.agentId, error: errMsg });
      await gc.reply(`Voice error: ${errMsg}`);
    }
  });

  // Error handler
  b.catch((err) => {
    slog.error("telegram", "Bot error", { agent: ctx.agentId, error: err.message ?? String(err) });
  });
}
