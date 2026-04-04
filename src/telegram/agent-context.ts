// Shared context and helpers for agent bot modules

import type { Bot } from "grammy";
import { loadConfig, type Config } from "../core/config.js";
import type { BotState } from "./types.js";
import { resolveAgent } from "./resolve.js";
import { getPinnedMessageId, setPinnedMessageId, expandHome } from "./terminal.js";
import os from "node:os";

/** Shared state passed to all agent bot modules */
export interface BotContext {
  agentId: string;
  botToken: string;
  bot: Bot;
  botInfo: { id: number; username: string };
  getConfig: () => Config;
  getSystemPrompt: () => string;
  activeBots: Map<string, BotState>;
  runtimeModels: Map<number, string>;
  runtimeThinking: Map<number, Config["thinking"]>;
  runtimeEffort: Map<number, Config["effort"]>;
  runtimeBriefMode: Map<number, boolean>;
  ccPaused: Set<number>;
}

// ─── Command menus ──────────────────────────────────────────────────

export const NORMAL_COMMANDS = [
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

export const CLAUDECODE_COMMANDS = [
  { command: "claudecode", description: "Menu — sessions, model, settings" },
  { command: "exit", description: "Exit Claude Code mode" },
  { command: "model", description: "Switch model (sonnet, opus, haiku)" },
  { command: "workdir", description: "Change working directory" },
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
  { command: "effort", description: "Effort level (low/medium/high/max)" },
  { command: "tools", description: "Allow/deny tools" },
  { command: "approvals", description: "Approval mode (skip/acceptEdits)" },
  { command: "prompt", description: "Custom system prompt" },
  { command: "budget", description: "Max budget in USD" },
  { command: "adddir", description: "Add extra directory" },
  { command: "worktree", description: "Git worktree isolation" },
  { command: "cost", description: "Session cost" },
];

// ─── Helper functions ───────────────────────────────────────────────

export function sid(ctx: BotContext, chatId: number): string {
  return ctx.agentId === "telegram" ? `telegram-${chatId}` : `${ctx.agentId}-${chatId}`;
}

export function getAgent(ctx: BotContext, chatId: number) {
  return resolveAgent(ctx.agentId, ctx.getConfig(), ctx.getSystemPrompt(), {
    model: ctx.runtimeModels.get(chatId),
    thinking: ctx.runtimeThinking.get(chatId),
    effort: ctx.runtimeEffort.get(chatId),
    briefMode: ctx.runtimeBriefMode.get(chatId),
  });
}

// Error alert throttling — max 1 per agent per 5 minutes
const errorAlertTimes = new Map<string, number>();
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

export async function alertAdmin(ctx: BotContext, message: string): Promise<void> {
  const lastAlert = errorAlertTimes.get(ctx.agentId) ?? 0;
  if (Date.now() - lastAlert < ALERT_COOLDOWN_MS) return;
  errorAlertTimes.set(ctx.agentId, Date.now());

  const config = ctx.getConfig();
  const adminEntry = Object.entries(config.agents).find(([, a]) => a.admin);
  if (!adminEntry) return;
  const [adminId] = adminEntry;
  const adminState = ctx.activeBots.get(adminId);
  if (!adminState) return;

  const adminUsers = adminEntry[1].telegram?.allowedUsers ?? [];
  for (const userId of adminUsers) {
    try {
      await adminState.bot.api.sendMessage(userId, message);
    } catch { /* best effort */ }
  }
}

export function isUserAllowed(ctx: BotContext, userId: number): boolean {
  const agent = getAgent(ctx, 0);
  if (agent.allowedUsers.includes(userId)) return true;
  try {
    const fresh = loadConfig();
    const freshAgent = ctx.agentId === "telegram"
      ? fresh.telegram
      : fresh.agents[ctx.agentId]?.telegram;
    const freshAllowed = freshAgent?.allowedUsers ?? [];
    if (freshAllowed.includes(userId)) return true;
  } catch {}
  return false;
}

export async function setCommandMenu(ctx: BotContext, ccMode: boolean, chatId?: number): Promise<void> {
  const commands = ccMode ? CLAUDECODE_COMMANDS : NORMAL_COMMANDS;
  if (chatId) {
    await ctx.bot.api.setMyCommands(commands, { scope: { type: "chat", chat_id: chatId } }).catch(() => {});
  } else {
    await ctx.bot.api.setMyCommands(commands).catch(() => {});
  }
}

export function ccResolveWorkDir(ctx: BotContext): string {
  const config = ctx.getConfig();
  const agentConfig = config.agents[ctx.agentId];
  return agentConfig?.workDir ? expandHome(agentConfig.workDir) : os.homedir() + "/Desktop";
}

export async function ccPinStatus(ctx: BotContext, chatId: number, on: boolean): Promise<void> {
  const oldPin = getPinnedMessageId(chatId);
  if (oldPin) {
    try { await ctx.bot.api.unpinChatMessage(chatId, oldPin); } catch {}
    try { await ctx.bot.api.deleteMessage(chatId, oldPin); } catch {}
  }
  setPinnedMessageId(chatId, undefined);

  if (on) {
    try {
      const msg = await ctx.bot.api.sendMessage(chatId, "Claude Code ON");
      await ctx.bot.api.pinChatMessage(chatId, msg.message_id, { disable_notification: true });
      setPinnedMessageId(chatId, msg.message_id);
    } catch {}
  }
}
