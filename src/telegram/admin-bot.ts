// Admin bot: BotFather-style Telegram control plane for CamelAGI

import { Bot, InlineKeyboard } from "grammy";
import fs from "node:fs";
import path from "node:path";
import { saveConfig, loadConfig, type Config } from "../core/config.js";
import { agentMemoryDir } from "../workspace.js";
import { listSessions, deleteSession, loadMessages } from "../session.js";
import { getSessionUsage, formatUsageSummary, formatTokens, aggregateAgentUsage, formatCost } from "../usage.js";
import { CHARS_PER_TOKEN } from "../core/constants.js";
import { getActiveBotIds, startBot, stopBot } from "../telegram.js";
import type { BotState } from "./types.js";
import { startWizard, advanceWizard, cancelWizard, hasActiveWizard } from "./wizard.js";
import { createSetupWizard, createNewAgentWizard, createMcpAddWizard, createCloneWizard } from "./wizards.js";
import { resolvePreset } from "../core/models.js";
import { createVoiceWizard, createVoiceResetWizard } from "./voice-wizard.js";
import type { WizardDef } from "./wizard.js";
import { formatAge } from "./helpers.js";
import { approveRequest, denyRequest, listPendingRequests, hasPendingRequest, createPairingRequest } from "../extensions/pairing.js";
import { notifyUserApproved, notifyUserOfDenial } from "./pairing-notify.js";
import { isGroupChat } from "./helpers.js";
import {
  listPendingBotApprovals,
  approveBotApproval,
  denyBotApproval,
  type BotApproval,
} from "../extensions/bot-approval.js";

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

async function showAgentConfig(chatId: number, agentId: string, config: import("../core/config.js").Config, bot: import("grammy").Bot): Promise<void> {
  const agent = config.agents[agentId];
  if (!agent) return;

  const model = agent.model ?? config.model;
  const thinking = agent.thinking ?? config.thinking;
  const effort = agent.effort ?? config.effort;
  const maxTurns = agent.maxTurns ?? config.maxTurns;
  const mcpCount = agent.mcp ? Object.keys(agent.mcp.servers).length : 0;
  const runningBots = getActiveBotIds();
  const running = runningBots.includes(agentId);
  const statusIcon = running ? "🟢" : agent.telegram?.botToken ? "🔴" : "⚪";

  const briefMode = agent.telegram?.briefMode ?? true;

  const lines = [
    `${statusIcon} ${agent.name} (${agentId})\n`,
    `Model: ${model}`,
    `Thinking: ${thinking}`,
    `Effort: ${effort}`,
    `Max Turns: ${maxTurns}`,
    `Brief: ${briefMode ? "on" : "off"}`,
    mcpCount > 0 ? `MCP: ${mcpCount} server${mcpCount > 1 ? "s" : ""}` : `MCP: none`,
  ];

  const kb = new InlineKeyboard()
    .text("Model", `ae:model:${agentId}`)
    .text("Thinking", `ae:think:${agentId}`)
    .text("Effort", `ae:effort:${agentId}`)
    .row()
    .text("Max Turns", `ae:turns:${agentId}`)
    .text(`Brief: ${briefMode ? "on" : "off"}`, `ae:brief:${agentId}`)
    .text("Clone", `ae:clone:${agentId}`);

  await bot.api.sendMessage(chatId, lines.join("\n"), { reply_markup: kb });
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

  /** Check if userId is allowed for this agent */
  function isUserAllowed(userId: number): boolean {
    const memAgent = getConfig().agents[agentId];
    const memAllowed = memAgent?.telegram?.allowedUsers ?? [];
    if (memAllowed.includes(userId)) return true;
    // Fallback: read config file directly (handles hot-reload delay)
    try {
      const freshConfig = loadConfig();
      const freshAgent = freshConfig.agents[agentId];
      const freshAllowed = freshAgent?.telegram?.allowedUsers ?? [];
      if (freshAllowed.includes(userId)) return true;
    } catch {}
    return false;
  }

  // Access control — admin approves, user gets instant access
  b.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (isUserAllowed(userId)) { await next(); return; }

    // Groups: silent reject for unauthorized users
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
    const who = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name ?? String(userId);
    console.log(`\n  \x1b[33mPairing request from ${who}\x1b[0m\n  \x1b[90mRun: camel pairing\x1b[0m\n`);
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
            `${ctx.callbackQuery.message?.text ?? ""}\n\n-> Approved`,
          );
        } catch {}
        await notifyUserApproved(request, activeBots);
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
      "  /agent <id> — view/edit agent config",
      "  /deleteagent — pick & delete an agent",
      "  /soul — view/edit agent personality",
      "",
      "MCP:",
      "  /mcp — manage MCP tool servers",
      "",
      "Access:",
      "  /pairing — list pending access requests",
      "",
      "Sessions & Status:",
      "  /sessions — list sessions",
      "  /usage — per-agent usage & costs",
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

    lines.push("Use /agent <id> to view/edit config");

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

  // ─── MCP Management ──────────────────────────────────────────────────

  b.command("mcp", async (ctx) => {
    const kb = new InlineKeyboard()
      .text("➕ Add Server", "mcp:add")
      .text("📋 List", "mcp:list")
      .text("🗑 Remove", "mcp:remove");
    await ctx.reply("MCP Servers", { reply_markup: kb });
  });

  b.callbackQuery("mcp:add", async (ctx) => {
    await ctx.answerCallbackQuery();
    await startWizard(ctx.chat!.id, createMcpAddWizard(getConfig), b);
  });

  b.callbackQuery("mcp:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    const config = getConfig();
    const entries = Object.entries(config.mcp.servers);
    if (entries.length === 0) {
      await ctx.reply("No MCP servers configured.\n\nUse /mcp → Add to add one.");
      return;
    }
    const lines = entries.map(([name, s]) => {
      const cfg = s as Record<string, unknown>;
      if (cfg.type === "stdio") {
        const args = Array.isArray(cfg.args) ? (cfg.args as string[]).join(" ") : "";
        return `⚙️ ${name} (stdio)\n   ${cfg.command} ${args}`.trimEnd();
      }
      return `${cfg.type === "sse" ? "📡" : "🌐"} ${name} (${cfg.type})\n   ${cfg.url}`;
    });
    await ctx.reply(`MCP Servers:\n\n${lines.join("\n\n")}`);
  });

  b.callbackQuery("mcp:remove", async (ctx) => {
    await ctx.answerCallbackQuery();
    const config = getConfig();
    const names = Object.keys(config.mcp.servers);
    if (names.length === 0) {
      await ctx.reply("No MCP servers to remove.");
      return;
    }
    const kb = new InlineKeyboard();
    for (const name of names) {
      kb.text(`✕ ${name}`, `mcp:rm:${name}`).row();
    }
    await ctx.reply("Remove which server?", { reply_markup: kb });
  });

  b.callbackQuery(/^mcp:rm:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const name = ctx.callbackQuery.data.replace("mcp:rm:", "");
    const config = getConfig();
    const servers = { ...config.mcp.servers };
    if (!(name in servers)) {
      await ctx.reply(`Server "${name}" not found.`);
      return;
    }
    delete (servers as Record<string, unknown>)[name];
    saveConfig({ mcp: { servers } });
    await ctx.reply(`Removed MCP server: ${name}`);
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
      const text = `Pending request\n\nUser: ${userLabel} (${r.userId})\nAgent: ${r.agentId}\nCode: ${r.code}\nRequested: ${age}`;

      const kb = new InlineKeyboard()
        .text("Approve", `pairing:approve:${r.code}`)
        .text("Deny", `pairing:deny:${r.code}`);
      await ctx.reply(text, { reply_markup: kb });
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

  // ─── Agent config editing ───────────────────────────────────────────

  b.command("agent", async (ctx) => {
    const targetId = (ctx.match ?? "").trim();
    const config = getConfig();

    if (!targetId) {
      const entries = Object.entries(config.agents);
      if (entries.length === 0) {
        await ctx.reply("No agents. Use /newagent first.");
        return;
      }
      const kb = new InlineKeyboard();
      for (const [id, a] of entries) {
        kb.text(a.name, `ae:show:${id}`).row();
      }
      await ctx.reply("Which agent to view/edit?", { reply_markup: kb });
      return;
    }

    if (!config.agents[targetId]) {
      await ctx.reply(`Agent "${targetId}" not found.`);
      return;
    }

    await showAgentConfig(ctx.chat.id, targetId, config, b);
  });

  b.callbackQuery(/^ae:show:(.+)$/, async (ctx) => {
    const agentIdParam = ctx.callbackQuery.data.match(/^ae:show:(.+)$/)?.[1];
    if (!agentIdParam) return;
    await ctx.answerCallbackQuery();
    const config = getConfig();
    await showAgentConfig(ctx.chat!.id, agentIdParam, config, b);
  });

  b.callbackQuery(/^ae:think:(.+)$/, async (ctx) => {
    const agentIdParam = ctx.callbackQuery.data.match(/^ae:think:(.+)$/)?.[1];
    if (!agentIdParam) return;
    await ctx.answerCallbackQuery();
    const config = getConfig();
    const current = config.agents[agentIdParam]?.thinking ?? config.thinking;
    const levels = ["off", "low", "medium", "high"];
    const kb = new InlineKeyboard();
    for (const l of levels) {
      kb.text(l === current ? `✓ ${l}` : l, `as:${agentIdParam}:think:${l}`);
    }
    await ctx.reply(`Set thinking for ${agentIdParam}:`, { reply_markup: kb });
  });

  b.callbackQuery(/^ae:effort:(.+)$/, async (ctx) => {
    const agentIdParam = ctx.callbackQuery.data.match(/^ae:effort:(.+)$/)?.[1];
    if (!agentIdParam) return;
    await ctx.answerCallbackQuery();
    const config = getConfig();
    const current = config.agents[agentIdParam]?.effort ?? config.effort;
    const levels = ["low", "medium", "high", "max"];
    const kb = new InlineKeyboard();
    for (const l of levels) {
      kb.text(l === current ? `✓ ${l}` : l, `as:${agentIdParam}:effort:${l}`);
    }
    await ctx.reply(`Set effort for ${agentIdParam}:`, { reply_markup: kb });
  });

  b.callbackQuery(/^ae:turns:(.+)$/, async (ctx) => {
    const agentIdParam = ctx.callbackQuery.data.match(/^ae:turns:(.+)$/)?.[1];
    if (!agentIdParam) return;
    await ctx.answerCallbackQuery();
    const config = getConfig();
    const current = config.agents[agentIdParam]?.maxTurns ?? config.maxTurns;
    const options = [10, 25, 50, 100];
    const kb = new InlineKeyboard();
    for (const n of options) {
      kb.text(n === current ? `✓ ${n}` : String(n), `as:${agentIdParam}:turns:${n}`);
    }
    await ctx.reply(`Set max turns for ${agentIdParam}:`, { reply_markup: kb });
  });

  b.callbackQuery(/^ae:model:(.+)$/, async (ctx) => {
    const agentIdParam = ctx.callbackQuery.data.match(/^ae:model:(.+)$/)?.[1];
    if (!agentIdParam) return;
    await ctx.answerCallbackQuery();
    const config = getConfig();
    const current = config.agents[agentIdParam]?.model ?? config.model;
    const preset = resolvePreset(config.provider, config.baseUrl);
    const models = preset.models.slice(0, 6);
    const kb = new InlineKeyboard();
    for (const m of models) {
      const slash = m.indexOf("/");
      const label = slash > 0 ? m.slice(slash + 1) : m;
      const check = m === current ? "✓ " : "";
      kb.text(`${check}${label}`, `as:${agentIdParam}:model:${m}`).row();
    }
    kb.text("✏️ Type custom", `ae:modelcustom:${agentIdParam}`);
    await ctx.reply(`Set model for ${agentIdParam}:`, { reply_markup: kb });
  });

  b.callbackQuery(/^ae:modelcustom:(.+)$/, async (ctx) => {
    const agentIdParam = ctx.callbackQuery.data.match(/^ae:modelcustom:(.+)$/)?.[1];
    if (!agentIdParam) return;
    await ctx.answerCallbackQuery();
    await startWizard(ctx.chat!.id, {
      id: "agent-model-edit",
      steps: [{
        id: "model",
        prompt: `Type the model name for "${agentIdParam}":`,
      }],
      onComplete: async (data) => {
        const cfg = getConfig();
        const agents = { ...cfg.agents };
        agents[agentIdParam] = { ...agents[agentIdParam], model: data.model };
        saveConfig({ agents });
        return `Model set to: ${data.model}`;
      },
    }, b);
  });

  b.callbackQuery(/^ae:brief:(.+)$/, async (ctx) => {
    const agentIdParam = ctx.callbackQuery.data.match(/^ae:brief:(.+)$/)?.[1];
    if (!agentIdParam) return;
    await ctx.answerCallbackQuery();

    const config = getConfig();
    const agent = config.agents[agentIdParam];
    if (!agent?.telegram) {
      await ctx.reply("Agent has no Telegram config.");
      return;
    }

    const current = agent.telegram.briefMode ?? true;
    const next = !current;
    const agents = { ...config.agents };
    agents[agentIdParam] = {
      ...agents[agentIdParam],
      telegram: { ...agents[agentIdParam].telegram!, briefMode: next },
    } as typeof agents[string];
    saveConfig({ agents });

    try {
      await ctx.editMessageText(`Brief mode: ${next ? "on" : "off"} ✓`);
    } catch {
      await ctx.reply(`Brief mode: ${next ? "on" : "off"} ✓`);
    }
  });

  b.callbackQuery(/^ae:mcp:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Use /mcp to manage MCP servers.");
  });

  b.callbackQuery(/^ae:clone:(.+)$/, async (ctx) => {
    const agentIdParam = ctx.callbackQuery.data.match(/^ae:clone:(.+)$/)?.[1];
    if (!agentIdParam) return;
    await ctx.answerCallbackQuery();
    await startWizard(ctx.chat!.id, createCloneWizard(agentIdParam, getConfig, getSystemPrompt), b);
  });

  b.callbackQuery(/^as:(.+?):(.+?):(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^as:(.+?):(.+?):(.+)$/);
    if (!match) return;
    const [, agentIdParam, field, value] = match;
    await ctx.answerCallbackQuery();

    const config = getConfig();
    if (!config.agents[agentIdParam]) {
      await ctx.reply("Agent not found.");
      return;
    }

    const agents = { ...config.agents };
    const agent = { ...agents[agentIdParam] };

    const fieldLabels: Record<string, string> = {
      think: "Thinking", effort: "Effort", turns: "Max Turns", model: "Model",
    };

    if (field === "think") {
      (agent as Record<string, unknown>).thinking = value;
    } else if (field === "effort") {
      (agent as Record<string, unknown>).effort = value;
    } else if (field === "turns") {
      (agent as Record<string, unknown>).maxTurns = parseInt(value, 10);
    } else if (field === "model") {
      (agent as Record<string, unknown>).model = value;
    }

    agents[agentIdParam] = agent;
    saveConfig({ agents });

    const label = fieldLabels[field] ?? field;
    try {
      await ctx.editMessageText(`${label} set to: ${value} ✓`);
    } catch {
      await ctx.reply(`${label} set to: ${value} ✓`);
    }
  });

  // ─── Usage & cost summary ────────────────────────────────────────

  b.command("usage", async (ctx) => {
    const config = getConfig();
    const entries = Object.entries(config.agents).filter(([, a]) => !a.admin);
    if (entries.length === 0) {
      await ctx.reply("No agents configured.");
      return;
    }

    const lines = ["Usage Summary\n"];
    let totalCost = 0;
    let hasData = false;

    for (const [id, a] of entries) {
      const model = a.model ?? config.model;
      const summary = aggregateAgentUsage(id, a.name, model);
      const total = summary.totalInput + summary.totalOutput;
      if (total === 0 && summary.calls === 0) continue;
      hasData = true;

      lines.push(`${a.name} (${model})`);
      lines.push(`  ${formatTokens(summary.totalInput)} in | ${formatTokens(summary.totalOutput)} out | ${summary.calls} calls`);
      if (summary.estimatedCost !== undefined) {
        lines.push(`  Cost: ~${formatCost(summary.estimatedCost)}`);
        totalCost += summary.estimatedCost;
      }
      lines.push("");
    }

    if (!hasData) {
      await ctx.reply("No usage data yet.");
      return;
    }

    if (totalCost > 0) {
      lines.push(`Total estimated cost: ~${formatCost(totalCost)}`);
    }

    await ctx.reply(lines.join("\n"));
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
