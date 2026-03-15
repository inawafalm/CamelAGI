// Agent bot: per-agent Telegram bot with commands and message handling

import { Bot, InlineKeyboard } from "grammy";
import { loadConfig, type Config } from "../core/config.js";
import { createClient } from "../model.js";
import type { AgentEvent } from "../agent.js";
import { loadMessages, deleteSession } from "../session.js";
import { isRunActive } from "../runtime/runs.js";
import { queueOrProcess } from "../runtime/queue.js";
import { compactHistory } from "../runtime/compact.js";
import { orchestrate } from "../runtime/orchestrate.js";
import { getSessionUsage, formatUsageSummary } from "../usage.js";
import { CHARS_PER_TOKEN } from "../core/constants.js";
import { submitDecision, type ApprovalDecision } from "../extensions/approvals.js";
import { registerForwardBot } from "../extensions/approval-forward.js";
import type { BotState } from "./types.js";
import { resolveAgent } from "./resolve.js";
import { createDraftStream } from "./draft-stream.js";
import { isGroupChat, shouldRespondInGroup, stripMention, sendChunked, startPolling } from "./helpers.js";
import { hasPendingRequest, createPairingRequest } from "./pairing.js";
import { notifyAdminOfPairing } from "./pairing-notify.js";
import { log as slog } from "../core/log.js";
import { transcribe } from "./transcribe.js";

export async function setupAgentBot(
  agentId: string,
  botToken: string,
  getConfig: () => Config,
  getSystemPrompt: () => string,
  activeBots: Map<string, BotState>,
): Promise<void> {
  const b = new Bot(botToken);
  const me = await b.api.getMe();
  const state: BotState = {
    bot: b,
    botInfo: { id: me.id, username: me.username ?? "" },
    runtimeModels: new Map(),
    runtimeThinking: new Map(),
    runtimeEffort: new Map(),
  };
  activeBots.set(agentId, state);

  // Register first bot for approval forwarding (headless -> Telegram)
  if (activeBots.size === 1) {
    registerForwardBot(b);
  }

  const { botInfo, runtimeModels, runtimeThinking, runtimeEffort } = state;

  const sid = (chatId: number) =>
    agentId === "telegram" ? `telegram-${chatId}` : `${agentId}-${chatId}`;

  const getAgent = (chatId: number) =>
    resolveAgent(agentId, getConfig(), getSystemPrompt(), {
      model: runtimeModels.get(chatId),
      thinking: runtimeThinking.get(chatId),
      effort: runtimeEffort.get(chatId),
    });

  // Register commands (only commands this bot actually handles)
  await b.api.setMyCommands([
    { command: "help", description: "List commands and current config" },
    { command: "clear", description: "Clear this chat's history" },
    { command: "status", description: "Show model, message count, token usage" },
    { command: "model", description: "Switch model for this chat" },
    { command: "think", description: "Set thinking level" },
    { command: "effort", description: "Set effort level" },
    { command: "usage", description: "Token usage for this session" },
    { command: "compact", description: "Force compaction of chat history" },
    { command: "voice", description: "Voice transcription info" },
  ]).catch(() => {});

  /** Check if userId is allowed for this agent (in-memory + file fallback) */
  function isUserAllowed(userId: number): boolean {
    const agent = getAgent(0);
    if (agent.allowedUsers.includes(userId)) return true;
    // Fallback: read config file directly (handles hot-reload delay)
    try {
      const fresh = loadConfig();
      const freshAgent = agentId === "telegram"
        ? fresh.telegram
        : fresh.agents[agentId]?.telegram;
      const freshAllowed = freshAgent?.allowedUsers ?? [];
      if (freshAllowed.includes(userId)) return true;
    } catch {}
    return false;
  }

  // Access control — admin approves, user gets instant access
  b.use(async (ctx, next) => {
    const agent = getAgent(ctx.chat?.id ?? 0);
    if (agent.allowedUsers.length === 0) { await next(); return; }
    const userId = ctx.from?.id;
    if (!userId) return;
    if (isUserAllowed(userId)) { await next(); return; }

    // Unauthorized user in group — silent reject
    if (ctx.chat && isGroupChat(ctx.chat.type)) return;

    // Check if user already has a pending request
    const pending = hasPendingRequest(userId, agentId);
    if (pending) {
      await ctx.reply(`Your access request is pending approval.\nCode: ${pending.code}`);
      return;
    }

    // Create new pairing request
    const request = createPairingRequest(
      userId, agentId, ctx.chat!.id,
      ctx.from?.username, ctx.from?.first_name,
    );
    await ctx.reply(
      `Access requested. Waiting for admin approval.\nCode: ${request.code}`,
    );

    notifyAdminOfPairing(request, getConfig(), activeBots);
  });

  // ─── Commands ─────────────────────────────────────────────────────

  b.command("start", async (ctx) => {
    const agent = getAgent(ctx.chat.id);
    if (isGroupChat(ctx.chat.type)) {
      await ctx.reply(`${agent.name} added. Mention me with @${botInfo.username} to chat.`);
    } else {
      await ctx.reply(`${agent.name} is ready.\n\nModel: ${agent.model}\nSend me a message or type /help for commands.`);
    }
  });

  b.command("help", async (ctx) => {
    const agent = getAgent(ctx.chat.id);
    const lines = [
      `${agent.name} Commands:\n`,
      "/help — List commands and current config",
      "/clear — Clear this chat's history",
      "/status — Show model, message count, token usage",
      "/model <name> — Switch model for this chat",
      "/think <level> — Set thinking (off|low|medium|high)",
      "/effort <level> — Set effort (low|medium|high|max)",
      "/compact — Force compaction of chat history",
      "",
      `Model: ${agent.model}`,
      `Thinking: ${agent.thinking}`,
      `Effort: ${agent.effort}`,
      `Max turns: ${agent.maxTurns}`,
    ];
    await ctx.reply(lines.join("\n"));
  });

  b.command("clear", async (ctx) => {
    deleteSession(sid(ctx.chat.id));
    runtimeModels.delete(ctx.chat.id);
    runtimeThinking.delete(ctx.chat.id);
    runtimeEffort.delete(ctx.chat.id);
    await ctx.reply("Session cleared.");
  });

  b.command("status", async (ctx) => {
    const agent = getAgent(ctx.chat.id);
    const sessionId = sid(ctx.chat.id);
    const messages = loadMessages(sessionId);
    const usage = getSessionUsage(sessionId);
    const historyChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const historyTokens = Math.ceil(historyChars / CHARS_PER_TOKEN);

    const lines = [
      `Agent: ${agent.name}`,
      `Model: ${agent.model}`,
      `Thinking: ${agent.thinking}`,
      `Effort: ${agent.effort}`,
      `Messages: ${messages.length}`,
      `History: ~${historyTokens} tokens`,
    ];
    if (usage.calls > 0) lines.push(`Usage: ${formatUsageSummary(usage)}`);
    if (runtimeModels.has(ctx.chat.id)) lines.push(`(runtime override, resets on /clear or restart)`);
    await ctx.reply(lines.join("\n"));
  });

  b.command("model", async (ctx) => {
    const newModel = ctx.match?.trim();
    if (!newModel) {
      const agent = getAgent(ctx.chat.id);
      await ctx.reply(`Current model: ${agent.model}\n\nUsage: /model <name>`);
      return;
    }
    runtimeModels.set(ctx.chat.id, newModel);
    await ctx.reply(`Model switched to: ${newModel}\n(runtime only, resets on /clear or restart)`);
  });

  b.command("think", async (ctx) => {
    const levels = ["off", "low", "medium", "high"] as const;
    const arg = ctx.match?.trim() as typeof levels[number];
    const agent = getAgent(ctx.chat.id);
    if (!arg) {
      const kb = new InlineKeyboard();
      for (const l of levels) {
        kb.text(l === agent.thinking ? `✓ ${l}` : l, `think:${l}`);
      }
      await ctx.reply(`Thinking: ${agent.thinking}`, { reply_markup: kb });
      return;
    }
    if (!levels.includes(arg)) {
      await ctx.reply("Invalid level. Use: off, low, medium, high");
      return;
    }
    runtimeThinking.set(ctx.chat.id, arg);
    await ctx.reply(`Thinking set to: ${arg}`);
  });

  b.callbackQuery(/^think:(.+)$/, async (ctx) => {
    const level = ctx.callbackQuery.data.split(":")[1] as Config["thinking"];
    runtimeThinking.set(ctx.chat!.id, level);
    try { await ctx.editMessageText(`Thinking: ${level} ✓`); } catch {}
    await ctx.answerCallbackQuery();
  });

  b.command("effort", async (ctx) => {
    const levels = ["low", "medium", "high", "max"] as const;
    const arg = ctx.match?.trim() as typeof levels[number];
    const agent = getAgent(ctx.chat.id);
    if (!arg) {
      const kb = new InlineKeyboard();
      for (const l of levels) {
        kb.text(l === agent.effort ? `✓ ${l}` : l, `effort:${l}`);
      }
      await ctx.reply(`Effort: ${agent.effort}`, { reply_markup: kb });
      return;
    }
    if (!levels.includes(arg)) {
      await ctx.reply("Invalid level. Use: low, medium, high, max");
      return;
    }
    runtimeEffort.set(ctx.chat.id, arg);
    await ctx.reply(`Effort set to: ${arg}`);
  });

  b.callbackQuery(/^effort:(.+)$/, async (ctx) => {
    const level = ctx.callbackQuery.data.split(":")[1] as Config["effort"];
    runtimeEffort.set(ctx.chat!.id, level);
    try { await ctx.editMessageText(`Effort: ${level} ✓`); } catch {}
    await ctx.answerCallbackQuery();
  });

  b.command("compact", async (ctx) => {
    const config = getConfig();
    const agent = getAgent(ctx.chat.id);
    const sessionId = sid(ctx.chat.id);
    const history = loadMessages(sessionId);
    if (history.length === 0) { await ctx.reply("No history to compact."); return; }

    const client = createClient(config);
    const result = await compactHistory(client, agent.model, history, { ...config.compaction, enabled: true, agentId: agentId === "telegram" ? undefined : agentId });
    if (result) {
      await ctx.reply(`Compacted: ${history.length} -> ${result.length} messages`);
    } else {
      await ctx.reply(`History is already compact (${history.length} messages).`);
    }
  });

  // ─── Admin-only commands: redirect to admin bot ──────────────────

  const adminRedirect = async (ctx: any) => {
    const config = getConfig();
    const adminEntry = Object.entries(config.agents).find(([, a]) => a.admin);
    const adminState = adminEntry ? activeBots.get(adminEntry[0]) : undefined;
    const adminUsername = adminState?.botInfo?.username;
    if (adminUsername) {
      await ctx.reply(`This is an admin command. Use it in @${adminUsername}`);
    } else {
      await ctx.reply("This command is only available in the admin bot.");
    }
  };

  b.command("agents", adminRedirect);
  b.command("soul", adminRedirect);
  b.command("sessions", adminRedirect);
  b.command("config", adminRedirect);
  b.command("setup", adminRedirect);
  b.command("newagent", adminRedirect);
  b.command("deleteagent", adminRedirect);
  b.command("pairing", adminRedirect);
  b.command("restart", adminRedirect);

  // ─── Approval callback queries ────────────────────────────────────

  b.callbackQuery(/^approve:(.+):(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^approve:(.+):(.+)$/);
    if (!match) return;
    const [, approvalId, decision] = match;
    const resolved = submitDecision(approvalId, decision as ApprovalDecision);
    if (resolved) {
      const label = decision === "allow-once" ? "Allowed" : decision === "allow-always" ? "Always allowed" : "Denied";
      await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ""}\n\n-> ${label}`);
    }
    await ctx.answerCallbackQuery();
  });

  // ─── Shared message handler ─────────────────────────────────────────

  async function handleIncoming(ctx: any, cleanText: string) {
    const config = getConfig();
    const agent = getAgent(ctx.chat.id);
    const sessionId = sid(ctx.chat.id);

    const chatContext = isGroupChat(ctx.chat.type)
      ? (ctx.chat as any).title
      : ctx.from?.first_name;
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
        await ctx.api.setMessageReaction(ctx.chat.id, ctx.message.message_id, reactions);
      } catch {}
    };

    const draft = createDraftStream(ctx.chat.id, ctx.api);
    let pendingText = "";

    try {
      await setReaction("eyes");
      await ctx.replyWithChatAction("typing");
      await setReaction("thinking_face");

      const result = await orchestrate({
        sessionId,
        message: cleanText,
        config,
        systemPrompt: agent.systemPrompt,
        client,
        signal: abortController.signal,
        agentId: agentId === "telegram" ? undefined : agentId,
        label,
        model: agent.model,
        agentSystemPrompt: agent.systemPrompt,
        thinking: agent.thinking,
        effort: agent.effort,
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
              await ctx.api.sendMessage(ctx.chat.id, `${event.toolName}\n${event.preview}`, {
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
        try { await ctx.api.deleteMessage(ctx.chat.id, streamMsgId); } catch {}
        await sendChunked(ctx, response);
      } else if (!streamMsgId) {
        await sendChunked(ctx, response);
      }

      await setReaction("");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      slog.error("telegram", "Agent run failed", { agent: agent.name, sessionId, error: errMsg });
      const streamMsgId = draft.getMessageId();
      if (streamMsgId) {
        try { await ctx.api.editMessageText(ctx.chat.id, streamMsgId, `Error: ${errMsg}`); }
        catch { await ctx.reply(`Error: ${errMsg}`); }
      } else {
        await ctx.reply(`Error: ${errMsg}`);
      }
      await setReaction("");
    }
  }

  // ─── /voice command (redirect to admin) ────────────────────────────

  b.command("voice", async (ctx) => {
    const config = getConfig();
    if (config.voice.enabled) {
      await ctx.reply("Voice is enabled. Send a voice message and I'll transcribe it.");
    } else {
      const adminEntry = Object.entries(config.agents).find(([, a]) => a.admin);
      const adminState = adminEntry ? activeBots.get(adminEntry[0]) : undefined;
      const adminUsername = adminState?.botInfo?.username;
      const hint = adminUsername
        ? `Voice not configured. Set it up in @${adminUsername} with /voice`
        : "Voice transcription is not configured.";
      await ctx.reply(hint);
    }
  });

  // ─── Text message handler ─────────────────────────────────────────

  b.on("message:text", async (ctx) => {
    const agent = getAgent(ctx.chat.id);
    const text = ctx.message.text;

    if (isGroupChat(ctx.chat.type) && agent.mentionOnly) {
      const replyToBotId = ctx.message.reply_to_message?.from?.id;
      if (!shouldRespondInGroup(text, replyToBotId, botInfo.id, botInfo.username)) {
        return;
      }
    }

    const cleanText = stripMention(text, botInfo.username);
    if (!cleanText) return;

    await handleIncoming(ctx, cleanText);
  });

  // ─── Voice/audio message handler ──────────────────────────────────

  b.on(["message:voice", "message:audio"], async (ctx) => {
    const config = getConfig();

    if (!config.voice.enabled || !config.voice.apiKey) {
      const adminEntry = Object.entries(config.agents).find(([, a]) => a.admin);
      const hint = adminEntry
        ? "Voice transcription is not configured. Use /voice in the admin bot to enable it."
        : "Voice transcription is not configured.";
      await ctx.reply(hint);
      return;
    }

    try {
      await ctx.replyWithChatAction("typing");

      const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
      if (!fileId) { await ctx.reply("Could not read audio file."); return; }

      const file = await ctx.api.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) { await ctx.reply("Failed to download voice file."); return; }

      const buffer = Buffer.from(await resp.arrayBuffer());

      if (buffer.length > 20 * 1024 * 1024) {
        await ctx.reply("Audio file too large (max 20 MB).");
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
        await ctx.reply("(could not transcribe — empty result)");
        return;
      }

      const cleanText = `[Voice] ${result.text.trim()}`;
      slog.info("telegram", "Voice transcribed", {
        agent: agentId, text: cleanText.slice(0, 160), provider: config.voice.provider,
      });

      await handleIncoming(ctx, cleanText);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      slog.error("telegram", "Voice processing failed", { agent: agentId, error: errMsg });
      await ctx.reply(`Voice error: ${errMsg}`);
    }
  });

  b.catch((err) => {
    slog.error("telegram", "Bot error", { agent: agentId, error: err.message ?? String(err) });
  });

  startPolling(b, agentId);
}
