// Admin bot: BotFather-style Telegram control plane for CamelAGI

import { Bot, InlineKeyboard } from "grammy";
import fs from "node:fs";
import path from "node:path";
import { saveConfig, loadConfig, type Config } from "../core/config.js";
import { agentMemoryDir } from "../workspace.js";
import { listSessions, deleteSession, loadMessages } from "../session.js";
import { getSessionUsage, formatUsageSummary } from "../usage.js";
import { CHARS_PER_TOKEN } from "../core/constants.js";
import { getActiveBotIds, startBot, stopBot } from "../telegram.js";
import type { BotState } from "./types.js";
import { startWizard, advanceWizard, cancelWizard, hasActiveWizard } from "./wizard.js";
import { createSetupWizard, createNewAgentWizard } from "./wizards.js";
import { createVoiceWizard, createVoiceResetWizard } from "./voice-wizard.js";
import type { WizardDef } from "./wizard.js";
import { formatAge } from "./helpers.js";
import { approveRequest, denyRequest, listPendingRequests, hasPendingRequest, createPairingRequest, verifyOtp } from "./pairing.js";
import { notifyUserOtpRequired, notifyUserOfDenial } from "./pairing-notify.js";
import { isGroupChat } from "./helpers.js";
import {
  listPendingBotApprovals,
  approveBotApproval,
  denyBotApproval,
  type BotApproval,
} from "./bot-approval.js";

// ─── Helpers ─────────────────────────────────────────────────────────

async function showSoul(chatId: number, targetId: string, edit: boolean, bot: Bot): Promise<void> {
  const soulPath = path.join(agentMemoryDir(targetId), "SOUL.md");

  if (edit) {
    const editWizard: WizardDef = {
      id: "soul-edit",
      steps: [{
        id: "content",
        prompt: `Send the new SOUL.md content for "${targetId}".\nCurrent content will be replaced. /cancel to abort.`,
      }],
      onComplete: async (data) => {
        const dir = agentMemoryDir(targetId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(soulPath, data.content);
        return `SOUL.md updated for "${targetId}".\n\n${data.content.slice(0, 200)}${data.content.length > 200 ? "..." : ""}`;
      },
    };
    await startWizard(chatId, editWizard, bot);
    return;
  }

  if (!fs.existsSync(soulPath)) {
    await bot.api.sendMessage(chatId, `No SOUL.md for "${targetId}" yet.`);
    return;
  }

  const content = fs.readFileSync(soulPath, "utf-8").trim();
  const preview = content.length > 3800 ? content.slice(0, 3800) + "\n\n[truncated]" : content;
  const kb = new InlineKeyboard()
    .text("Edit", `picksoul:edit:${targetId}`);
  await bot.api.sendMessage(chatId, `SOUL.md (${targetId}):\n\n${preview}`, { reply_markup: kb });
}

// ─── Setup Admin Bot ─────────────────────────────────────────────────

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
    { command: "config", description: "View/update configuration" },
    { command: "sessions", description: "Manage sessions" },
    { command: "status", description: "System health and stats" },
    { command: "restart", description: "Restart agent bots" },
    { command: "pairing", description: "List pending access requests" },
    { command: "voice", description: "Configure voice transcription" },
    { command: "cancel", description: "Cancel active wizard" },
  ]).catch(() => {});

  // Track users verified via OTP — persists for this process lifetime
  const otpVerifiedUsers = new Set<number>();

  /** Check if userId is in allowedUsers for this agent (reads config FILE, not memory) */
  function isUserAllowed(userId: number): boolean {
    // 1. Fast: in-memory Set
    if (otpVerifiedUsers.has(userId)) {
      console.log(`[admin-bot] isUserAllowed(${userId}): YES (otpVerifiedUsers set, size=${otpVerifiedUsers.size})`);
      return true;
    }
    // 2. Fast: in-memory config
    const memAgent = getConfig().agents[agentId];
    const memAllowed = memAgent?.telegram?.allowedUsers ?? [];
    if (memAllowed.includes(userId)) {
      console.log(`[admin-bot] isUserAllowed(${userId}): YES (in-memory config, allowedUsers=[${memAllowed}])`);
      return true;
    }
    // 3. Slow fallback: read config file directly (handles stale memory / process restart)
    try {
      const freshConfig = loadConfig();
      const freshAgent = freshConfig.agents[agentId];
      const freshAllowed = freshAgent?.telegram?.allowedUsers ?? [];
      if (freshAllowed.includes(userId)) {
        otpVerifiedUsers.add(userId); // cache for next time
        console.log(`[admin-bot] isUserAllowed(${userId}): YES (file fallback, allowedUsers=[${freshAllowed}])`);
        return true;
      }
      console.log(`[admin-bot] isUserAllowed(${userId}): NO — otpSet=[${[...otpVerifiedUsers]}] memAllowed=[${memAllowed}] fileAllowed=[${freshAllowed}] agentExists=${!!memAgent} fileAgentExists=${!!freshAgent}`);
    } catch (err) {
      console.error(`[admin-bot] isUserAllowed(${userId}): NO — file fallback THREW: ${err}`);
    }
    return false;
  }

  // Access control with pairing + OTP verification
  b.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Authorized check (in-memory + file fallback)
    if (isUserAllowed(userId)) { await next(); return; }

    // Groups: silent reject for unauthorized users
    if (ctx.chat && isGroupChat(ctx.chat.type)) return;

    // Check if user has a pending request
    const pending = hasPendingRequest(userId, agentId);

    if (pending?.status === "otp_pending") {
      // User approved by macOS app, waiting for OTP
      const text = ctx.message && "text" in ctx.message ? ctx.message.text?.trim() : undefined;
      if (!text) {
        await ctx.reply("Please enter the 5-digit verification code from your Camel app.");
        return;
      }

      if (/^\d{5}$/.test(text)) {
        const result = verifyOtp(userId, agentId, text);
        if (result.ok) {
          otpVerifiedUsers.add(userId);
          console.log(`[admin-bot] OTP verified for userId=${userId}, agent=${agentId}, setSize=${otpVerifiedUsers.size}`);
          await ctx.reply("Verification complete. You are now an admin.");
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

      // Not a 5-digit number
      await ctx.reply("Enter the 5-digit verification code shown in your Camel app.");
      return;
    }

    if (pending) {
      await ctx.reply(`Your access request is pending approval.\nCode: ${pending.code}`);
      return;
    }

    // Not authorized and no pending request — create one
    console.log(`[admin-bot] Creating pairing request: userId=${userId}, agent=${agentId}, otpSetSize=${otpVerifiedUsers.size}, otpHas=${otpVerifiedUsers.has(userId)}`);
    const request = createPairingRequest(
      userId, agentId, ctx.chat!.id,
      ctx.from?.username, ctx.from?.first_name,
    );
    await ctx.reply(
      `Access requested. Waiting for approval...\nCode: ${request.code}`,
    );
  });

  // ─── Callback queries ─────────────────────────────────────────────

  b.callbackQuery(/^wizard:(.+):(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^wizard:(.+):(.+)$/);
    if (!match) return;
    const [, stepId, value] = match;
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    // Show the button label (not raw value like __default__)
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

  b.callbackQuery(/^picksoul:(.+):(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^picksoul:(.+):(.+)$/);
    if (!match) return;
    const [, action, id] = match;
    await ctx.answerCallbackQuery();
    try { await ctx.editMessageText(`-> ${id}`); } catch {}
    await showSoul(ctx.chat!.id, id, action === "edit", b);
  });

  b.callbackQuery(/^pickdelete:(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^pickdelete:(.+)$/);
    if (!match) return;
    const id = match[1];
    await ctx.answerCallbackQuery();
    const config = getConfig();
    if (!config.agents[id]) {
      try { await ctx.editMessageText("Agent not found."); } catch {}
      return;
    }
    const kb = new InlineKeyboard()
      .text("Yes, delete", `confirm:delete:${id}`)
      .text("Cancel", `confirm:cancel:${id}`);
    try {
      await ctx.editMessageText(
        `Delete "${config.agents[id].name}" (${id})?\n\nBot will be stopped. Workspace files are preserved.`,
        { reply_markup: kb },
      );
    } catch {}
  });

  b.callbackQuery(/^confirm:(.+):(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^confirm:(.+):(.+)$/);
    if (!match) return;
    const [, action, param] = match;
    try {
      await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ""}\n\n-> ${action === "delete" ? "Deleting..." : "Cancelled"}`);
    } catch {}
    await ctx.answerCallbackQuery();
    if (action === "delete") {
      const config = getConfig();
      if (config.agents[param]) {
        stopBot(param);
        const agents = { ...config.agents };
        delete agents[param];
        saveConfig({ agents });
        await ctx.reply(`Agent "${param}" deleted.\nWorkspace files preserved at ${agentMemoryDir(param)}`);
      }
    }
  });

  b.callbackQuery(/^clearsessions:(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^clearsessions:(.+)$/);
    if (!match) return;
    const [, period] = match;
    const cutoff = { "1d": 86400000, "1w": 604800000, "1m": 2592000000 }[period] ?? 604800000;
    const now = Date.now();
    const sessions = listSessions();
    let deleted = 0;
    for (const s of sessions) {
      if (now - s.createdAt > cutoff) { deleteSession(s.id); deleted++; }
    }
    try {
      await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ""}\n\n-> Deleted ${deleted} sessions`);
    } catch {}
    await ctx.answerCallbackQuery();
  });

  // ─── Pairing callbacks ───────────────────────────────────────────

  b.callbackQuery(/^pairing:(approve|deny):(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^pairing:(approve|deny):(.+)$/);
    if (!match) return;
    const [, action, code] = match;

    if (action === "approve") {
      const request = approveRequest(code);
      if (request) {
        try {
          await ctx.editMessageText(
            `${ctx.callbackQuery.message?.text ?? ""}\n\n-> Approved (OTP: ${request.otp})\nUser must enter this code in chat.`,
          );
        } catch {}
        await notifyUserOtpRequired(request, activeBots);
      } else {
        try { await ctx.editMessageText("Request expired or already handled."); } catch {}
      }
    } else {
      const request = denyRequest(code);
      if (request) {
        try {
          await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ""}\n\n-> Denied`);
        } catch {}
        await notifyUserOfDenial(request, activeBots);
      } else {
        try { await ctx.editMessageText("Request expired or already handled."); } catch {}
      }
    }

    await ctx.answerCallbackQuery();
  });

  // ─── Bot approval callbacks ─────────────────────────────────────

  b.callbackQuery(/^botapproval:(approve|deny):(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^botapproval:(approve|deny):(.+)$/);
    if (!match) return;
    const [, action, agentIdParam] = match;

    if (action === "approve") {
      const approval = approveBotApproval(agentIdParam);
      if (approval) {
        const botLabel = approval.botUsername ? `@${approval.botUsername}` : agentIdParam;
        try {
          const sysPrompt = getSystemPrompt();
          await startBot(agentIdParam, approval.botToken, getConfig, () => sysPrompt);
        } catch (err) {
          // "already running" is fine — config hot-reload may have started it
          const errMsg = err instanceof Error ? err.message : String(err);
          if (!errMsg.includes("already running") && !errMsg.includes("already starting")) {
            try { await ctx.editMessageText(`Failed to start bot: ${errMsg}`); } catch {}
            await ctx.answerCallbackQuery();
            return;
          }
        }
        try {
          await ctx.editMessageText(
            `${ctx.callbackQuery.message?.text ?? ""}\n\n-> Approved. ${botLabel} is now running.`,
          );
        } catch {}
      } else {
        try { await ctx.editMessageText("Approval not found or already handled."); } catch {}
      }
    } else {
      const approval = denyBotApproval(agentIdParam);
      if (approval) {
        try {
          await ctx.editMessageText(
            `${ctx.callbackQuery.message?.text ?? ""}\n\n-> Denied. Bot will not start.`,
          );
        } catch {}
      } else {
        try { await ctx.editMessageText("Approval not found or already handled."); } catch {}
      }
    }

    await ctx.answerCallbackQuery();
  });

  // ─── Commands ─────────────────────────────────────────────────────

  b.command("start", async (ctx) => {
    const config = getConfig();
    const hasApiKey = !!config.apiKey;
    const agentCount = Object.keys(config.agents).length;
    await ctx.reply([
      "CamelAGI Admin\n",
      "I manage your AI agents from here.",
      "",
      hasApiKey ? `API configured (${config.provider}, ${config.model})` : "No API key — run /setup first",
      `${agentCount} agent(s) configured`,
      "",
      "Commands:",
      "/setup — configure API provider & key",
      "/newagent — create an agent",
      "/agents — list agents",
      "/help — all commands",
    ].join("\n"));
  });

  b.command("help", async (ctx) => {
    await ctx.reply([
      "CamelAGI Admin Commands\n",
      "Setup & Config:",
      "  /setup — configure API provider, key, model",
      "  /config — view current config",
      "  /config <key> <value> — update config",
      "",
      "Agents:",
      "  /newagent — create a new agent",
      "  /agents — list all agents",
      "  /deleteagent — pick & delete an agent",
      "  /soul — view/edit agent personality",
      "",
      "Access:",
      "  /pairing — list pending access requests",
      "",
      "Sessions & Status:",
      "  /sessions — list sessions",
      "  /status — system health",
      "  /restart — restart all bots",
      "",
      "  /cancel — cancel active wizard",
    ].join("\n"));
  });

  b.command("cancel", async (ctx) => {
    if (cancelWizard(ctx.chat.id)) {
      await ctx.reply("Wizard cancelled.");
    } else {
      await ctx.reply("No active wizard.");
    }
  });

  b.command("setup", async (ctx) => {
    await startWizard(ctx.chat.id, createSetupWizard(getConfig), b);
  });

  b.command("newagent", async (ctx) => {
    const config = getConfig();
    if (!config.apiKey) {
      await ctx.reply("No API key configured. Run /setup first.");
      return;
    }
    await startWizard(ctx.chat.id, createNewAgentWizard(getConfig, getSystemPrompt), b);
  });

  b.command("agents", async (ctx) => {
    const config = getConfig();
    const entries = Object.entries(config.agents);
    if (entries.length === 0) {
      await ctx.reply("No agents configured.\n\nUse /newagent to create one.");
      return;
    }
    const runningBots = getActiveBotIds();
    const lines = ["Your agents:\n"];
    const kb = new InlineKeyboard();
    let hasButtons = false;

    for (const [id, a] of entries) {
      const running = runningBots.includes(id);
      const botState = activeBots.get(id);
      const username = botState?.botInfo?.username;
      const statusIcon = running ? "🟢" : a.telegram?.botToken ? "🔴" : "⚪";

      lines.push(`${statusIcon} ${a.name} (${id})`);
      lines.push(`   Model: ${a.model ?? config.model}`);

      if (running && username) {
        lines.push(`   @${username}`);
      } else if (a.telegram?.botToken && !running) {
        lines.push(`   Telegram: stopped`);
      } else if (!a.telegram?.botToken && !a.admin) {
        lines.push(`   No channel configured`);
      }
      lines.push("");

      // Add chat link button for running bots (except admin)
      if (running && username && !a.admin) {
        kb.url(`💬 ${a.name}`, `https://t.me/${username}`);
        hasButtons = true;
      }
    }

    // Management buttons
    if (hasButtons) kb.row();
    kb.text("➕ New agent", "agents:newagent");

    const stoppedAgents = entries.filter(([id, a]) => !runningBots.includes(id) && a.telegram?.botToken && !a.admin);
    if (stoppedAgents.length > 0) {
      kb.text("🔄 Restart stopped", "agents:restart");
    }

    await ctx.reply(lines.join("\n"), { reply_markup: kb });
  });

  b.callbackQuery("agents:newagent", async (ctx) => {
    await ctx.answerCallbackQuery();
    const config = getConfig();
    if (!config.apiKey) {
      await ctx.reply("No API key configured. Run /setup first.");
      return;
    }
    await startWizard(ctx.chat!.id, createNewAgentWizard(getConfig, getSystemPrompt), b);
  });

  b.callbackQuery("agents:restart", async (ctx) => {
    await ctx.answerCallbackQuery();
    const config = getConfig();
    const restarted: string[] = [];
    for (const [id, a] of Object.entries(config.agents)) {
      if (a.admin) continue;
      if (!a.telegram?.botToken) continue;
      if (getActiveBotIds().includes(id)) continue;
      try {
        const sysPrompt = getSystemPrompt();
        await startBot(id, a.telegram.botToken, getConfig, () => sysPrompt);
        restarted.push(id);
      } catch { /* skip */ }
    }
    await ctx.reply(restarted.length > 0
      ? `Restarted: ${restarted.join(", ")}`
      : "No stopped bots to restart.");
  });

  b.command("deleteagent", async (ctx) => {
    const config = getConfig();
    const deletable = Object.entries(config.agents).filter(([, a]) => !a.admin);
    if (deletable.length === 0) {
      await ctx.reply("No agents to delete.");
      return;
    }
    const kb = new InlineKeyboard();
    for (const [id, a] of deletable) {
      kb.text(`${a.name}`, `pickdelete:${id}`).row();
    }
    await ctx.reply("Which agent do you want to delete?", { reply_markup: kb });
  });

  b.command("soul", async (ctx) => {
    const args = (ctx.match ?? "").trim().split(/\s+/);
    const targetId = args[0];
    const action = args[1];

    if (!targetId) {
      const config = getConfig();
      const entries = Object.entries(config.agents);
      if (entries.length === 0) {
        await ctx.reply("No agents. Use /newagent first.");
        return;
      }
      const kb = new InlineKeyboard();
      for (const [id, a] of entries) {
        kb.text(`${a.name}`, `picksoul:view:${id}`).row();
      }
      await ctx.reply("Which agent's SOUL.md?", { reply_markup: kb });
      return;
    }

    const config = getConfig();
    if (!config.agents[targetId]) {
      await ctx.reply(`Agent "${targetId}" not found.`);
      return;
    }
    await showSoul(ctx.chat.id, targetId, action === "edit", b);
  });

  b.command("config", async (ctx) => {
    const args = (ctx.match ?? "").trim();

    if (!args) {
      const config = getConfig();
      const lines = [
        "Current configuration:\n",
        `Provider: ${config.provider}`,
        `Model: ${config.model}`,
        config.baseUrl ? `Base URL: ${config.baseUrl}` : null,
        `API Key: ${config.apiKey ? "***" + config.apiKey.slice(-4) : "not set"}`,
        `Thinking: ${config.thinking}`,
        `Effort: ${config.effort}`,
        `Max Turns: ${config.maxTurns}`,
        `Timeout: ${config.timeoutSeconds}s`,
        `Approvals: ${config.approvals.mode}`,
        "",
        "Use /config <key> <value> to change",
        "Examples:",
        "  /config model gpt-4o",
        "  /config thinking high",
        "  /config approvals.mode smart",
      ];
      await ctx.reply(lines.filter(Boolean).join("\n"));
      return;
    }

    const spaceIdx = args.indexOf(" ");
    if (spaceIdx === -1) {
      await ctx.reply(`Usage: /config <key> <value>\n\nExample: /config model gpt-4o`);
      return;
    }

    const key = args.slice(0, spaceIdx).trim();
    const value = args.slice(spaceIdx + 1).trim();
    const parts = key.split(".");
    let update: Record<string, unknown>;

    if (parts.length === 1) {
      let parsed: unknown = value;
      if (value === "true") parsed = true;
      else if (value === "false") parsed = false;
      else if (/^\d+$/.test(value)) parsed = parseInt(value, 10);
      update = { [key]: parsed };
    } else {
      const config = getConfig();
      const topKey = parts[0];
      const subKey = parts.slice(1).join(".");
      const existing = (config as Record<string, unknown>)[topKey];
      if (typeof existing === "object" && existing !== null) {
        let parsed: unknown = value;
        if (value === "true") parsed = true;
        else if (value === "false") parsed = false;
        else if (/^\d+$/.test(value)) parsed = parseInt(value, 10);
        update = { [topKey]: { ...(existing as Record<string, unknown>), [subKey]: parsed } };
      } else {
        await ctx.reply(`Unknown config section: ${topKey}`);
        return;
      }
    }

    try {
      saveConfig(update);
      await ctx.reply(`${key} = ${value}`);
    } catch (err) {
      await ctx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  b.command("sessions", async (ctx) => {
    const sessions = listSessions();
    if (sessions.length === 0) {
      await ctx.reply("No sessions.");
      return;
    }
    const recent = sessions.slice(0, 15);
    const lines = [`Sessions (${sessions.length} total):\n`];
    for (const s of recent) {
      const age = formatAge(s.createdAt);
      const msgs = loadMessages(s.id).length;
      const label = s.label ? ` (${s.label})` : "";
      lines.push(`${s.id}${label}`);
      lines.push(`  ${s.model} · ${msgs} msgs · ${age}`);
    }
    if (sessions.length > 15) {
      lines.push(`\n... and ${sessions.length - 15} more`);
    }
    const kb = new InlineKeyboard()
      .text("Clear > 1 day", "clearsessions:1d")
      .text("Clear > 1 week", "clearsessions:1w")
      .text("Clear > 1 month", "clearsessions:1m");
    await ctx.reply(lines.join("\n"), { reply_markup: kb });
  });

  b.command("status", async (ctx) => {
    const config = getConfig();
    const runningBots = getActiveBotIds();
    const sessions = listSessions();
    const lines = [
      "CamelAGI Status\n",
      `Provider: ${config.provider}`,
      `Model: ${config.model}`,
      `API Key: ${config.apiKey ? "set" : "not set"}`,
      "",
      `Bots: ${runningBots.length} running`,
    ];
    for (const id of runningBots) {
      lines.push(`  running: ${id}`);
    }
    const allIds = Object.keys(config.agents);
    const stoppedIds = allIds.filter((id) => !runningBots.includes(id));
    for (const id of stoppedIds) {
      lines.push(`  stopped: ${id}`);
    }
    lines.push("");
    lines.push(`Sessions: ${sessions.length}`);
    lines.push(`Approvals: ${config.approvals.mode}`);
    await ctx.reply(lines.join("\n"));
  });

  b.command("restart", async (ctx) => {
    const targetId = (ctx.match ?? "").trim();
    const config = getConfig();

    if (targetId) {
      if (!config.agents[targetId]) {
        await ctx.reply(`Agent "${targetId}" not found.`);
        return;
      }
      const token = config.agents[targetId].telegram?.botToken;
      if (!token) {
        await ctx.reply(`Agent "${targetId}" has no Telegram bot.`);
        return;
      }
      stopBot(targetId);
      try {
        const sysPrompt = getSystemPrompt();
        await startBot(targetId, token, getConfig, () => sysPrompt);
        await ctx.reply(`Restarted ${targetId}`);
      } catch (err) {
        await ctx.reply(`Error restarting: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    const restarted: string[] = [];
    for (const [id, a] of Object.entries(config.agents)) {
      if (a.admin) continue;
      if (!a.telegram?.botToken) continue;
      stopBot(id);
      try {
        const sysPrompt = getSystemPrompt();
        await startBot(id, a.telegram.botToken, getConfig, () => sysPrompt);
        restarted.push(id);
      } catch { /* skip */ }
    }
    await ctx.reply(restarted.length > 0
      ? `Restarted: ${restarted.join(", ")}`
      : "No bots to restart.");
  });

  b.command("pairing", async (ctx) => {
    const requests = listPendingRequests();
    if (requests.length === 0) {
      await ctx.reply("No pending access requests.");
      return;
    }

    for (const r of requests) {
      const userLabel = r.username ? `@${r.username}` : r.firstName ?? String(r.userId);
      const age = formatAge(r.requestedAt);
      const statusLabel = r.status === "otp_pending" ? `\nStatus: Waiting for OTP (${r.otp})` : "";
      const text = `Pending request\n\nUser: ${userLabel} (${r.userId})\nAgent: ${r.agentId}\nCode: ${r.code}\nRequested: ${age}${statusLabel}`;

      if (r.status === "pending") {
        const kb = new InlineKeyboard()
          .text("Approve", `pairing:approve:${r.code}`)
          .text("Deny", `pairing:deny:${r.code}`);
        await ctx.reply(text, { reply_markup: kb });
      } else {
        await ctx.reply(text);
      }
    }
  });

  // ─── Voice configuration ─────────────────────────────────────────

  b.command("voice", async (ctx) => {
    const config = getConfig();
    if (config.voice.enabled && config.voice.apiKey) {
      const masked = "***" + config.voice.apiKey.slice(-4);
      const kb = new InlineKeyboard()
        .text("Reconfigure", "voice:reconfigure")
        .text("Reset", "voice:reset");
      await ctx.reply([
        "Voice transcription: enabled\n",
        `Provider: ${config.voice.provider}`,
        `Model: ${config.voice.model ?? "default"}`,
        `API Key: ${masked}`,
        config.voice.language ? `Language: ${config.voice.language}` : null,
      ].filter(Boolean).join("\n"), { reply_markup: kb });
    } else {
      await startWizard(ctx.chat.id, createVoiceWizard(getConfig), b);
    }
  });

  b.callbackQuery(/^voice:(reconfigure|reset)$/, async (ctx) => {
    const action = ctx.callbackQuery.data.match(/^voice:(reconfigure|reset)$/)?.[1];
    await ctx.answerCallbackQuery();
    try { await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ""}\n\n-> ${action}`); } catch {}
    if (action === "reconfigure") {
      await startWizard(ctx.chat!.id, createVoiceWizard(getConfig), b);
    } else {
      await startWizard(ctx.chat!.id, createVoiceResetWizard(), b);
    }
  });

  // ─── Message handler: wizard intercept ─────────────────────────────

  b.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    if (hasActiveWizard(chatId)) {
      if (text === "/cancel") {
        cancelWizard(chatId);
        await ctx.reply("Wizard cancelled.");
        return;
      }
      const handled = await advanceWizard(chatId, text, b);
      if (handled) return;
    }
  });

  return b;
}
