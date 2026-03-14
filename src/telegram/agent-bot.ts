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
import { hasPendingRequest, createPairingRequest, verifyOtp } from "./pairing.js";
import { notifyAdminOfPairing } from "./pairing-notify.js";
import { log as slog } from "../core/log.js";

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
  };
  activeBots.set(agentId, state);

  // Register first bot for approval forwarding (headless -> Telegram)
  if (activeBots.size === 1) {
    registerForwardBot(b);
  }

  const { botInfo, runtimeModels } = state;

  const sid = (chatId: number) =>
    agentId === "telegram" ? `telegram-${chatId}` : `${agentId}-${chatId}`;

  const getAgent = (chatId: number) =>
    resolveAgent(agentId, getConfig(), getSystemPrompt(), runtimeModels.get(chatId));

  // Register commands
  await b.api.setMyCommands([
    { command: "help", description: "List commands and current config" },
    { command: "clear", description: "Clear this chat's history" },
    { command: "status", description: "Show model, message count, token usage" },
    { command: "model", description: "Switch model for this chat (runtime)" },
    { command: "compact", description: "Force compaction of chat history" },
    { command: "agents", description: "List all agents" },
    { command: "soul", description: "View/edit agent SOUL.md" },
    { command: "sessions", description: "List all sessions" },
    { command: "config", description: "View/edit config" },
  ]).catch(() => {});

  // Track users verified via OTP — persists for this process lifetime
  const otpVerifiedUsers = new Set<number>();

  /** Check if userId is allowed for this agent (in-memory + file fallback) */
  function isUserAllowed(userId: number): boolean {
    if (otpVerifiedUsers.has(userId)) return true;
    const agent = getAgent(0); // just need allowedUsers, chatId doesn't matter
    if (agent.allowedUsers.includes(userId)) return true;
    // Fallback: read config file directly
    try {
      const fresh = loadConfig();
      const freshAgent = agentId === "telegram"
        ? fresh.telegram
        : fresh.agents[agentId]?.telegram;
      const freshAllowed = freshAgent?.allowedUsers ?? [];
      if (freshAllowed.includes(userId)) {
        otpVerifiedUsers.add(userId);
        return true;
      }
    } catch {}
    return false;
  }

  // Access control with pairing + OTP verification
  b.use(async (ctx, next) => {
    const agent = getAgent(ctx.chat?.id ?? 0);
    if (agent.allowedUsers.length === 0) { await next(); return; }
    const userId = ctx.from?.id;
    if (!userId) return;
    if (isUserAllowed(userId)) { await next(); return; }

    // Unauthorized user in group — silent reject
    if (ctx.chat && isGroupChat(ctx.chat.type)) return;

    // Check if user has a pending request
    const pending = hasPendingRequest(userId, agentId);

    if (pending?.status === "otp_pending") {
      const text = ctx.message && "text" in ctx.message ? ctx.message.text?.trim() : undefined;
      if (!text) {
        await ctx.reply("Please enter the 5-digit verification code.");
        return;
      }

      if (/^\d{5}$/.test(text)) {
        const result = verifyOtp(userId, agentId, text);
        if (result.ok) {
          otpVerifiedUsers.add(userId);
          console.log(`[agent-bot] OTP verified for userId=${userId}, agent=${agentId}`);
          await ctx.reply("Verification complete. You now have access.");
          await next();
          return;
        }
        const msgs: Record<string, string> = {
          expired: "Verification code expired. Please request access again.",
          locked: "Too many failed attempts. Please request access again.",
          wrong: "Invalid code. Please try again.",
          not_found: "No pending verification found. Please request access again.",
        };
        await ctx.reply(msgs[result.reason] ?? "Invalid code.");
        return;
      }

      await ctx.reply("Admin has approved your request. Please enter the 5-digit verification code to complete access.");
      return;
    }

    if (pending) {
      await ctx.reply(`Your access request is pending approval.\nCode: ${pending.code}`);
      return;
    }

    console.log(`[agent-bot] Creating pairing request: userId=${userId}, agent=${agentId}, otpSetSize=${otpVerifiedUsers.size}`);
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
      "/compact — Force compaction of chat history",
      "",
      `Model: ${agent.model}`,
      `Thinking: ${agent.thinking}`,
      `Max turns: ${agent.maxTurns}`,
    ];
    await ctx.reply(lines.join("\n"));
  });

  b.command("clear", async (ctx) => {
    deleteSession(sid(ctx.chat.id));
    runtimeModels.delete(ctx.chat.id);
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

  // ─── Message handler ──────────────────────────────────────────────

  b.on("message:text", async (ctx) => {
    const config = getConfig();
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
  });

  b.catch((err) => {
    slog.error("telegram", "Bot error", { agent: agentId, error: err.message ?? String(err) });
  });

  startPolling(b, agentId);
}
