// TUI slash commands + agent creation wizard

import { loadConfig, saveConfig } from "../core/config.js";
import { seedAgentWorkspace, agentMemoryDir } from "../workspace.js";
import { getContextReport } from "../system-prompt.js";
import { loadMessages, listSessions } from "../session.js";
import { listSkillNames } from "../extensions/skills.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildWelcomeScreen } from "./components/welcome.js";
import type { TuiCtx } from "./context.js";

export async function handleCommand(ctx: TuiCtx, input: string): Promise<void> {
  const { state, chatLog, tui, ws, wsSend, setActivity, updateHeader, updateFooter, editor } = ctx;
  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help":
      chatLog.addSystem(
        [
          "Commands:",
          "  /model <name>    — switch model (or Ctrl+L to pick)",
          "  /model           — show current model",
          "  /config          — show current configuration",
          "  /sessions        — list sessions (or Ctrl+P to pick)",
          "  /session <name>  — switch to a session",
          "  /new             — start a new session",
          "  /clear           — clear chat history",
          "  /tools           — toggle tool output expand/collapse",
          "  /skills          — list active skills",
          "  /think <level>   — set thinking (off|low|medium|high)",
          "  /effort <level>  — set effort (low|medium|high|max)",
          "  /context         — show context breakdown (files, tokens)",
          "  /status          — show session status",
          "  /compact         — force context compaction",
          "  /agents          — list agents",
          "  /agents add      — create a new agent (interactive)",
          "  /agents rm <id>  — remove an agent",
          "  /soul [id]       — view agent's SOUL.md",
          "  /soul <id> edit  — open SOUL.md in $EDITOR",
          "  /cursor          — switch to Cursor SDK runtime",
          "  /claude          — switch to Claude SDK runtime",
          "  /setup           — run setup wizard (exits TUI)",
          "  /exit, /quit     — exit",
          "  !<command>       — run a shell command",
          "",
          "Shortcuts:",
          "  Ctrl+L   — open model selector",
          "  Ctrl+P   — open session selector",
          "  Ctrl+O   — toggle tool output",
          "  Escape   — abort current request",
          "  Ctrl+C   — clear input / double-tap to exit",
          "  Ctrl+D   — exit",
        ].join("\n"),
      );
      tui.requestRender();
      break;

    case "model":
      if (!arg) {
        ctx.openModelSelector();
        return;
      }
      wsSend({ type: "model.switch", model: arg, thinking: state.currentThinking });
      saveConfig({ model: arg });
      state.config = loadConfig();
      state.currentModel = arg;
      chatLog.addSystem(`Switching to ${arg}...`);
      updateHeader();
      updateFooter();
      tui.requestRender();
      break;

    case "config":
      chatLog.addSystem(
        [
          `provider: ${state.config.provider}`,
          `model:    ${state.currentModel}`,
          `sdk:      ${state.currentSdk}`,
          state.config.baseUrl ? `baseUrl:  ${state.config.baseUrl}` : null,
          `apiKey:   ${state.config.apiKey ? "***" + state.config.apiKey.slice(-4) : "not set"}`,
          `session:  ${state.sid}`,
        ].filter(Boolean).join("\n"),
      );
      tui.requestRender();
      break;

    case "sessions":
      ctx.openSessionSelector();
      break;

    case "session":
      if (!arg) {
        ctx.openSessionSelector();
        return;
      }
      state.sid = arg;
      state.sdkSessionId = undefined;
      state.messages = loadMessages(state.sid);
      chatLog.clearAll();
      if (state.messages.length > 0) {
        for (const m of state.messages) {
          if (m.role === "user") chatLog.addUser(m.content);
          else if (m.role === "assistant") chatLog.finalizeAssistant(m.content);
        }
      }
      chatLog.addSystem(`Switched to session: ${state.sid}`);
      updateHeader();
      updateFooter();
      tui.requestRender();
      break;

    case "new": {
      state.sid = `session-${Date.now()}`;
      state.messages = [];
      state.sdkSessionId = undefined;
      chatLog.clearAll();
      const newSessions = listSessions();
      const newWelcome = buildWelcomeScreen({
        version: "0.5.0",
        userName: process.env.USER ?? process.env.USERNAME,
        model: state.currentModel,
        effort: state.config.effort,
        provider: state.config.provider,
        cwd: process.cwd(),
        sessions: newSessions,
        thinking: state.currentThinking,
      }, process.stdout.columns ?? 120);
      chatLog.addChild(newWelcome);
      ctx.updateHint();
      tui.requestRender();
      break;
    }

    case "clear":
      state.messages = [];
      state.sdkSessionId = undefined;
      chatLog.clearAll();
      chatLog.addSystem("History cleared.");
      tui.requestRender();
      break;

    case "tools":
      state.toolsExpanded = !state.toolsExpanded;
      chatLog.setToolsExpanded(state.toolsExpanded);
      setActivity(state.toolsExpanded ? "tools expanded" : "tools collapsed");
      break;

    case "skills": {
      const skills = listSkillNames();
      if (skills.length === 0) {
        chatLog.addSystem("No skills installed. Add skills to ~/.camelagi/skills/");
      } else {
        chatLog.addSystem(`Active skills: ${skills.join(", ")}`);
      }
      tui.requestRender();
      break;
    }

    case "think": {
      const levels = ["off", "low", "medium", "high"] as const;
      const level = arg as typeof levels[number];
      if (!arg) {
        chatLog.addSystem(`Thinking: ${state.currentThinking}. Usage: /think off|low|medium|high`);
        tui.requestRender();
        break;
      }
      if (!levels.includes(level)) {
        chatLog.addSystem(`Invalid level. Use: off, low, medium, high`);
        tui.requestRender();
        break;
      }
      state.currentThinking = level;
      saveConfig({ thinking: level });
      state.config = loadConfig();
      wsSend({ type: "model.switch", model: state.currentModel, thinking: level });
      chatLog.addSystem(`Thinking set to: ${level}`);
      updateHeader();
      tui.requestRender();
      break;
    }

    case "effort": {
      const levels = ["low", "medium", "high", "max"] as const;
      const level = arg as typeof levels[number];
      if (!arg) {
        chatLog.addSystem(`Effort: ${state.currentEffort}. Usage: /effort low|medium|high|max`);
        tui.requestRender();
        break;
      }
      if (!levels.includes(level)) {
        chatLog.addSystem(`Invalid level. Use: low, medium, high, max`);
        tui.requestRender();
        break;
      }
      state.currentEffort = level;
      saveConfig({ effort: level });
      state.config = loadConfig();
      wsSend({ type: "model.switch", model: state.currentModel, thinking: state.currentThinking, effort: level });
      chatLog.addSystem(`Effort set to: ${level}`);
      updateHeader();
      tui.requestRender();
      break;
    }

    case "context": {
      const report = getContextReport(state.systemPrompt);
      const lines = [
        `Context breakdown`,
        `  Workspace: ${report.workspace}`,
        `  Bootstrap max/file: ${report.bootstrapMaxPerFile.toLocaleString()} chars`,
        `  System prompt: ${report.systemPromptChars.toLocaleString()} chars (~${report.systemPromptTokens.toLocaleString()} tok)`,
        ``,
        `Injected workspace files:`,
      ];
      for (const f of report.files) {
        if (f.status === "MISSING") {
          lines.push(`  - ${f.name}: MISSING`);
        } else {
          lines.push(
            `  - ${f.name}: ${f.status} | raw ${f.rawChars.toLocaleString()} chars (~${f.rawTokens.toLocaleString()} tok) | injected ${f.injectedChars.toLocaleString()} chars (~${f.injectedTokens.toLocaleString()} tok)`,
          );
        }
      }
      lines.push(``);
      lines.push(`Skills: ${report.skillCount}`);
      lines.push(`Tools: ${report.toolCount}`);
      lines.push(`Session messages: ${state.messages.length}`);
      const historyChars = state.messages.reduce((sum, m) => sum + m.content.length, 0);
      lines.push(`Session history: ~${Math.ceil(historyChars / 4).toLocaleString()} tok`);
      chatLog.addSystem(lines.join("\n"));
      tui.requestRender();
      break;
    }

    case "status":
      wsSend({ type: "status", session: state.sid });
      break;

    case "compact":
      setActivity("compacting...");
      tui.requestRender();
      wsSend({ type: "compact", session: state.sid });
      setActivity("idle");
      break;

    case "agents": {
      if (arg === "add") {
        state.agentCreation = { step: "id", data: {} };
        chatLog.addSystem(
          "Creating a new agent. Type /cancel to abort.\n\nAgent ID (slug, e.g. coder, journal, study):",
        );
        tui.requestRender();
        break;
      }

      if (arg.startsWith("rm ")) {
        const rmId = arg.slice(3).trim();
        if (!rmId) {
          chatLog.addSystem("Usage: /agents rm <id>");
          tui.requestRender();
          break;
        }
        state.config = loadConfig();
        const agents = (state.config as any).agents ?? {};
        if (!agents[rmId]) {
          chatLog.addSystem(`Agent "${rmId}" not found.`);
          tui.requestRender();
          break;
        }
        delete agents[rmId];
        saveConfig({ agents });
        state.config = loadConfig();
        chatLog.addSystem(`Agent "${rmId}" removed. Restart server to take effect.`);
        tui.requestRender();
        break;
      }

      state.config = loadConfig();
      const agentEntries = Object.entries(state.config.agents ?? {});
      if (agentEntries.length === 0) {
        chatLog.addSystem("No agents configured.\n\nUse /agents add to create one.");
      } else {
        const lines = ["Agents:\n"];
        for (const [id, a] of agentEntries) {
          lines.push(`  ${id}`);
          lines.push(`    name:   ${a.name}`);
          if (a.model) lines.push(`    model:  ${a.model}`);
          if (a.systemPrompt) lines.push(`    prompt: ${a.systemPrompt.slice(0, 60)}${a.systemPrompt.length > 60 ? "..." : ""}`);
          if (a.telegram) lines.push(`    telegram: ${a.telegram.botToken ? "configured" : "not set"}`);
          lines.push("");
        }
        lines.push("Use /agents add to create, /agents rm <id> to remove.");
        chatLog.addSystem(lines.join("\n"));
      }
      tui.requestRender();
      break;
    }

    case "soul": {
      state.config = loadConfig();
      const agentEntries2 = Object.entries(state.config.agents ?? {});
      if (agentEntries2.length === 0) {
        chatLog.addSystem("No agents configured. Use /agents add to create one.");
        tui.requestRender();
        break;
      }

      let targetId = arg.split(/\s+/)[0];
      const subAction = arg.split(/\s+/)[1];

      if (!targetId && agentEntries2.length === 1) {
        targetId = agentEntries2[0][0];
      }

      if (!targetId) {
        const lines = ["Agent SOUL.md files:\n"];
        for (const [id] of agentEntries2) {
          const soulPath = path.join(agentMemoryDir(id), "SOUL.md");
          const exists = fs.existsSync(soulPath);
          lines.push(`  ${id}: ${soulPath} ${exists ? "" : "(not created yet)"}`);
        }
        lines.push("\nUsage: /soul <id> — view, /soul <id> edit — open in $EDITOR");
        chatLog.addSystem(lines.join("\n"));
        tui.requestRender();
        break;
      }

      if (!state.config.agents[targetId]) {
        chatLog.addSystem(`Agent "${targetId}" not found. Use /agents to list.`);
        tui.requestRender();
        break;
      }

      const soulPath = path.join(agentMemoryDir(targetId), "SOUL.md");

      if (subAction === "edit") {
        if (!fs.existsSync(soulPath)) {
          seedAgentWorkspace(targetId, state.config.agents[targetId].name);
        }
        const editorCmd = process.env.EDITOR || process.env.VISUAL || "nano";
        tui.stop();
        spawnSync(editorCmd, [soulPath], { stdio: "inherit" });
        tui.start();
        tui.setFocus(editor);
        chatLog.addSystem(`SOUL.md updated for "${targetId}". Restart server to take effect.`);
        tui.requestRender();
        break;
      }

      if (!fs.existsSync(soulPath)) {
        chatLog.addSystem(`No SOUL.md for "${targetId}" yet. Run: /soul ${targetId} edit`);
        tui.requestRender();
        break;
      }

      const soulContent = fs.readFileSync(soulPath, "utf-8").trim();
      chatLog.addSystem(`-- SOUL.md (${targetId}) --\n\n${soulContent}\n\n-- ${soulPath} --\nUse /soul ${targetId} edit to modify.`);
      tui.requestRender();
      break;
    }

    case "cursor":
      state.currentSdk = "cursor";
      chatLog.addSystem("Switched to Cursor SDK. Next message will use Cursor's agent runtime.");
      updateFooter();
      tui.requestRender();
      break;

    case "claude":
      state.currentSdk = "claude";
      chatLog.addSystem("Switched to Claude SDK. Next message will use Claude's agent runtime.");
      updateFooter();
      tui.requestRender();
      break;

    case "cancel":
      if (state.agentCreation) {
        state.agentCreation = null;
        chatLog.addSystem("Agent creation cancelled.");
        tui.requestRender();
      }
      break;

    case "setup":
      tui.stop();
      ws.close();
      const { runSetup } = await import("../setup.js");
      await runSetup();
      process.exit(0);
      break;

    case "exit":
    case "quit":
      tui.stop();
      ws.close();
      process.exit(0);
      break;

    default:
      chatLog.addSystem(`Unknown command: /${cmd}. Type /help for list.`);
      tui.requestRender();
  }
}

/** Handle agent creation wizard step. Returns true if input was consumed. */
export function handleAgentCreation(ctx: TuiCtx, value: string): boolean {
  const { state, chatLog, tui } = ctx;
  if (!state.agentCreation) return false;

  const { step, data } = state.agentCreation;

  switch (step) {
    case "id": {
      const id = value.replace(/[^a-z0-9_-]/gi, "").toLowerCase();
      if (!id) {
        chatLog.addSystem("Invalid ID. Use letters, numbers, dashes, underscores:");
        tui.requestRender();
        return true;
      }
      const existing = loadConfig().agents ?? {};
      if ((existing as any)[id]) {
        chatLog.addSystem(`Agent "${id}" already exists. Choose another ID:`);
        tui.requestRender();
        return true;
      }
      data.id = id;
      state.agentCreation.step = "name";
      chatLog.addSystem(`ID: ${id}\n\nAgent display name (e.g. "Coder", "Journal"):`);
      tui.requestRender();
      return true;
    }
    case "name":
      data.name = value;
      state.agentCreation.step = "model";
      chatLog.addSystem(`Name: ${value}\n\nModel (enter for ${state.config.model}):`);
      tui.requestRender();
      return true;
    case "model":
      data.model = value || state.config.model;
      state.agentCreation.step = "prompt";
      chatLog.addSystem(`Model: ${data.model}\n\nSOUL.md: use default or customize?\nType a one-line description, or press enter for default:`);
      tui.requestRender();
      return true;
    case "prompt":
      data.prompt = value || "";
      state.agentCreation.step = "token";
      if (value) {
        chatLog.addSystem(`Description: ${value.slice(0, 60)}${value.length > 60 ? "..." : ""}\n\nTelegram bot token (from @BotFather, or "skip" to skip):`);
      } else {
        chatLog.addSystem(`Using default SOUL.md\n\nTelegram bot token (from @BotFather, or "skip" to skip):`);
      }
      tui.requestRender();
      return true;
    case "token": {
      const token = value.toLowerCase() === "skip" ? "" : value;
      data.token = token;

      seedAgentWorkspace(data.id, data.name, data.prompt || undefined);

      state.config = loadConfig();
      const agents = { ...(state.config.agents ?? {}) } as Record<string, unknown>;
      const agentConfig: Record<string, unknown> = {
        name: data.name,
        model: data.model !== state.config.model ? data.model : undefined,
      };
      if (token) {
        agentConfig.telegram = {
          botToken: token,
          allowedUsers: state.config.telegram.allowedUsers,
        };
      }
      agents[data.id] = agentConfig;
      saveConfig({ agents });
      state.config = loadConfig();

      const agentDir = agentMemoryDir(data.id);
      const lines = [
        `Agent "${data.id}" created!\n`,
        `  name:   ${data.name}`,
        `  model:  ${data.model}`,
        `  dir:    ${agentDir}`,
        token ? `  telegram: configured` : `  telegram: skipped`,
        "",
        `Files created:`,
        `  ${agentDir}/SOUL.md    — personality & identity (edit this!)`,
        `  ${agentDir}/TOOLS.md   — agent-specific setup notes`,
        `  ${agentDir}/MEMORY.md  — curated memory`,
        `  ${agentDir}/memory/    — daily notes`,
        "",
        "Edit SOUL.md to shape the agent's personality.",
        "Restart the server (camelagi serve) to start the bot.",
      ];
      chatLog.addSystem(lines.join("\n"));
      state.agentCreation = null;
      tui.requestRender();
      return true;
    }
  }
  return false;
}
