// Claude Code integration: commands, shortcuts, settings, callbacks, terminal handler

import { InlineKeyboard } from "grammy";
import { saveConfig } from "../core/config.js";
import { log as slog } from "../core/log.js";
import type { BotContext } from "./agent-context.js";
import { getAgent, setCommandMenu, ccResolveWorkDir, ccPinStatus } from "./agent-context.js";
import { createDraftStream } from "./draft-stream.js";
import { stripMention, sendChunked } from "./helpers.js";
import { startBrowse, handleBrowseCallback as browseCallback } from "./dir-browser.js";
import {
  detectClaudeCode, startTerminal, endTerminal, hasTerminal, isTerminalBusy,
  handleTerminalMessage, expandHome, updateWorkDir,
  getTerminalSessionId, getTerminalWorkDir, getTerminalModel, setTerminalModel,
  getTerminalSetting, setTerminalSetting,
  listClaudeSessions,
} from "./terminal.js";
import os from "node:os";

// ─── Command mode guard ───────────────────────────────────────────────

const CC_ONLY_COMMANDS = new Set([
  "exit", "review", "fix", "test", "refactor", "security",
  "pr", "commit", "init", "explain", "doc", "cost",
  "prompt", "budget", "adddir", "tools", "worktree", "approvals",
]);
const SHARED_COMMANDS = new Set([
  "claudecode", "start", "model", "effort", "workdir", "help",
]);

// ─── Shortcut commands (map Telegram commands to prompts) ─────────────

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

// ─── Settings commands (handled before sending to subprocess) ─────────

const CC_SETTINGS: Record<string, (gc: any, args: string) => Promise<boolean>> = {
  "/model": async (gc, args) => {
    const chatId = gc.chat.id;
    if (!hasTerminal(chatId)) { await gc.reply("No active Claude Code session."); return true; }
    const models = ["sonnet", "opus", "haiku"];
    if (args && models.includes(args.toLowerCase())) {
      setTerminalModel(chatId, args.toLowerCase());
      await gc.reply(`Model set to: ${args.toLowerCase()}`);
    } else if (args) {
      setTerminalModel(chatId, args);
      await gc.reply(`Model set to: ${args}`);
    } else {
      const current = getTerminalModel(chatId) ?? "default";
      const kb = new InlineKeyboard()
        .text("Sonnet 4.6", "cc:setmodel:claude-sonnet-4-6").text("Opus 4.6", "cc:setmodel:claude-opus-4-6").row()
        .text("Haiku 4.5", "cc:setmodel:claude-haiku-4-5-20251001").row()
        .text("Default", "cc:setmodel:__default__");
      await gc.reply(`Model: ${current}`, { reply_markup: kb });
    }
    return true;
  },
  "/effort": async (gc, args) => {
    const chatId = gc.chat.id;
    if (!hasTerminal(chatId)) { await gc.reply("No active Claude Code session."); return true; }
    const levels = ["low", "medium", "high", "max"];
    if (args && levels.includes(args)) {
      setTerminalSetting(chatId, "effort", args);
      await gc.reply(`Effort set to: ${args}`);
    } else {
      const current = getTerminalSetting(chatId, "effort") ?? "default";
      const kb = new InlineKeyboard()
        .text("Low", "cc:effort:low").text("Medium", "cc:effort:medium").row()
        .text("High", "cc:effort:high").text("Max", "cc:effort:max");
      await gc.reply(`Effort: ${current}`, { reply_markup: kb });
    }
    return true;
  },
  "/prompt": async (gc, args) => {
    const chatId = gc.chat.id;
    if (!hasTerminal(chatId)) { await gc.reply("No active Claude Code session."); return true; }
    if (args) {
      setTerminalSetting(chatId, "systemPrompt", args);
      await gc.reply(`System prompt set.`);
    } else {
      const current = getTerminalSetting(chatId, "systemPrompt");
      await gc.reply(current ? `Current prompt: ${current}\n\nSend /prompt <text> to change.` : "No custom prompt. Send /prompt <text> to set one.");
    }
    return true;
  },
  "/budget": async (gc, args) => {
    const chatId = gc.chat.id;
    if (!hasTerminal(chatId)) { await gc.reply("No active Claude Code session."); return true; }
    const amount = parseFloat(args);
    if (args && !isNaN(amount) && amount > 0) {
      setTerminalSetting(chatId, "maxBudgetUsd", amount);
      await gc.reply(`Budget limit set to: $${amount}`);
    } else {
      const current = getTerminalSetting(chatId, "maxBudgetUsd");
      await gc.reply(current ? `Budget: $${current}\n\nSend /budget <amount> to change.` : "No budget limit. Send /budget 5.00 to set one.");
    }
    return true;
  },
  "/adddir": async (gc, args) => {
    const chatId = gc.chat.id;
    if (!hasTerminal(chatId)) { await gc.reply("No active Claude Code session."); return true; }
    if (args) {
      const current = getTerminalSetting(chatId, "addDirs") ?? [];
      setTerminalSetting(chatId, "addDirs", [...current, args]);
      await gc.reply(`Added directory: ${args}`);
    } else {
      const current = getTerminalSetting(chatId, "addDirs") ?? [];
      await gc.reply(current.length ? `Extra dirs: ${current.join(", ")}\n\nSend /adddir <path> to add more.` : "No extra directories. Send /adddir ~/other-project to add one.");
    }
    return true;
  },
  "/tools": async (gc, _args) => {
    const chatId = gc.chat.id;
    if (!hasTerminal(chatId)) { await gc.reply("No active Claude Code session."); return true; }
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
    await gc.reply(`${status}\n\nTap to toggle:`, { reply_markup: kb });
    return true;
  },
  "/worktree": async (gc, _args) => {
    const chatId = gc.chat.id;
    if (!hasTerminal(chatId)) { await gc.reply("No active Claude Code session."); return true; }
    const current = getTerminalSetting(chatId, "worktree") ?? false;
    setTerminalSetting(chatId, "worktree", !current);
    await gc.reply(`Git worktree: ${!current ? "ON" : "OFF"}`);
    return true;
  },
  "/approvals": async (gc, args) => {
    const chatId = gc.chat.id;
    if (!hasTerminal(chatId)) { await gc.reply("No active Claude Code session."); return true; }
    const modes = ["skip", "acceptEdits"];
    if (args && modes.includes(args)) {
      setTerminalSetting(chatId, "permissionMode", args as "skip" | "acceptEdits");
      const label = args === "acceptEdits" ? "Accept Edits" : "Skip All";
      await gc.reply(`Approvals set to: ${label}`);
    } else {
      const current = getTerminalSetting(chatId, "permissionMode") ?? "skip";
      const label = current === "acceptEdits" ? "Accept Edits" : "Skip All";
      const kb = new InlineKeyboard()
        .text("Skip All", "cc:setapprovals:skip").text("Accept Edits", "cc:setapprovals:acceptEdits");
      await gc.reply(`Approvals: ${label}`, { reply_markup: kb });
    }
    return true;
  },
};

// ─── Terminal log helper ──────────────────────────────────────────────

const cclog = (icon: string, msg: string) => {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  console.log(`  ${time} ${icon} ${msg}`);
};

// ─── Terminal message handler (exported for use by message handlers) ──

export async function handleTerminalIncoming(ctx: BotContext, gc: any): Promise<void> {
  const chatId = gc.chat.id;
  let text = stripMention(gc.message.text, ctx.botInfo.username);
  if (!text) return;

  const firstWord = text.split(/\s+/)[0].toLowerCase();
  const settingHandler = CC_SETTINGS[firstWord];
  if (settingHandler) {
    const args = text.slice(firstWord.length).trim();
    await settingHandler(gc, args);
    return;
  }

  const shortcut = CC_SHORTCUTS[firstWord];
  if (shortcut) {
    const args = text.slice(firstWord.length).trim();
    text = typeof shortcut === "function" ? shortcut(args) : shortcut;
  }

  if (isTerminalBusy(chatId)) {
    await gc.reply("Claude Code is busy. Wait for the current response.");
    return;
  }

  const who = gc.from?.username ? `@${gc.from.username}` : gc.from?.first_name ?? "user";
  cclog("→", `[${who}] ${text.slice(0, 120)}`);

  const draft = createDraftStream(chatId, gc.api);
  let pendingText = "";

  const setReaction = async (emoji: string) => {
    try {
      const reactions = emoji ? [{ type: "emoji" as const, emoji: emoji as any }] : [];
      await gc.api.setMessageReaction(chatId, gc.message.message_id, reactions);
    } catch {}
  };

  try {
    await setReaction("eyes");
    await gc.replyWithChatAction("typing");

    const typingInterval = setInterval(() => {
      gc.replyWithChatAction("typing").catch(() => {});
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

    const response = pendingText || result.response || "(no response)";
    draft.update(response);
    await draft.flush();

    const streamMsgId = draft.getMessageId();
    if (streamMsgId && response.length > 4096) {
      try { await gc.api.deleteMessage(chatId, streamMsgId); } catch {}
      await sendChunked(gc, response);
    } else if (!streamMsgId) {
      await sendChunked(gc, response);
    }

    cclog("←", `[claude] ${response.replace(/\n/g, " ").slice(0, 120)}`);
    await setReaction("");
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    cclog("✗", `Error: ${errMsg}`);
    slog.error("terminal", "Claude Code failed", { chatId, error: errMsg });
    const streamMsgId = draft.getMessageId();
    if (streamMsgId) {
      try { await gc.api.editMessageText(chatId, streamMsgId, `Error: ${errMsg}`); }
      catch { await gc.reply(`Error: ${errMsg}`); }
    } else {
      await gc.reply(`Error: ${errMsg}`);
    }
    await setReaction("");
  }
}

// ─── Registration ─────────────────────────────────────────────────────

export function registerClaudeCode(ctx: BotContext): void {
  const { bot: b, ccPaused } = ctx;

  // Command mode guard middleware — must run before all command handlers
  b.on("message", async (gc, next) => {
    const text = gc.message?.text;
    if (!text?.startsWith("/")) { await next(); return; }
    const cmd = text.split(/[\s@]/)[0].slice(1).toLowerCase();
    if (SHARED_COMMANDS.has(cmd)) { await next(); return; }

    const inCC = hasTerminal(gc.chat.id);
    if (inCC && !CC_ONLY_COMMANDS.has(cmd)) {
      await gc.reply("Exit Claude Code first (/exit), then use this command.");
      return;
    }
    if (!inCC && CC_ONLY_COMMANDS.has(cmd)) {
      await gc.reply("Start Claude Code first (/claudecode).");
      return;
    }
    await next();
  });

  // ─── /claudecode command ──────────────────────────────────────────

  b.command("claudecode", async (gc) => {
    const detection = detectClaudeCode();
    if (!detection.found) {
      await gc.reply("Claude Code not found. Install: npm i -g @anthropic-ai/claude-code");
      return;
    }

    if (hasTerminal(gc.chat.id)) {
      const sessionId = getTerminalSessionId(gc.chat.id) ?? "none";
      const workDir = getTerminalWorkDir(gc.chat.id) ?? "?";
      const model = getTerminalModel(gc.chat.id) ?? "default";
      const home = os.homedir();
      const displayDir = workDir.startsWith(home) ? "~" + workDir.slice(home.length) : workDir;
      const effort = getTerminalSetting(gc.chat.id, "effort") ?? "default";
      const budget = getTerminalSetting(gc.chat.id, "maxBudgetUsd");
      const worktree = getTerminalSetting(gc.chat.id, "worktree");
      const approvals = getTerminalSetting(gc.chat.id, "permissionMode") ?? "skip";

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
      await gc.reply(lines.join("\n"), { reply_markup: kb });
    } else {
      const kb = new InlineKeyboard()
        .text("Start", "cc:start").text("Resume Session", "cc:sessions").row()
        .text("Work Dir", "cc:workdir");
      await gc.reply(
        `Claude Code (${detection.version ?? ""})\nDir: ${ccResolveWorkDir(ctx).replace(os.homedir(), "~")}`,
        { reply_markup: kb },
      );
    }
  });

  b.command("exit", async (gc) => {
    if (!hasTerminal(gc.chat.id)) {
      await gc.reply("No active Claude Code session.");
      return;
    }
    await ccPinStatus(ctx, gc.chat.id, false);
    endTerminal(gc.chat.id);
    ccPaused.add(gc.chat.id);
    await setCommandMenu(ctx, false, gc.chat.id);
    await gc.reply("Claude Code stopped. Use /claudecode to start again.");
  });

  b.command("workdir", async (gc) => {
    const config = ctx.getConfig();
    const agentConfig = config.agents[ctx.agentId];
    const currentDir = agentConfig?.workDir
      ? expandHome(agentConfig.workDir)
      : os.homedir();

    await startBrowse(gc.chat.id, gc.api, currentDir, (selectedDir) => {
      const agents = { ...config.agents };
      agents[ctx.agentId] = { ...agents[ctx.agentId], workDir: selectedDir };
      saveConfig({ agents });
      if (hasTerminal(gc.chat.id)) {
        updateWorkDir(gc.chat.id, selectedDir);
      }
    });
  });

  // ─── CC callback queries ──────────────────────────────────────────

  b.callbackQuery(/^cc:/, async (gc) => {
    await gc.answerCallbackQuery();
    const action = gc.callbackQuery.data.slice("cc:".length);
    const chatId = gc.chat!.id;

    if (action === "start") {
      ccPaused.delete(chatId);
      startTerminal(chatId, ccResolveWorkDir(ctx));
      await setCommandMenu(ctx, true, chatId);
      await ccPinStatus(ctx, chatId, true);
      await gc.editMessageText("Claude Code started. Send messages.");
    } else if (action === "stop") {
      await ccPinStatus(ctx, chatId, false);
      endTerminal(chatId);
      ccPaused.add(chatId);
      await setCommandMenu(ctx, false, chatId);
      await gc.editMessageText("Claude Code stopped. Use /claudecode to start again.");
    } else if (action === "new") {
      ccPaused.delete(chatId);
      startTerminal(chatId, ccResolveWorkDir(ctx));
      await setCommandMenu(ctx, true, chatId);
      await ccPinStatus(ctx, chatId, true);
      await gc.editMessageText("New Claude Code session started.");
    } else if (action === "sessions") {
      const ccSessions = listClaudeSessions(ccResolveWorkDir(ctx));
      if (ccSessions.length === 0) {
        await gc.editMessageText("No previous Claude Code sessions found.");
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
      await gc.editMessageText("Resume a session:", { reply_markup: kb });
    } else if (action === "workdir") {
      const config = ctx.getConfig();
      const agentConfig = config.agents[ctx.agentId];
      const currentDir = agentConfig?.workDir ? expandHome(agentConfig.workDir) : os.homedir();
      await startBrowse(chatId, gc.api, currentDir, (selectedDir) => {
        const agents = { ...config.agents };
        agents[ctx.agentId] = { ...agents[ctx.agentId], workDir: selectedDir };
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
      await gc.editMessageText(`Effort: ${current}\n\nSelect level:`, { reply_markup: kb });
    } else if (action === "approvalsmenu") {
      const current = getTerminalSetting(chatId, "permissionMode") ?? "skip";
      const label = current === "acceptEdits" ? "Accept Edits" : "Skip All";
      const kb = new InlineKeyboard()
        .text("Skip All", "cc:setapprovals:skip").text("Accept Edits", "cc:setapprovals:acceptEdits").row()
        .text("⬅ Back", "cc:back");
      await gc.editMessageText(`Approvals: ${label}\n\nSkip All — no checks, everything auto-approved\nAccept Edits — auto-accepts reads/edits, blocks dangerous commands`, { reply_markup: kb });
    } else if (action.startsWith("setapprovals:")) {
      const mode = action.slice("setapprovals:".length) as "skip" | "acceptEdits";
      setTerminalSetting(chatId, "permissionMode", mode);
      const label = mode === "acceptEdits" ? "Accept Edits" : "Skip All";
      await gc.editMessageText(`Approvals set to: ${label}`);
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
        await gc.editMessageText("All tools enabled\n\nTap to toggle:", { reply_markup: kb });
      } else {
        const denied = new Set(getTerminalSetting(chatId, "disallowedTools") ?? []);
        if (denied.has(tool)) denied.delete(tool); else denied.add(tool);
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
        await gc.editMessageText(`${status}\n\nTap to toggle:`, { reply_markup: kb });
      }
    } else if (action === "model") {
      const current = getTerminalModel(chatId) ?? "default";
      const kb = new InlineKeyboard()
        .text("Sonnet 4.6", "cc:setmodel:claude-sonnet-4-6").text("Opus 4.6", "cc:setmodel:claude-opus-4-6").row()
        .text("Haiku 4.5", "cc:setmodel:claude-haiku-4-5-20251001").row()
        .text("Default", "cc:setmodel:__default__").row()
        .text("⬅ Back", "cc:back");
      await gc.editMessageText(`Current model: ${current}\n\nSelect model:`, { reply_markup: kb });
    } else if (action.startsWith("setmodel:")) {
      const model = action.slice("setmodel:".length);
      if (model === "__default__") {
        setTerminalModel(chatId, undefined);
        await gc.editMessageText("Model reset to default.");
      } else {
        setTerminalModel(chatId, model);
        await gc.editMessageText(`Model set to: ${model}`);
      }
    } else if (action.startsWith("effort:")) {
      const level = action.slice("effort:".length);
      setTerminalSetting(chatId, "effort", level);
      await gc.editMessageText(`Effort set to: ${level}`);
    } else if (action === "back") {
      if (hasTerminal(chatId)) {
        const model = getTerminalModel(chatId) ?? "default";
        const kb = new InlineKeyboard()
          .text("New Session", "cc:new").text("Stop", "cc:stop").row()
          .text("Model", "cc:model").text("Sessions", "cc:sessions").row()
          .text("Work Dir", "cc:workdir");
        await gc.editMessageText(`Claude Code active (${model})`, { reply_markup: kb });
      } else {
        const kb = new InlineKeyboard()
          .text("Start", "cc:start").text("Resume Session", "cc:sessions").row()
          .text("Work Dir", "cc:workdir");
        await gc.editMessageText("Claude Code", { reply_markup: kb });
      }
    } else if (action.startsWith("resume:")) {
      const sessionId = action.slice("resume:".length);
      ccPaused.delete(chatId);
      startTerminal(chatId, ccResolveWorkDir(ctx), sessionId);
      await setCommandMenu(ctx, true, chatId);
      await ccPinStatus(ctx, chatId, true);
      await gc.editMessageText(`Resumed session ${sessionId.slice(0, 8)}... Send messages.`);
    }
  });
}
