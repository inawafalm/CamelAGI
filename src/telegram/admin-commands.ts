// Admin bot commands: setup, config, sessions, status, restart, pairing, voice, MCP, usage

import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import { saveConfig, type Config } from "../core/config.js";
import { listSessions, deleteSession, loadMessages } from "../session.js";
import { getActiveBotIds, startBot, stopBot } from "../telegram.js";
import type { BotState } from "./types.js";
import { startWizard, cancelWizard } from "./wizard.js";
import { createSetupWizard, createNewAgentWizard, createMcpAddWizard } from "./wizards.js";
import { createVoiceWizard, createVoiceResetWizard } from "./voice-wizard.js";
import { formatAge } from "./helpers.js";
import { listPendingRequests } from "../extensions/pairing.js";
import { aggregateAgentUsage, formatTokens, formatCost } from "../usage.js";
import { resolvePreset } from "../core/models.js";

export function registerAdminCommands(
  b: Bot,
  agentId: string,
  getConfig: () => Config,
  getSystemPrompt: () => string,
  activeBots: Map<string, BotState>,
): void {

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

  // ─── Config ───────────────────────────────────────────────────────

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

  // ─── MCP ──────────────────────────────────────────────────────────

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

  // ─── Sessions ─────────────────────────────────────────────────────

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

  // ─── Status ───────────────────────────────────────────────────────

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
    for (const id of runningBots) lines.push(`  running: ${id}`);
    const allIds = Object.keys(config.agents);
    const stoppedIds = allIds.filter((id) => !runningBots.includes(id));
    for (const id of stoppedIds) lines.push(`  stopped: ${id}`);
    lines.push("", `Sessions: ${sessions.length}`, `Approvals: ${config.approvals.mode}`);
    await ctx.reply(lines.join("\n"));
  });

  // ─── Restart ──────────────────────────────────────────────────────

  b.command("restart", async (ctx) => {
    const targetId = (ctx.match ?? "").trim();
    const config = getConfig();

    if (targetId) {
      if (!config.agents[targetId]) { await ctx.reply(`Agent "${targetId}" not found.`); return; }
      const token = config.agents[targetId].telegram?.botToken;
      if (!token) { await ctx.reply(`Agent "${targetId}" has no Telegram bot.`); return; }
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
      if (a.admin || !a.telegram?.botToken) continue;
      stopBot(id);
      try {
        const sysPrompt = getSystemPrompt();
        await startBot(id, a.telegram.botToken, getConfig, () => sysPrompt);
        restarted.push(id);
      } catch { /* skip */ }
    }
    await ctx.reply(restarted.length > 0 ? `Restarted: ${restarted.join(", ")}` : "No bots to restart.");
  });

  // ─── Pairing ──────────────────────────────────────────────────────

  b.command("pairing", async (ctx) => {
    const requests = listPendingRequests();
    if (requests.length === 0) { await ctx.reply("No pending access requests."); return; }
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

  // ─── Voice ────────────────────────────────────────────────────────

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

  // ─── Usage ────────────────────────────────────────────────────────

  b.command("usage", async (ctx) => {
    const config = getConfig();
    const entries = Object.entries(config.agents).filter(([, a]) => !a.admin);
    if (entries.length === 0) { await ctx.reply("No agents configured."); return; }

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

    if (!hasData) { await ctx.reply("No usage data yet."); return; }
    if (totalCost > 0) lines.push(`Total estimated cost: ~${formatCost(totalCost)}`);
    await ctx.reply(lines.join("\n"));
  });
}
