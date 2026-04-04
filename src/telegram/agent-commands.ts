// Standard agent bot commands: help, clear, model, think, effort, etc.

import { InlineKeyboard, InputFile } from "grammy";
import { loadConfig, saveConfig, type Config } from "../core/config.js";
import { createClient } from "../model.js";
import { loadMessages, deleteSession, listSessions } from "../session.js";
import { getSessionUsage, formatUsageSummary, formatTokens } from "../usage.js";
import { CHARS_PER_TOKEN } from "../core/constants.js";
import { compactHistory } from "../runtime/compact.js";
import { submitDecision, type ApprovalDecision } from "../extensions/approvals.js";
import { listSkillNames } from "../extensions/skills.js";
import { startWizard } from "./wizard.js";
import { createMcpAddWizard } from "./wizards.js";
import { hasTerminal, getTerminalModel, setTerminalModel, getTerminalSetting, setTerminalSetting } from "./terminal.js";
import type { BotContext } from "./agent-context.js";
import { sid, getAgent } from "./agent-context.js";

export function registerCommands(ctx: BotContext): void {
  const { bot: b, runtimeModels, runtimeThinking, runtimeEffort, runtimeBriefMode } = ctx;

  b.command("start", async (gc) => {
    const agent = getAgent(ctx, gc.chat.id);
    if (gc.chat.type === "group" || gc.chat.type === "supergroup") {
      await gc.reply(`${agent.name} added. Mention me with @${ctx.botInfo.username} to chat.`);
    } else {
      await gc.reply(`${agent.name} is ready.\n\nModel: ${agent.model}\nSend me a message or type /help for commands.`);
    }
  });

  b.command("help", async (gc) => {
    const agent = getAgent(ctx, gc.chat.id);
    const lines = [
      `${agent.name} Commands:\n`,
      "/help — List commands and current config",
      "/clear — Clear this chat's history",
      "/status — Show model, message count, token usage",
      "/model <name> — Switch model for this chat",
      "/think <level> — Set thinking (off|low|medium|high)",
      "/effort <level> — Set effort (low|medium|high|max)",
      "/usage — Token usage for this session",
      "/brief — Toggle brief response mode",
      "/skills — List active skills",
      "/mcp — Manage MCP tool servers",
      "/export — Export session as markdown file",
      "/session — Show or switch session",
      "/compact — Force compaction of chat history",
      "",
      `Model: ${agent.model}`,
      `Thinking: ${agent.thinking}`,
      `Effort: ${agent.effort}`,
      `Max turns: ${agent.maxTurns}`,
      `Brief mode: ${agent.briefMode ? "on" : "off"}`,
    ];
    await gc.reply(lines.join("\n"));
  });

  b.command("clear", async (gc) => {
    deleteSession(sid(ctx, gc.chat.id));
    runtimeModels.delete(gc.chat.id);
    runtimeThinking.delete(gc.chat.id);
    runtimeEffort.delete(gc.chat.id);
    runtimeBriefMode.delete(gc.chat.id);
    await gc.reply("Session cleared.");
  });

  b.command("status", async (gc) => {
    const agent = getAgent(ctx, gc.chat.id);
    const sessionId = sid(ctx, gc.chat.id);
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
    if (runtimeModels.has(gc.chat.id)) lines.push(`(runtime override, resets on /clear or restart)`);
    await gc.reply(lines.join("\n"));
  });

  b.command("model", async (gc) => {
    if (hasTerminal(gc.chat.id)) {
      const arg = gc.match?.trim();
      if (arg) {
        setTerminalModel(gc.chat.id, arg);
        await gc.reply(`Model set to: ${arg}`);
      } else {
        const current = getTerminalModel(gc.chat.id) ?? "default";
        const kb = new InlineKeyboard()
          .text("Sonnet 4.6", "cc:setmodel:claude-sonnet-4-6").text("Opus 4.6", "cc:setmodel:claude-opus-4-6").row()
          .text("Haiku 4.5", "cc:setmodel:claude-haiku-4-5-20251001").row()
          .text("Default", "cc:setmodel:__default__");
        await gc.reply(`Claude Code model: ${current}`, { reply_markup: kb });
      }
      return;
    }
    const newModel = gc.match?.trim();
    if (!newModel) {
      const agent = getAgent(ctx, gc.chat.id);
      await gc.reply(`Current model: ${agent.model}\n\nUsage: /model <name>`);
      return;
    }
    runtimeModels.set(gc.chat.id, newModel);
    await gc.reply(`Model switched to: ${newModel}\n(runtime only, resets on /clear or restart)`);
  });

  b.command("think", async (gc) => {
    const levels = ["off", "low", "medium", "high"] as const;
    const arg = gc.match?.trim() as typeof levels[number];
    const agent = getAgent(ctx, gc.chat.id);
    if (!arg) {
      const kb = new InlineKeyboard();
      for (const l of levels) {
        kb.text(l === agent.thinking ? `✓ ${l}` : l, `think:${l}`);
      }
      await gc.reply(`Thinking: ${agent.thinking}`, { reply_markup: kb });
      return;
    }
    if (!levels.includes(arg)) {
      await gc.reply("Invalid level. Use: off, low, medium, high");
      return;
    }
    runtimeThinking.set(gc.chat.id, arg);
    await gc.reply(`Thinking set to: ${arg}`);
  });

  b.callbackQuery(/^think:(.+)$/, async (gc) => {
    const level = gc.callbackQuery.data.split(":")[1] as Config["thinking"];
    runtimeThinking.set(gc.chat!.id, level);
    try { await gc.editMessageText(`Thinking: ${level} ✓`); } catch {}
    await gc.answerCallbackQuery();
  });

  b.command("effort", async (gc) => {
    if (hasTerminal(gc.chat.id)) {
      const levels = ["low", "medium", "high", "max"];
      const arg = gc.match?.trim();
      if (arg && levels.includes(arg)) {
        setTerminalSetting(gc.chat.id, "effort", arg);
        await gc.reply(`Effort set to: ${arg}`);
      } else {
        const current = getTerminalSetting(gc.chat.id, "effort") ?? "default";
        const kb = new InlineKeyboard()
          .text("Low", "cc:effort:low").text("Medium", "cc:effort:medium").row()
          .text("High", "cc:effort:high").text("Max", "cc:effort:max");
        await gc.reply(`Effort: ${current}`, { reply_markup: kb });
      }
      return;
    }
    const levels = ["low", "medium", "high", "max"] as const;
    const arg = gc.match?.trim() as typeof levels[number];
    const agent = getAgent(ctx, gc.chat.id);
    if (!arg) {
      const kb = new InlineKeyboard();
      for (const l of levels) {
        kb.text(l === agent.effort ? `✓ ${l}` : l, `effort:${l}`);
      }
      await gc.reply(`Effort: ${agent.effort}`, { reply_markup: kb });
      return;
    }
    if (!levels.includes(arg)) {
      await gc.reply("Invalid level. Use: low, medium, high, max");
      return;
    }
    runtimeEffort.set(gc.chat.id, arg);
    await gc.reply(`Effort set to: ${arg}`);
  });

  b.callbackQuery(/^effort:(.+)$/, async (gc) => {
    const level = gc.callbackQuery.data.split(":")[1] as Config["effort"];
    runtimeEffort.set(gc.chat!.id, level);
    try { await gc.editMessageText(`Effort: ${level} ✓`); } catch {}
    await gc.answerCallbackQuery();
  });

  b.command("brief", async (gc) => {
    const agent = getAgent(ctx, gc.chat.id);
    const current = runtimeBriefMode.get(gc.chat.id) ?? agent.briefMode;
    const next = !current;
    runtimeBriefMode.set(gc.chat.id, next);
    await gc.reply(`Brief mode: ${next ? "on — short replies" : "off — detailed replies"}`);
  });

  b.command("usage", async (gc) => {
    const sessionId = sid(ctx, gc.chat.id);
    const usage = getSessionUsage(sessionId);
    const messages = loadMessages(sessionId);

    if (usage.calls === 0) {
      await gc.reply("No usage yet in this session.");
      return;
    }

    const total = usage.totalInput + usage.totalOutput;
    const lines = [
      `Token usage this session:\n`,
      `Total: ${formatTokens(total)} tokens`,
      `  Input:  ${formatTokens(usage.totalInput)}`,
      `  Output: ${formatTokens(usage.totalOutput)}`,
    ];
    if (usage.totalCacheRead > 0) lines.push(`  Cache read:  ${formatTokens(usage.totalCacheRead)}`);
    if (usage.totalCacheWrite > 0) lines.push(`  Cache write: ${formatTokens(usage.totalCacheWrite)}`);
    lines.push("", `API calls: ${usage.calls}`, `Messages: ${messages.length}`);
    await gc.reply(lines.join("\n"));
  });

  b.command("skills", async (gc) => {
    const skills = listSkillNames();
    if (skills.length === 0) {
      await gc.reply("No skills installed.\n\nAdd skills to ~/.camelagi/skills/");
    } else {
      await gc.reply(`Active skills: ${skills.join(", ")}`);
    }
  });

  b.command("export", async (gc) => {
    const sessionId = sid(ctx, gc.chat.id);
    const messages = loadMessages(sessionId);
    if (messages.length === 0) {
      await gc.reply("No messages to export.");
      return;
    }
    const md = messages.map(m =>
      m.role === "user" ? `## You\n\n${m.content}` : `## Assistant\n\n${m.content}`
    ).join("\n\n---\n\n");
    const buf = Buffer.from(md, "utf-8");
    await gc.replyWithDocument(new InputFile(buf, `${sessionId}.md`));
  });

  b.command("session", async (gc) => {
    const arg = (gc.match ?? "").trim();
    const sessionId = sid(ctx, gc.chat.id);
    if (!arg) {
      await gc.reply(`Current session: ${sessionId}`);
      return;
    }
    if (arg === "list") {
      const sessions = listSessions();
      if (sessions.length === 0) { await gc.reply("No sessions."); return; }
      const lines = sessions.slice(0, 20).map(s => {
        const msgs = loadMessages(s.id).length;
        return `${s.id} (${msgs} msgs)`;
      });
      await gc.reply(lines.join("\n"));
      return;
    }
    await gc.reply(`Session switching coming soon. Current: ${sessionId}`);
  });

  b.command("compact", async (gc) => {
    const config = ctx.getConfig();
    const agent = getAgent(ctx, gc.chat.id);
    const sessionId = sid(ctx, gc.chat.id);
    const history = loadMessages(sessionId);
    if (history.length === 0) { await gc.reply("No history to compact."); return; }

    const client = createClient(config);
    const result = await compactHistory(client, agent.model, history, { ...config.compaction, enabled: true, agentId: ctx.agentId === "telegram" ? undefined : ctx.agentId });
    if (result) {
      await gc.reply(`Compacted: ${history.length} -> ${result.length} messages`);
    } else {
      await gc.reply(`History is already compact (${history.length} messages).`);
    }
  });

  // ─── MCP commands ───────────────────────────────────────────────────

  b.command("mcp", async (gc) => {
    const kb = new InlineKeyboard()
      .text("➕ Add Server", "mcp:add")
      .text("📋 List", "mcp:list")
      .text("🗑 Remove", "mcp:remove");
    await gc.reply("MCP Servers", { reply_markup: kb });
  });

  b.callbackQuery("mcp:add", async (gc) => {
    await gc.answerCallbackQuery();
    await startWizard(gc.chat!.id, createMcpAddWizard(ctx.getConfig, ctx.agentId), b);
  });

  b.callbackQuery("mcp:list", async (gc) => {
    await gc.answerCallbackQuery();
    const config = ctx.getConfig();
    const isAgent = ctx.agentId && ctx.agentId !== "default" && config.agents[ctx.agentId];
    const scope = isAgent ? `agent "${config.agents[ctx.agentId].name}"` : "global";
    const servers = isAgent
      ? config.agents[ctx.agentId]?.mcp?.servers ?? {}
      : config.mcp.servers;

    const entries = Object.entries(servers);
    if (entries.length === 0) {
      await gc.reply(`No MCP servers (${scope}).`);
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
    await gc.reply(`MCP Servers (${scope}):\n\n${lines.join("\n\n")}`);
  });

  b.callbackQuery("mcp:remove", async (gc) => {
    await gc.answerCallbackQuery();
    const config = ctx.getConfig();
    const isAgent = ctx.agentId && ctx.agentId !== "default" && config.agents[ctx.agentId];
    const servers = isAgent
      ? config.agents[ctx.agentId]?.mcp?.servers ?? {}
      : config.mcp.servers;

    const names = Object.keys(servers);
    if (names.length === 0) {
      await gc.reply("No MCP servers to remove.");
      return;
    }
    const kb = new InlineKeyboard();
    for (const name of names) {
      kb.text(`✕ ${name}`, `mcp:rm:${name}`).row();
    }
    await gc.reply("Remove which server?", { reply_markup: kb });
  });

  b.callbackQuery(/^mcp:rm:/, async (gc) => {
    await gc.answerCallbackQuery();
    const name = gc.callbackQuery.data.replace("mcp:rm:", "");
    const config = ctx.getConfig();
    const isAgent = ctx.agentId && ctx.agentId !== "default" && config.agents[ctx.agentId];

    const servers = isAgent
      ? { ...(config.agents[ctx.agentId]?.mcp?.servers ?? {}) }
      : { ...config.mcp.servers };

    if (!(name in servers)) {
      await gc.reply(`Server "${name}" not found.`);
      return;
    }
    delete (servers as Record<string, unknown>)[name];

    if (isAgent) {
      const agents = { ...config.agents };
      agents[ctx.agentId] = { ...agents[ctx.agentId], mcp: { servers } } as typeof agents[string];
      saveConfig({ agents });
    } else {
      saveConfig({ mcp: { servers } });
    }
    await gc.reply(`Removed MCP server: ${name}`);
  });

  // ─── Admin redirects ────────────────────────────────────────────────

  const adminRedirect = async (gc: any) => {
    const config = ctx.getConfig();
    const adminEntry = Object.entries(config.agents).find(([, a]) => a.admin);
    const adminState = adminEntry ? ctx.activeBots.get(adminEntry[0]) : undefined;
    const adminUsername = adminState?.botInfo?.username;
    if (adminUsername) {
      await gc.reply(`This is an admin command. Use it in @${adminUsername}`);
    } else {
      await gc.reply("This command is only available in the admin bot.");
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

  // ─── Voice info ─────────────────────────────────────────────────────

  b.command("voice", async (gc) => {
    const config = ctx.getConfig();
    if (config.voice.enabled) {
      await gc.reply("Voice is enabled. Send a voice message and I'll transcribe it.");
    } else {
      const adminEntry = Object.entries(config.agents).find(([, a]) => a.admin);
      const adminState = adminEntry ? ctx.activeBots.get(adminEntry[0]) : undefined;
      const adminUsername = adminState?.botInfo?.username;
      const hint = adminUsername
        ? `Voice not configured. Set it up in @${adminUsername} with /voice`
        : "Voice transcription is not configured.";
      await gc.reply(hint);
    }
  });

  // ─── Approval callbacks ─────────────────────────────────────────────

  b.callbackQuery(/^approve:(.+):(.+)$/, async (gc) => {
    const match = gc.callbackQuery.data.match(/^approve:(.+):(.+)$/);
    if (!match) return;
    const [, approvalId, decision] = match;
    const resolved = submitDecision(approvalId, decision as ApprovalDecision);
    if (resolved) {
      const label = decision === "allow-once" ? "Allowed" : decision === "allow-always" ? "Always allowed" : "Denied";
      await gc.editMessageText(`${gc.callbackQuery.message?.text ?? ""}\n\n-> ${label}`);
    }
    await gc.answerCallbackQuery();
  });
}
