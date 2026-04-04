// Agent bot: per-agent Telegram bot with commands and message handling

import { Bot, InlineKeyboard, InputFile } from "grammy";
import { loadConfig, saveConfig, type Config } from "../core/config.js";
import { startWizard, advanceWizard, hasActiveWizard } from "./wizard.js";
import { createMcpAddWizard } from "./wizards.js";
import { createClient } from "../model.js";
import type { AgentEvent } from "../agent.js";
import { loadMessages, deleteSession, listSessions } from "../session.js";
import { isRunActive } from "../runtime/runs.js";
import { queueOrProcess } from "../runtime/queue.js";
import { compactHistory } from "../runtime/compact.js";
import { orchestrate } from "../runtime/orchestrate.js";
import { getSessionUsage, formatUsageSummary, formatTokens } from "../usage.js";
import { CHARS_PER_TOKEN } from "../core/constants.js";
import { submitDecision, type ApprovalDecision } from "../extensions/approvals.js";
import { registerForwardBot } from "../extensions/approval-forward.js";
import type { BotState } from "./types.js";
import { resolveAgent } from "./resolve.js";
import { createDraftStream } from "./draft-stream.js";
import { isGroupChat, shouldRespondInGroup, stripMention, sendChunked, startPolling } from "./helpers.js";
import { hasPendingRequest, createPairingRequest } from "../extensions/pairing.js";
import { notifyAdminOfPairing } from "./pairing-notify.js";
import { listSkillNames } from "../extensions/skills.js";
import { classifyError } from "../runtime/retry.js";
import { log as slog } from "../core/log.js";
import { transcribe } from "./transcribe.js";
import { detectClaudeCode, startTerminal, endTerminal, hasTerminal, isTerminalBusy, handleTerminalMessage, expandHome, updateWorkDir, getTerminalSessionId, getTerminalWorkDir, getTerminalModel, setTerminalModel, getTerminalSetting, setTerminalSetting, setPinnedMessageId, getPinnedMessageId, listClaudeSessions } from "./terminal.js";
import { startBrowse, handleBrowseCallback } from "./dir-browser.js";
import os from "node:os";

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
    runtimeBriefMode: new Map(),
  };
  activeBots.set(agentId, state);

  // Register first bot for approval forwarding (headless -> Telegram)
  if (activeBots.size === 1) {
    registerForwardBot(b);
  }

  const { botInfo, runtimeModels, runtimeThinking, runtimeEffort, runtimeBriefMode } = state;

  // Error alert throttling — max 1 per agent per 5 minutes
  const errorAlertTimes = new Map<string, number>();
  const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

  async function alertAdmin(message: string): Promise<void> {
    const lastAlert = errorAlertTimes.get(agentId) ?? 0;
    if (Date.now() - lastAlert < ALERT_COOLDOWN_MS) return;
    errorAlertTimes.set(agentId, Date.now());

    const config = getConfig();
    const adminEntry = Object.entries(config.agents).find(([, a]) => a.admin);
    if (!adminEntry) return;
    const [adminId] = adminEntry;
    const adminState = activeBots.get(adminId);
    if (!adminState) return;

    const adminUsers = adminEntry[1].telegram?.allowedUsers ?? [];
    for (const userId of adminUsers) {
      try {
        await adminState.bot.api.sendMessage(userId, message);
      } catch { /* best effort */ }
    }
  }

  const sid = (chatId: number) =>
    agentId === "telegram" ? `telegram-${chatId}` : `${agentId}-${chatId}`;

  const getAgent = (chatId: number) =>
    resolveAgent(agentId, getConfig(), getSystemPrompt(), {
      model: runtimeModels.get(chatId),
      thinking: runtimeThinking.get(chatId),
      effort: runtimeEffort.get(chatId),
      briefMode: runtimeBriefMode.get(chatId),
    });

  // ─── Command menus (swap between normal and Claude Code mode) ─────

  const NORMAL_COMMANDS = [
    { command: "help", description: "List commands and current config" },
    { command: "clear", description: "Clear this chat's history" },
    { command: "status", description: "Show model, message count, token usage" },
    { command: "model", description: "Switch model for this chat" },
    { command: "think", description: "Set thinking level" },
    { command: "effort", description: "Set effort level" },
    { command: "usage", description: "Token usage for this session" },
    { command: "skills", description: "List active skills" },
    { command: "export", description: "Export session as markdown file" },
    { command: "session", description: "Show or switch session" },
    { command: "mcp", description: "Manage MCP tool servers" },
    { command: "brief", description: "Toggle brief response mode" },
    { command: "compact", description: "Force compaction of chat history" },
    { command: "voice", description: "Voice transcription info" },
    { command: "claudecode", description: "Claude Code — start, stop, sessions" },
  ];

  const CLAUDECODE_COMMANDS = [
    // Core
    { command: "claudecode", description: "Menu — sessions, model, settings" },
    { command: "exit", description: "Exit Claude Code mode" },
    { command: "model", description: "Switch model (sonnet, opus, haiku)" },
    { command: "workdir", description: "Change working directory" },
    // Code actions
    { command: "review", description: "Review code changes" },
    { command: "fix", description: "Find and fix bugs" },
    { command: "test", description: "Write or run tests" },
    { command: "commit", description: "Commit changes" },
    { command: "pr", description: "Write PR description" },
    { command: "refactor", description: "Suggest refactoring" },
    { command: "security", description: "Security review" },
    { command: "explain", description: "Explain the codebase" },
    { command: "init", description: "Create CLAUDE.md" },
    { command: "doc", description: "Generate documentation" },
    // Settings
    { command: "effort", description: "Effort level (low/medium/high/max)" },
    { command: "tools", description: "Allow/deny tools" },
    { command: "approvals", description: "Approval mode (skip/acceptEdits)" },
    { command: "prompt", description: "Custom system prompt" },
    { command: "budget", description: "Max budget in USD" },
    { command: "adddir", description: "Add extra directory" },
    { command: "worktree", description: "Git worktree isolation" },
    { command: "cost", description: "Session cost" },
  ];

  async function setCommandMenu(ccMode: boolean, chatId?: number) {
    const commands = ccMode ? CLAUDECODE_COMMANDS : NORMAL_COMMANDS;
    if (chatId) {
      // Per-chat menu
      await b.api.setMyCommands(commands, { scope: { type: "chat", chat_id: chatId } }).catch(() => {});
    } else {
      // Global default
      await b.api.setMyCommands(commands).catch(() => {});
    }
  }

  // Set global default commands
  await setCommandMenu(false);

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
    const who = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name ?? String(userId);
    console.log(`\n  \x1b[33mPairing request from ${who} for agent "${agentId}"\x1b[0m\n  \x1b[90mRun: camel pairing\x1b[0m\n`);
    await ctx.reply(
      `Access requested. Waiting for admin approval.\nCode: ${request.code}`,
    );

    notifyAdminOfPairing(request, getConfig(), activeBots);
  });

  // ─── Command mode guard ──────────────────────────────────────────
  // Normal commands blocked in Claude Code mode, Claude Code commands blocked in normal mode

  const CC_ONLY_COMMANDS = new Set([
    "exit", "review", "fix", "test", "refactor", "security",
    "pr", "commit", "init", "explain", "doc", "cost",
    "prompt", "budget", "adddir", "tools", "worktree", "approvals",
  ]);
  const SHARED_COMMANDS = new Set([
    "claudecode", "start", "model", "effort", "workdir", "help",
  ]);

  b.on("message", async (ctx, next) => {
    const text = ctx.message?.text;
    if (!text?.startsWith("/")) { await next(); return; }
    const cmd = text.split(/[\s@]/)[0].slice(1).toLowerCase();
    if (SHARED_COMMANDS.has(cmd)) { await next(); return; }

    const inCC = hasTerminal(ctx.chat.id);
    if (inCC && !CC_ONLY_COMMANDS.has(cmd)) {
      await ctx.reply("Exit Claude Code first (/exit), then use this command.");
      return;
    }
    if (!inCC && CC_ONLY_COMMANDS.has(cmd)) {
      await ctx.reply("Start Claude Code first (/claudecode).");
      return;
    }
    await next();
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
    await ctx.reply(lines.join("\n"));
  });

  b.command("clear", async (ctx) => {
    deleteSession(sid(ctx.chat.id));
    runtimeModels.delete(ctx.chat.id);
    runtimeThinking.delete(ctx.chat.id);
    runtimeEffort.delete(ctx.chat.id);
    runtimeBriefMode.delete(ctx.chat.id);
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
    // Claude Code mode: only Claude models (sonnet, opus, haiku)
    if (hasTerminal(ctx.chat.id)) {
      const arg = ctx.match?.trim();
      if (arg) {
        setTerminalModel(ctx.chat.id, arg);
        await ctx.reply(`Model set to: ${arg}`);
      } else {
        const current = getTerminalModel(ctx.chat.id) ?? "default";
        const kb = new InlineKeyboard()
          .text("Sonnet 4.6", "cc:setmodel:claude-sonnet-4-6").text("Opus 4.6", "cc:setmodel:claude-opus-4-6").row()
          .text("Haiku 4.5", "cc:setmodel:claude-haiku-4-5-20251001").row()
          .text("Default", "cc:setmodel:__default__");
        await ctx.reply(`Claude Code model: ${current}`, { reply_markup: kb });
      }
      return;
    }
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
    // Claude Code mode: set effort for claude subprocess
    if (hasTerminal(ctx.chat.id)) {
      const levels = ["low", "medium", "high", "max"];
      const arg = ctx.match?.trim();
      if (arg && levels.includes(arg)) {
        setTerminalSetting(ctx.chat.id, "effort", arg);
        await ctx.reply(`Effort set to: ${arg}`);
      } else {
        const current = getTerminalSetting(ctx.chat.id, "effort") ?? "default";
        const kb = new InlineKeyboard()
          .text("Low", "cc:effort:low").text("Medium", "cc:effort:medium").row()
          .text("High", "cc:effort:high").text("Max", "cc:effort:max");
        await ctx.reply(`Effort: ${current}`, { reply_markup: kb });
      }
      return;
    }
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

  b.command("brief", async (ctx) => {
    const agent = getAgent(ctx.chat.id);
    const current = runtimeBriefMode.get(ctx.chat.id) ?? agent.briefMode;
    const next = !current;
    runtimeBriefMode.set(ctx.chat.id, next);
    await ctx.reply(`Brief mode: ${next ? "on — short replies" : "off — detailed replies"}`);
  });

  b.command("usage", async (ctx) => {
    const sessionId = sid(ctx.chat.id);
    const usage = getSessionUsage(sessionId);
    const messages = loadMessages(sessionId);

    if (usage.calls === 0) {
      await ctx.reply("No usage yet in this session.");
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
    await ctx.reply(lines.join("\n"));
  });

  b.command("skills", async (ctx) => {
    const skills = listSkillNames();
    if (skills.length === 0) {
      await ctx.reply("No skills installed.\n\nAdd skills to ~/.camelagi/skills/");
    } else {
      await ctx.reply(`Active skills: ${skills.join(", ")}`);
    }
  });

  b.command("export", async (ctx) => {
    const sessionId = sid(ctx.chat.id);
    const messages = loadMessages(sessionId);
    if (messages.length === 0) {
      await ctx.reply("No messages to export.");
      return;
    }
    const md = messages.map(m =>
      m.role === "user" ? `## You\n\n${m.content}` : `## Assistant\n\n${m.content}`
    ).join("\n\n---\n\n");
    const buf = Buffer.from(md, "utf-8");
    await ctx.replyWithDocument(new InputFile(buf, `${sessionId}.md`));
  });

  b.command("session", async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    const sessionId = sid(ctx.chat.id);
    if (!arg) {
      await ctx.reply(`Current session: ${sessionId}`);
      return;
    }
    if (arg === "list") {
      const sessions = listSessions();
      if (sessions.length === 0) { await ctx.reply("No sessions."); return; }
      const lines = sessions.slice(0, 20).map(s => {
        const msgs = loadMessages(s.id).length;
        return `${s.id} (${msgs} msgs)`;
      });
      await ctx.reply(lines.join("\n"));
      return;
    }
    // TODO: session switching for Telegram requires runtime state
    await ctx.reply(`Session switching coming soon. Current: ${sessionId}`);
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

  b.command("mcp", async (ctx) => {
    const kb = new InlineKeyboard()
      .text("➕ Add Server", "mcp:add")
      .text("📋 List", "mcp:list")
      .text("🗑 Remove", "mcp:remove");
    await ctx.reply("MCP Servers", { reply_markup: kb });
  });

  b.callbackQuery("mcp:add", async (ctx) => {
    await ctx.answerCallbackQuery();
    await startWizard(ctx.chat!.id, createMcpAddWizard(getConfig, agentId), b);
  });

  b.callbackQuery("mcp:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    const config = getConfig();
    const isAgent = agentId && agentId !== "default" && config.agents[agentId];
    const scope = isAgent ? `agent "${config.agents[agentId].name}"` : "global";
    const servers = isAgent
      ? config.agents[agentId]?.mcp?.servers ?? {}
      : config.mcp.servers;

    const entries = Object.entries(servers);
    if (entries.length === 0) {
      await ctx.reply(`No MCP servers (${scope}).`);
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
    await ctx.reply(`MCP Servers (${scope}):\n\n${lines.join("\n\n")}`);
  });

  b.callbackQuery("mcp:remove", async (ctx) => {
    await ctx.answerCallbackQuery();
    const config = getConfig();
    const isAgent = agentId && agentId !== "default" && config.agents[agentId];
    const servers = isAgent
      ? config.agents[agentId]?.mcp?.servers ?? {}
      : config.mcp.servers;

    const names = Object.keys(servers);
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
    const isAgent = agentId && agentId !== "default" && config.agents[agentId];

    const servers = isAgent
      ? { ...(config.agents[agentId]?.mcp?.servers ?? {}) }
      : { ...config.mcp.servers };

    if (!(name in servers)) {
      await ctx.reply(`Server "${name}" not found.`);
      return;
    }
    delete (servers as Record<string, unknown>)[name];

    if (isAgent) {
      const agents = { ...config.agents };
      agents[agentId] = { ...agents[agentId], mcp: { servers } } as typeof agents[string];
      saveConfig({ agents });
    } else {
      saveConfig({ mcp: { servers } });
    }
    await ctx.reply(`Removed MCP server: ${name}`);
  });

  // ─── Terminal mode: Claude Code via CLI ──────────────────────────

  // Track chats that manually exited Claude Code (prevents auto-restart for mode: claude-code agents)
  const ccPaused = new Set<number>();

  // ─── /cc — Claude Code menu ────────────────────────────────────────

  async function ccPinStatus(chatId: number, api: Bot["api"], on: boolean) {
    // Always clean up old pin first
    const oldPin = getPinnedMessageId(chatId);
    if (oldPin) {
      try { await api.unpinChatMessage(chatId, oldPin); } catch {}
      try { await api.deleteMessage(chatId, oldPin); } catch {}
    }
    setPinnedMessageId(chatId, undefined);

    if (on) {
      try {
        const msg = await api.sendMessage(chatId, "Claude Code ON");
        await api.pinChatMessage(chatId, msg.message_id, { disable_notification: true });
        setPinnedMessageId(chatId, msg.message_id);
      } catch {}
    }
  }

  function ccResolveWorkDir(): string {
    const config = getConfig();
    const agentConfig = config.agents[agentId];
    return agentConfig?.workDir ? expandHome(agentConfig.workDir) : os.homedir() + "/Desktop";
  }

  b.command("claudecode", async (ctx) => {
    const detection = detectClaudeCode();
    if (!detection.found) {
      await ctx.reply("Claude Code not found. Install: npm i -g @anthropic-ai/claude-code");
      return;
    }

    if (hasTerminal(ctx.chat.id)) {
      // Active session — show status + options
      const sessionId = getTerminalSessionId(ctx.chat.id) ?? "none";
      const workDir = getTerminalWorkDir(ctx.chat.id) ?? "?";
      const model = getTerminalModel(ctx.chat.id) ?? "default";
      const home = os.homedir();
      const displayDir = workDir.startsWith(home) ? "~" + workDir.slice(home.length) : workDir;

      const effort = getTerminalSetting(ctx.chat.id, "effort") ?? "default";
      const budget = getTerminalSetting(ctx.chat.id, "maxBudgetUsd");
      const worktree = getTerminalSetting(ctx.chat.id, "worktree");

      const approvals = getTerminalSetting(ctx.chat.id, "permissionMode") ?? "skip";

      const kb = new InlineKeyboard()
        .text("New Session", "cc:new").text("Stop", "cc:stop").row()
        .text("Model", "cc:model").text("Effort", "cc:effortmenu").row()
        .text("Approvals", "cc:approvalsmenu").text("Sessions", "cc:sessions").row()
        .text("Work Dir", "cc:workdir");

      const approvalsLabel = approvals === "acceptEdits" ? "Accept Edits" : "Skip All";

      const lines = [
        `Claude Code active`,
        `Session: ${sessionId.slice(0, 8)}...`,
        `Model: ${model} | Effort: ${effort}`,
        `Approvals: ${approvalsLabel}`,
        `Dir: ${displayDir}`,
      ];
      if (budget) lines.push(`Budget: $${budget}`);
      if (worktree) lines.push(`Worktree: ON`);

      await ctx.reply(lines.join("\n"), { reply_markup: kb });
    } else {
      // Not active — show start options
      const kb = new InlineKeyboard()
        .text("Start", "cc:start").text("Resume Session", "cc:sessions").row()
        .text("Work Dir", "cc:workdir");

      await ctx.reply(
        `Claude Code (${detection.version ?? ""})\nDir: ${ccResolveWorkDir().replace(os.homedir(), "~")}`,
        { reply_markup: kb },
      );
    }
  });

  b.command("exit", async (ctx) => {
    if (!hasTerminal(ctx.chat.id)) {
      await ctx.reply("No active Claude Code session.");
      return;
    }
    await ccPinStatus(ctx.chat.id, ctx.api, false);
    endTerminal(ctx.chat.id);
    ccPaused.add(ctx.chat.id);
    await setCommandMenu(false, ctx.chat.id);
    await ctx.reply("Claude Code stopped. Use /claudecode to start again.");
  });

  b.command("workdir", async (ctx) => {
    const config = getConfig();
    const agentConfig = config.agents[agentId];
    const currentDir = agentConfig?.workDir
      ? expandHome(agentConfig.workDir)
      : os.homedir();

    await startBrowse(ctx.chat.id, ctx.api, currentDir, (selectedDir) => {
      // Save to config
      const agents = { ...config.agents };
      agents[agentId] = { ...agents[agentId], workDir: selectedDir };
      saveConfig({ agents });

      // Update active terminal session if any
      if (hasTerminal(ctx.chat.id)) {
        updateWorkDir(ctx.chat.id, selectedDir);
      }
    });
  });

  // Claude Code shortcut commands — map Telegram commands to natural language prompts
  const CC_SHORTCUTS: Record<string, string | ((args: string) => string)> = {
    "/review": (args) => args
      ? `Review this code and provide feedback: ${args}`
      : "Review all the code changes in the current working directory. Look at git diff if available, otherwise review the main files. Provide actionable feedback on bugs, improvements, and best practices.",
    "/init": "Create a CLAUDE.md file for this project. Analyze the codebase structure, tech stack, build commands, and key patterns. Write a concise CLAUDE.md that helps future Claude Code sessions understand this project.",
    "/fix": (args) => args
      ? `Find and fix this issue: ${args}`
      : "Look at the code in the current directory. Find any bugs, errors, or issues and fix them.",
    "/test": (args) => args
      ? `Write tests for: ${args}`
      : "Look at the code in the current directory and write or run the appropriate tests.",
    "/explain": (args) => args
      ? `Explain this: ${args}`
      : "Explain the architecture and key patterns of this codebase. What does it do, how is it structured, and what are the main entry points?",
    "/refactor": (args) => args
      ? `Refactor this: ${args}`
      : "Review the code in the current directory and suggest refactoring improvements. Focus on readability, maintainability, and removing duplication.",
    "/security": "Perform a security review of this codebase. Look for common vulnerabilities: injection, XSS, auth issues, hardcoded secrets, insecure dependencies. Report findings with severity and fix suggestions.",
    "/pr": "Look at the current git changes (staged and unstaged). Write a pull request description with a summary of changes, what was changed and why, and any testing notes.",
    "/commit": "Look at the current git changes. Create a well-formatted commit message that describes what changed and why. Then commit the changes.",
    "/doc": (args) => args
      ? `Write documentation for: ${args}`
      : "Generate documentation for the key modules in this codebase. Focus on public APIs, configuration options, and usage examples.",
    "/cost": "Show the current Claude Code session cost and token usage.",
  };

  // Claude Code settings commands — handled before sending to subprocess
  const CC_SETTINGS: Record<string, (ctx: any, args: string) => Promise<boolean>> = {
    "/model": async (ctx, args) => {
      const chatId = ctx.chat.id;
      if (!hasTerminal(chatId)) { await ctx.reply("No active Claude Code session."); return true; }
      const models = ["sonnet", "opus", "haiku"];
      if (args && models.includes(args.toLowerCase())) {
        setTerminalModel(chatId, args.toLowerCase());
        await ctx.reply(`Model set to: ${args.toLowerCase()}`);
      } else if (args) {
        // Allow any model name (e.g. claude-sonnet-4-20250514)
        setTerminalModel(chatId, args);
        await ctx.reply(`Model set to: ${args}`);
      } else {
        const current = getTerminalModel(chatId) ?? "default";
        const kb = new InlineKeyboard()
          .text("Sonnet 4.6", "cc:setmodel:claude-sonnet-4-6").text("Opus 4.6", "cc:setmodel:claude-opus-4-6").row()
          .text("Haiku 4.5", "cc:setmodel:claude-haiku-4-5-20251001").row()
          .text("Default", "cc:setmodel:__default__");
        await ctx.reply(`Model: ${current}`, { reply_markup: kb });
      }
      return true;
    },
    "/effort": async (ctx, args) => {
      const chatId = ctx.chat.id;
      if (!hasTerminal(chatId)) { await ctx.reply("No active Claude Code session."); return true; }
      const levels = ["low", "medium", "high", "max"];
      if (args && levels.includes(args)) {
        setTerminalSetting(chatId, "effort", args);
        await ctx.reply(`Effort set to: ${args}`);
      } else {
        const current = getTerminalSetting(chatId, "effort") ?? "default";
        const kb = new InlineKeyboard()
          .text("Low", "cc:effort:low").text("Medium", "cc:effort:medium").row()
          .text("High", "cc:effort:high").text("Max", "cc:effort:max");
        await ctx.reply(`Effort: ${current}`, { reply_markup: kb });
      }
      return true;
    },
    "/prompt": async (ctx, args) => {
      const chatId = ctx.chat.id;
      if (!hasTerminal(chatId)) { await ctx.reply("No active Claude Code session."); return true; }
      if (args) {
        setTerminalSetting(chatId, "systemPrompt", args);
        await ctx.reply(`System prompt set.`);
      } else {
        const current = getTerminalSetting(chatId, "systemPrompt");
        await ctx.reply(current ? `Current prompt: ${current}\n\nSend /prompt <text> to change.` : "No custom prompt. Send /prompt <text> to set one.");
      }
      return true;
    },
    "/budget": async (ctx, args) => {
      const chatId = ctx.chat.id;
      if (!hasTerminal(chatId)) { await ctx.reply("No active Claude Code session."); return true; }
      const amount = parseFloat(args);
      if (args && !isNaN(amount) && amount > 0) {
        setTerminalSetting(chatId, "maxBudgetUsd", amount);
        await ctx.reply(`Budget limit set to: $${amount}`);
      } else {
        const current = getTerminalSetting(chatId, "maxBudgetUsd");
        await ctx.reply(current ? `Budget: $${current}\n\nSend /budget <amount> to change.` : "No budget limit. Send /budget 5.00 to set one.");
      }
      return true;
    },
    "/adddir": async (ctx, args) => {
      const chatId = ctx.chat.id;
      if (!hasTerminal(chatId)) { await ctx.reply("No active Claude Code session."); return true; }
      if (args) {
        const current = getTerminalSetting(chatId, "addDirs") ?? [];
        setTerminalSetting(chatId, "addDirs", [...current, args]);
        await ctx.reply(`Added directory: ${args}`);
      } else {
        const current = getTerminalSetting(chatId, "addDirs") ?? [];
        await ctx.reply(current.length ? `Extra dirs: ${current.join(", ")}\n\nSend /adddir <path> to add more.` : "No extra directories. Send /adddir ~/other-project to add one.");
      }
      return true;
    },
    "/tools": async (ctx, _args) => {
      const chatId = ctx.chat.id;
      if (!hasTerminal(chatId)) { await ctx.reply("No active Claude Code session."); return true; }
      const denied = new Set(getTerminalSetting(chatId, "disallowedTools") ?? []);
      const CC_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Agent"];
      const kb = new InlineKeyboard();
      for (let i = 0; i < CC_TOOLS.length; i++) {
        const t = CC_TOOLS[i];
        const icon = denied.has(t) ? "🚫" : "✅";
        kb.text(`${icon} ${t}`, `cc:tool:${t}`);
        if ((i + 1) % 3 === 0) kb.row();
      }
      kb.row().text("Reset All", "cc:tool:__reset__");
      const status = denied.size ? `Blocked: ${[...denied].join(", ")}` : "All tools enabled";
      await ctx.reply(`${status}\n\nTap to toggle:`, { reply_markup: kb });
      return true;
    },
    "/worktree": async (ctx, _args) => {
      const chatId = ctx.chat.id;
      if (!hasTerminal(chatId)) { await ctx.reply("No active Claude Code session."); return true; }
      const current = getTerminalSetting(chatId, "worktree") ?? false;
      setTerminalSetting(chatId, "worktree", !current);
      await ctx.reply(`Git worktree: ${!current ? "ON" : "OFF"}`);
      return true;
    },
    "/approvals": async (ctx, args) => {
      const chatId = ctx.chat.id;
      if (!hasTerminal(chatId)) { await ctx.reply("No active Claude Code session."); return true; }
      const modes = ["skip", "acceptEdits"];
      if (args && modes.includes(args)) {
        setTerminalSetting(chatId, "permissionMode", args as "skip" | "acceptEdits");
        const label = args === "acceptEdits" ? "Accept Edits" : "Skip All";
        await ctx.reply(`Approvals set to: ${label}`);
      } else {
        const current = getTerminalSetting(chatId, "permissionMode") ?? "skip";
        const label = current === "acceptEdits" ? "Accept Edits" : "Skip All";
        const kb = new InlineKeyboard()
          .text("Skip All", "cc:setapprovals:skip").text("Accept Edits", "cc:setapprovals:acceptEdits");
        await ctx.reply(`Approvals: ${label}`, { reply_markup: kb });
      }
      return true;
    },
  };

  // Terminal log helpers
  const cclog = (icon: string, msg: string) => {
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    console.log(`  ${time} ${icon} ${msg}`);
  };

  async function handleTerminalIncoming(ctx: any) {
    const chatId = ctx.chat.id;
    let text = stripMention(ctx.message.text, botInfo.username);
    if (!text) return;

    // Check for Claude Code settings commands (don't send to subprocess)
    const firstWord = text.split(/\s+/)[0].toLowerCase();
    const settingHandler = CC_SETTINGS[firstWord];
    if (settingHandler) {
      const args = text.slice(firstWord.length).trim();
      await settingHandler(ctx, args);
      return;
    }

    // Check for Claude Code shortcut commands (convert to prompts)
    const shortcut = CC_SHORTCUTS[firstWord];
    if (shortcut) {
      const args = text.slice(firstWord.length).trim();
      text = typeof shortcut === "function" ? shortcut(args) : shortcut;
    }

    if (isTerminalBusy(chatId)) {
      await ctx.reply("Claude Code is busy. Wait for the current response.");
      return;
    }

    const who = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name ?? "user";
    cclog("→", `[${who}] ${text.slice(0, 120)}`);

    const draft = createDraftStream(chatId, ctx.api);
    let pendingText = "";

    const setReaction = async (emoji: string) => {
      try {
        const reactions = emoji ? [{ type: "emoji" as const, emoji: emoji as any }] : [];
        await ctx.api.setMessageReaction(chatId, ctx.message.message_id, reactions);
      } catch {}
    };

    try {
      await setReaction("eyes");
      await ctx.replyWithChatAction("typing");

      // Keep "typing" alive every 4s while Claude Code runs
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);

      let result: Awaited<ReturnType<typeof handleTerminalMessage>>;
      try {
        result = await handleTerminalMessage(chatId, text, (event) => {
          if (event.type === "text_delta" && event.text) {
            pendingText += event.text;
            draft.update(pendingText);
          } else if (event.type === "thinking_start") {
            cclog("..", "Thinking...");
            setReaction("thought_balloon").catch(() => {});
          } else if (event.type === "tool_use") {
            cclog("⚡", `Tool: ${event.toolName ?? "unknown"}`);
            setReaction("wrench").catch(() => {});
          }
        });
      } finally {
        clearInterval(typingInterval);
      }

      // Use streamed text if available, fall back to result.response
      const response = pendingText || result.response || "(no response)";
      draft.update(response);
      await draft.flush();

      const streamMsgId = draft.getMessageId();
      if (streamMsgId && response.length > 4096) {
        try { await ctx.api.deleteMessage(chatId, streamMsgId); } catch {}
        await sendChunked(ctx, response);
      } else if (!streamMsgId) {
        await sendChunked(ctx, response);
      }

      cclog("←", `[claude] ${response.replace(/\n/g, " ").slice(0, 120)}`);
      await setReaction("");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      cclog("✗", `Error: ${errMsg}`);
      slog.error("terminal", "Claude Code failed", { chatId, error: errMsg });
      const streamMsgId = draft.getMessageId();
      if (streamMsgId) {
        try { await ctx.api.editMessageText(chatId, streamMsgId, `Error: ${errMsg}`); }
        catch { await ctx.reply(`Error: ${errMsg}`); }
      } else {
        await ctx.reply(`Error: ${errMsg}`);
      }
      await setReaction("");
    }
  }

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
        onRetry: async (attempt, kind) => {
          await alertAdmin(`⚠️ ${agent.name}: ${kind} (attempt ${attempt + 1}/${config.retry.maxRetries})`);
        },
        onError: async (err, kind) => {
          const isFatal = kind === "auth" || kind === "billing";
          const icon = isFatal ? "🚨" : "⚠️";
          await alertAdmin(`${icon} ${agent.name}: ${kind} — ${err.message.slice(0, 200)}`);
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

  // Handle wizard callback queries (inline button selections)
  b.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("wizard:")) {
      await ctx.answerCallbackQuery();
      const value = data.split(":").slice(2).join(":");
      await advanceWizard(ctx.chat!.id, value, b);
    } else if (data.startsWith("browse:")) {
      await ctx.answerCallbackQuery();
      const value = data.slice("browse:".length);
      await handleBrowseCallback(ctx.chat!.id, value, ctx.api);
    } else if (data.startsWith("cc:")) {
      await ctx.answerCallbackQuery();
      const action = data.slice("cc:".length);
      const chatId = ctx.chat!.id;

      if (action === "start") {
        ccPaused.delete(chatId);
        startTerminal(chatId, ccResolveWorkDir());
        await setCommandMenu(true, chatId);
        await ccPinStatus(chatId, ctx.api, true);
        await ctx.editMessageText("Claude Code started. Send messages.");
      } else if (action === "stop") {
        await ccPinStatus(chatId, ctx.api, false);
        endTerminal(chatId);
        ccPaused.add(chatId);
        await setCommandMenu(false, chatId);
        await ctx.editMessageText("Claude Code stopped. Use /claudecode to start again.");
      } else if (action === "new") {
        // Start fresh session (clear old sessionId)
        ccPaused.delete(chatId);
        startTerminal(chatId, ccResolveWorkDir());
        await setCommandMenu(true, chatId);
        await ccPinStatus(chatId, ctx.api, true);
        await ctx.editMessageText("New Claude Code session started.");
      } else if (action === "sessions") {
        const ccSessions = listClaudeSessions(ccResolveWorkDir());
        if (ccSessions.length === 0) {
          await ctx.editMessageText("No previous Claude Code sessions found.");
          return;
        }
        const home = os.homedir();
        const kb = new InlineKeyboard();
        for (const s of ccSessions) {
          const dir = s.cwd ? s.cwd.replace(home, "~") : "";
          const label = s.name ?? `${s.id.slice(0, 8)} ${dir}`;
          kb.text(label, `cc:resume:${s.id}`).row();
        }
        kb.text("⬅ Back", "cc:back");
        await ctx.editMessageText("Resume a session:", { reply_markup: kb });
      } else if (action === "workdir") {
        const config = getConfig();
        const agentConfig = config.agents[agentId];
        const currentDir = agentConfig?.workDir
          ? expandHome(agentConfig.workDir)
          : os.homedir();
        await startBrowse(chatId, ctx.api, currentDir, (selectedDir) => {
          const agents = { ...config.agents };
          agents[agentId] = { ...agents[agentId], workDir: selectedDir };
          saveConfig({ agents });
          if (hasTerminal(chatId)) {
            updateWorkDir(chatId, selectedDir);
          }
        });
      } else if (action === "effortmenu") {
        const current = getTerminalSetting(chatId, "effort") ?? "default";
        const kb = new InlineKeyboard()
          .text("Low", "cc:effort:low").text("Medium", "cc:effort:medium").row()
          .text("High", "cc:effort:high").text("Max", "cc:effort:max").row()
          .text("⬅ Back", "cc:back");
        await ctx.editMessageText(`Effort: ${current}\n\nSelect level:`, { reply_markup: kb });
      } else if (action === "approvalsmenu") {
        const current = getTerminalSetting(chatId, "permissionMode") ?? "skip";
        const label = current === "acceptEdits" ? "Accept Edits" : "Skip All";
        const kb = new InlineKeyboard()
          .text("Skip All", "cc:setapprovals:skip").text("Accept Edits", "cc:setapprovals:acceptEdits").row()
          .text("⬅ Back", "cc:back");
        await ctx.editMessageText(`Approvals: ${label}\n\nSkip All — no checks, everything auto-approved\nAccept Edits — auto-accepts reads/edits, blocks dangerous commands`, { reply_markup: kb });
      } else if (action.startsWith("setapprovals:")) {
        const mode = action.slice("setapprovals:".length) as "skip" | "acceptEdits";
        setTerminalSetting(chatId, "permissionMode", mode);
        const label = mode === "acceptEdits" ? "Accept Edits" : "Skip All";
        await ctx.editMessageText(`Approvals set to: ${label}`);
      } else if (action.startsWith("tool:")) {
        const tool = action.slice("tool:".length);
        const CC_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Agent"];
        if (tool === "__reset__") {
          setTerminalSetting(chatId, "disallowedTools", undefined as any);
          setTerminalSetting(chatId, "allowedTools", undefined as any);
          const kb = new InlineKeyboard();
          for (let i = 0; i < CC_TOOLS.length; i++) {
            kb.text(`✅ ${CC_TOOLS[i]}`, `cc:tool:${CC_TOOLS[i]}`);
            if ((i + 1) % 3 === 0) kb.row();
          }
          kb.row().text("Reset All", "cc:tool:__reset__");
          await ctx.editMessageText("All tools enabled\n\nTap to toggle:", { reply_markup: kb });
        } else {
          const denied = new Set(getTerminalSetting(chatId, "disallowedTools") ?? []);
          if (denied.has(tool)) {
            denied.delete(tool);
          } else {
            denied.add(tool);
          }
          setTerminalSetting(chatId, "disallowedTools", denied.size ? [...denied] : undefined as any);
          const kb = new InlineKeyboard();
          for (let i = 0; i < CC_TOOLS.length; i++) {
            const t = CC_TOOLS[i];
            const icon = denied.has(t) ? "🚫" : "✅";
            kb.text(`${icon} ${t}`, `cc:tool:${t}`);
            if ((i + 1) % 3 === 0) kb.row();
          }
          kb.row().text("Reset All", "cc:tool:__reset__");
          const status = denied.size ? `Blocked: ${[...denied].join(", ")}` : "All tools enabled";
          await ctx.editMessageText(`${status}\n\nTap to toggle:`, { reply_markup: kb });
        }
      } else if (action === "model") {
        const current = getTerminalModel(chatId) ?? "default";
        const kb = new InlineKeyboard()
          .text("Sonnet 4.6", "cc:setmodel:claude-sonnet-4-6").text("Opus 4.6", "cc:setmodel:claude-opus-4-6").row()
          .text("Haiku 4.5", "cc:setmodel:claude-haiku-4-5-20251001").row()
          .text("Default", "cc:setmodel:__default__").row()
          .text("⬅ Back", "cc:back");
        await ctx.editMessageText(`Current model: ${current}\n\nSelect model:`, { reply_markup: kb });
      } else if (action.startsWith("setmodel:")) {
        const model = action.slice("setmodel:".length);
        if (model === "__default__") {
          setTerminalModel(chatId, undefined);
          await ctx.editMessageText("Model reset to default.");
        } else {
          setTerminalModel(chatId, model);
          await ctx.editMessageText(`Model set to: ${model}`);
        }
      } else if (action.startsWith("effort:")) {
        const level = action.slice("effort:".length);
        setTerminalSetting(chatId, "effort", level);
        await ctx.editMessageText(`Effort set to: ${level}`);
      } else if (action === "back") {
        // Re-show main menu
        if (hasTerminal(chatId)) {
          const model = getTerminalModel(chatId) ?? "default";
          const kb = new InlineKeyboard()
            .text("New Session", "cc:new").text("Stop", "cc:stop").row()
            .text("Model", "cc:model").text("Sessions", "cc:sessions").row()
            .text("Work Dir", "cc:workdir");
          await ctx.editMessageText(`Claude Code active (${model})`, { reply_markup: kb });
        } else {
          const kb = new InlineKeyboard()
            .text("Start", "cc:start").text("Resume Session", "cc:sessions").row()
            .text("Work Dir", "cc:workdir");
          await ctx.editMessageText("Claude Code", { reply_markup: kb });
        }
      } else if (action.startsWith("resume:")) {
        const sessionId = action.slice("resume:".length);
        ccPaused.delete(chatId);
        startTerminal(chatId, ccResolveWorkDir(), sessionId);
        await setCommandMenu(true, chatId);
        await ccPinStatus(chatId, ctx.api, true);
        await ctx.editMessageText(`Resumed session ${sessionId.slice(0, 8)}... Send messages.`);
      }
    }
  });

  b.on("message:text", async (ctx) => {
    // Claude Code mode: manual (/cc) or config-driven (mode: claude-code)
    if (hasTerminal(ctx.chat.id)) {
      await handleTerminalIncoming(ctx);
      return;
    }
    const agentCfg = getConfig().agents[agentId];
    if (agentCfg?.mode === "claude-code" && !ccPaused.has(ctx.chat.id)) {
      // Auto-start terminal session for claude-code agents (unless manually exited)
      const workDir = agentCfg.workDir ? expandHome(agentCfg.workDir) : os.homedir() + "/Desktop";
      startTerminal(ctx.chat.id, workDir);
      if (agentCfg.ccApprovals === "acceptEdits") {
        setTerminalSetting(ctx.chat.id, "permissionMode", "acceptEdits");
      }
      await setCommandMenu(true, ctx.chat.id);
      await handleTerminalIncoming(ctx);
      return;
    }

    // Advance active wizard with text input
    if (hasActiveWizard(ctx.chat.id)) {
      const consumed = await advanceWizard(ctx.chat.id, ctx.message.text, b);
      if (consumed) return;
    }

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
