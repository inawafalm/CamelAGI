// Admin bot: BotFather-style Telegram control plane — setup + wiring
// When adminTools is enabled, also handles natural-language AI messages.

import { Bot, InlineKeyboard } from "grammy";
import { loadConfig, type Config } from "../core/config.js";
import type { BotState } from "./types.js";
import type { AgentEvent } from "../agent.js";
import { advanceWizard, hasActiveWizard, cancelWizard } from "./wizard.js";
import { isGroupChat, sendChunked } from "./helpers.js";
import { hasPendingRequest, createPairingRequest } from "../extensions/pairing.js";
import { registerAdminCommands } from "./admin-commands.js";
import { registerAdminAgents } from "./admin-agents.js";
import { orchestrate } from "../runtime/orchestrate.js";
import { createClient } from "../model.js";
import { isRunActive } from "../runtime/runs.js";
import { queueOrProcess } from "../runtime/queue.js";
import { createDraftStream } from "./draft-stream.js";
import { log as slog } from "../core/log.js";
import { buildSystemPrompt } from "../system-prompt.js";

export async function setupAdminBot(
  agentId: string,
  botToken: string,
  getConfig: () => Config,
  getSystemPrompt: () => string,
  activeBots: Map<string, BotState>,
): Promise<Bot> {
  const b = new Bot(botToken);

  await b.api.setMyCommands([
    { command: "help", description: "List all commands" },
    { command: "setup", description: "Configure API provider, key, model" },
    { command: "newagent", description: "Create a new agent" },
    { command: "agents", description: "List all agents" },
    { command: "deleteagent", description: "Delete an agent" },
    { command: "soul", description: "View/edit agent SOUL.md" },
    { command: "mcp", description: "Manage MCP servers" },
    { command: "config", description: "View/update configuration" },
    { command: "agent", description: "View/edit agent config" },
    { command: "usage", description: "Per-agent usage & cost summary" },
    { command: "sessions", description: "Manage sessions" },
    { command: "status", description: "System health and stats" },
    { command: "restart", description: "Restart agent bots" },
    { command: "pairing", description: "List pending access requests" },
    { command: "voice", description: "Configure voice transcription" },
    { command: "cancel", description: "Cancel active wizard" },
  ]).catch(() => {});

  // ─── Access control ─────────────────────────────────────────────────

  function isUserAllowed(userId: number): boolean {
    const memAgent = getConfig().agents[agentId];
    const memAllowed = memAgent?.telegram?.allowedUsers ?? [];
    if (memAllowed.includes(userId)) return true;
    try {
      const freshConfig = loadConfig();
      const freshAgent = freshConfig.agents[agentId];
      const freshAllowed = freshAgent?.telegram?.allowedUsers ?? [];
      if (freshAllowed.includes(userId)) return true;
    } catch {}
    return false;
  }

  b.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (isUserAllowed(userId)) { await next(); return; }
    if (ctx.chat && isGroupChat(ctx.chat.type)) return;

    const pending = hasPendingRequest(userId, agentId);
    if (pending) {
      await ctx.reply(`Your access request is pending approval.\nCode: ${pending.code}`);
      return;
    }

    const request = createPairingRequest(
      userId, agentId, ctx.chat!.id,
      ctx.from?.username, ctx.from?.first_name,
    );
    const who = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name ?? String(userId);
    console.log(`\n  \x1b[33mPairing request from ${who}\x1b[0m\n  \x1b[90mRun: camel pairing\x1b[0m\n`);
    await ctx.reply(`Access requested. Waiting for approval...\nCode: ${request.code}`);
  });

  // ─── Wizard callback queries ────────────────────────────────────────

  b.callbackQuery(/^wizard:(.+):(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^wizard:(.+):(.+)$/);
    if (!match) return;
    const [, stepId, value] = match;
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const buttonText = ctx.callbackQuery.message && "reply_markup" in ctx.callbackQuery.message
      ? ctx.callbackQuery.message.reply_markup?.inline_keyboard
          ?.flat()
          ?.find((btn: any) => btn.callback_data === ctx.callbackQuery.data)
          ?.text
      : undefined;
    const displayValue = buttonText ?? value;
    try { await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ""}\n\n-> ${displayValue}`); } catch {}
    await ctx.answerCallbackQuery();
    await advanceWizard(chatId, value, b);
  });

  // ─── Register modules ───────────────────────────────────────────────

  registerAdminCommands(b, agentId, getConfig, getSystemPrompt, activeBots);
  registerAdminAgents(b, agentId, getConfig, getSystemPrompt, activeBots);

  // ─── Message handler: wizard text intercept + AI fallback ───────────

  const agentCfg = getConfig().agents[agentId];
  const adminToolsEnabled = agentCfg?.adminTools || agentCfg?.admin || false;

  b.catch((err) => {
    console.error(`[admin-bot] Error:`, err.message ?? err);
  });

  b.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    // Commands are handled by grammy's command() registrations above
    if (text.startsWith("/")) return;

    // Active wizard gets priority
    if (hasActiveWizard(chatId)) {
      if (text === "/cancel") { cancelWizard(chatId); await ctx.reply("Wizard cancelled."); return; }
      const handled = await advanceWizard(chatId, text, b);
      if (handled) return;
    }

    // AI fallback: route to orchestrate when adminTools is enabled
    console.log(`[admin-bot] AI chat: adminToolsEnabled=${adminToolsEnabled} text="${text.slice(0, 80)}"`);
    if (!adminToolsEnabled) return;

    const sessionId = `${agentId}-${chatId}`;

    if (isRunActive(sessionId)) {
      await queueOrProcess(sessionId, text);
      return;
    }

    const config = getConfig();
    const client = createClient(config);
    const sysPrompt = buildSystemPrompt(
      getSystemPrompt(),
      config.skills,
      agentId,
    );
    const model = config.agents[agentId]?.model ?? config.model;
    const thinking = config.agents[agentId]?.thinking ?? config.thinking;
    const effort = config.agents[agentId]?.effort ?? config.effort;

    const draft = createDraftStream(chatId, b.api);
    let pendingText = "";

    const setReaction = async (emoji: string) => {
      try {
        const reactions = emoji ? [{ type: "emoji" as const, emoji: emoji as any }] : [];
        await b.api.setMessageReaction(chatId, ctx.message.message_id, reactions);
      } catch {}
    };

    try {
      await setReaction("thinking_face");
      await ctx.replyWithChatAction("typing");

      slog.info("telegram", "Admin AI message", { agent: agentId, sessionId, text: text.slice(0, 160) });

      const result = await orchestrate({
        sessionId,
        message: text,
        config,
        systemPrompt: sysPrompt,
        client,
        agentId,
        agentSystemPrompt: sysPrompt,
        model,
        thinking,
        effort,
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
          } else if (event.type === "approval_request") {
            await setReaction("lock");
            const keyboard = new InlineKeyboard()
              .text("Allow", `approve:${event.id}:allow-once`)
              .text("Always", `approve:${event.id}:allow-always`)
              .text("Deny", `approve:${event.id}:deny`);
            try {
              await b.api.sendMessage(chatId, `${event.toolName}\n${event.preview}`, { reply_markup: keyboard });
            } catch {}
          }
        },
      });

      const response = result.response || "(no response)";
      slog.info("telegram", "Admin AI response", { agent: agentId, sessionId, text: response.slice(0, 160) });

      pendingText = response;
      draft.update(response);
      await draft.flush();

      const streamMsgId = draft.getMessageId();
      if (streamMsgId && response.length > 4096) {
        try { await b.api.deleteMessage(chatId, streamMsgId); } catch {}
        await sendChunked(ctx, response);
      } else if (!streamMsgId) {
        await sendChunked(ctx, response);
      }

      await setReaction("");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      slog.error("telegram", "Admin AI failed", { agent: agentId, error: errMsg });
      const streamMsgId = draft.getMessageId();
      if (streamMsgId) {
        try { await b.api.editMessageText(chatId, streamMsgId, `Error: ${errMsg}`); }
        catch { await ctx.reply(`Error: ${errMsg}`); }
      } else {
        await ctx.reply(`Error: ${errMsg}`);
      }
      await setReaction("");
    }
  });

  return b;
}
