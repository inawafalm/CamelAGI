// Admin bot: agent management — list, create, delete, edit, clone, soul

import { Bot, InlineKeyboard } from "grammy";
import fs from "node:fs";
import path from "node:path";
import { saveConfig, type Config } from "../core/config.js";
import { agentMemoryDir } from "../workspace.js";
import { getActiveBotIds, startBot, stopBot } from "../telegram.js";
import type { BotState } from "./types.js";
import { startWizard } from "./wizard.js";
import type { WizardDef } from "./wizard.js";
import { createNewAgentWizard, createCloneWizard } from "./wizards.js";
import { resolvePreset } from "../core/models.js";
import { approveRequest, denyRequest } from "../extensions/pairing.js";
import { notifyUserApproved, notifyUserOfDenial } from "./pairing-notify.js";
import { approveBotApproval, denyBotApproval } from "../extensions/bot-approval.js";

// ─── Helpers ────────────────────────────────────────────────────────

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
  const kb = new InlineKeyboard().text("Edit", `picksoul:edit:${targetId}`);
  await bot.api.sendMessage(chatId, `SOUL.md (${targetId}):\n\n${preview}`, { reply_markup: kb });
}

async function showAgentConfig(chatId: number, agentIdParam: string, config: Config, bot: Bot): Promise<void> {
  const agent = config.agents[agentIdParam];
  if (!agent) return;

  const model = agent.model ?? config.model;
  const thinking = agent.thinking ?? config.thinking;
  const effort = agent.effort ?? config.effort;
  const maxTurns = agent.maxTurns ?? config.maxTurns;
  const mcpCount = agent.mcp ? Object.keys(agent.mcp.servers).length : 0;
  const runningBots = getActiveBotIds();
  const running = runningBots.includes(agentIdParam);
  const statusIcon = running ? "🟢" : agent.telegram?.botToken ? "🔴" : "⚪";
  const briefMode = agent.telegram?.briefMode ?? true;

  const lines = [
    `${statusIcon} ${agent.name} (${agentIdParam})\n`,
    `Model: ${model}`, `Thinking: ${thinking}`, `Effort: ${effort}`,
    `Max Turns: ${maxTurns}`, `Brief: ${briefMode ? "on" : "off"}`,
    mcpCount > 0 ? `MCP: ${mcpCount} server${mcpCount > 1 ? "s" : ""}` : `MCP: none`,
  ];

  const kb = new InlineKeyboard()
    .text("Model", `ae:model:${agentIdParam}`)
    .text("Thinking", `ae:think:${agentIdParam}`)
    .text("Effort", `ae:effort:${agentIdParam}`)
    .row()
    .text("Max Turns", `ae:turns:${agentIdParam}`)
    .text(`Brief: ${briefMode ? "on" : "off"}`, `ae:brief:${agentIdParam}`)
    .text("Clone", `ae:clone:${agentIdParam}`);

  await bot.api.sendMessage(chatId, lines.join("\n"), { reply_markup: kb });
}

// ─── Registration ───────────────────────────────────────────────────

export function registerAdminAgents(
  b: Bot,
  agentId: string,
  getConfig: () => Config,
  getSystemPrompt: () => string,
  activeBots: Map<string, BotState>,
): void {

  // ─── Agent list ─────────────────────────────────────────────────

  b.command("agents", async (ctx) => {
    const config = getConfig();
    const entries = Object.entries(config.agents);
    if (entries.length === 0) { await ctx.reply("No agents configured.\n\nUse /newagent to create one."); return; }

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
      if (running && username) lines.push(`   @${username}`);
      else if (a.telegram?.botToken && !running) lines.push(`   Telegram: stopped`);
      else if (!a.telegram?.botToken && !a.admin) lines.push(`   No channel configured`);
      lines.push("");
      if (running && username && !a.admin) {
        kb.url(`💬 ${a.name}`, `https://t.me/${username}`);
        hasButtons = true;
      }
    }

    lines.push("Use /agent <id> to view/edit config");
    if (hasButtons) kb.row();
    kb.text("➕ New agent", "agents:newagent");

    const stoppedAgents = entries.filter(([id, a]) => !runningBots.includes(id) && a.telegram?.botToken && !a.admin);
    if (stoppedAgents.length > 0) kb.text("🔄 Restart stopped", "agents:restart");

    await ctx.reply(lines.join("\n"), { reply_markup: kb });
  });

  b.callbackQuery("agents:newagent", async (ctx) => {
    await ctx.answerCallbackQuery();
    const config = getConfig();
    if (!config.apiKey) { await ctx.reply("No API key configured. Run /setup first."); return; }
    await startWizard(ctx.chat!.id, createNewAgentWizard(getConfig, getSystemPrompt), b);
  });

  b.callbackQuery("agents:restart", async (ctx) => {
    await ctx.answerCallbackQuery();
    const config = getConfig();
    const restarted: string[] = [];
    for (const [id, a] of Object.entries(config.agents)) {
      if (a.admin || !a.telegram?.botToken) continue;
      if (getActiveBotIds().includes(id)) continue;
      try {
        const sysPrompt = getSystemPrompt();
        await startBot(id, a.telegram.botToken, getConfig, () => sysPrompt);
        restarted.push(id);
      } catch { /* skip */ }
    }
    await ctx.reply(restarted.length > 0 ? `Restarted: ${restarted.join(", ")}` : "No stopped bots to restart.");
  });

  // ─── Delete agent ─────────────────────────────────────────────────

  b.command("deleteagent", async (ctx) => {
    const config = getConfig();
    const deletable = Object.entries(config.agents).filter(([, a]) => !a.admin);
    if (deletable.length === 0) { await ctx.reply("No agents to delete."); return; }
    const kb = new InlineKeyboard();
    for (const [id, a] of deletable) kb.text(`${a.name}`, `pickdelete:${id}`).row();
    await ctx.reply("Which agent do you want to delete?", { reply_markup: kb });
  });

  b.callbackQuery(/^pickdelete:(.+)$/, async (ctx) => {
    const id = ctx.callbackQuery.data.match(/^pickdelete:(.+)$/)?.[1];
    if (!id) return;
    await ctx.answerCallbackQuery();
    const config = getConfig();
    if (!config.agents[id]) { try { await ctx.editMessageText("Agent not found."); } catch {} return; }
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
    try { await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ""}\n\n-> ${action === "delete" ? "Deleting..." : "Cancelled"}`); } catch {}
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

  // ─── Soul ─────────────────────────────────────────────────────────

  b.command("soul", async (ctx) => {
    const args = (ctx.match ?? "").trim().split(/\s+/);
    const targetId = args[0];
    const action = args[1];

    if (!targetId) {
      const config = getConfig();
      const entries = Object.entries(config.agents);
      if (entries.length === 0) { await ctx.reply("No agents. Use /newagent first."); return; }
      const kb = new InlineKeyboard();
      for (const [id, a] of entries) kb.text(`${a.name}`, `picksoul:view:${id}`).row();
      await ctx.reply("Which agent's SOUL.md?", { reply_markup: kb });
      return;
    }

    const config = getConfig();
    if (!config.agents[targetId]) { await ctx.reply(`Agent "${targetId}" not found.`); return; }
    await showSoul(ctx.chat.id, targetId, action === "edit", b);
  });

  b.callbackQuery(/^picksoul:(.+):(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^picksoul:(.+):(.+)$/);
    if (!match) return;
    const [, action, id] = match;
    await ctx.answerCallbackQuery();
    try { await ctx.editMessageText(`-> ${id}`); } catch {}
    await showSoul(ctx.chat!.id, id, action === "edit", b);
  });

  // ─── Agent config editing ─────────────────────────────────────────

  b.command("agent", async (ctx) => {
    const targetId = (ctx.match ?? "").trim();
    const config = getConfig();

    if (!targetId) {
      const entries = Object.entries(config.agents);
      if (entries.length === 0) { await ctx.reply("No agents. Use /newagent first."); return; }
      const kb = new InlineKeyboard();
      for (const [id, a] of entries) kb.text(a.name, `ae:show:${id}`).row();
      await ctx.reply("Which agent to view/edit?", { reply_markup: kb });
      return;
    }

    if (!config.agents[targetId]) { await ctx.reply(`Agent "${targetId}" not found.`); return; }
    await showAgentConfig(ctx.chat.id, targetId, config, b);
  });

  b.callbackQuery(/^ae:show:(.+)$/, async (ctx) => {
    const agentIdParam = ctx.callbackQuery.data.match(/^ae:show:(.+)$/)?.[1];
    if (!agentIdParam) return;
    await ctx.answerCallbackQuery();
    await showAgentConfig(ctx.chat!.id, agentIdParam, getConfig(), b);
  });

  b.callbackQuery(/^ae:think:(.+)$/, async (ctx) => {
    const agentIdParam = ctx.callbackQuery.data.match(/^ae:think:(.+)$/)?.[1];
    if (!agentIdParam) return;
    await ctx.answerCallbackQuery();
    const config = getConfig();
    const current = config.agents[agentIdParam]?.thinking ?? config.thinking;
    const levels = ["off", "low", "medium", "high"];
    const kb = new InlineKeyboard();
    for (const l of levels) kb.text(l === current ? `✓ ${l}` : l, `as:${agentIdParam}:think:${l}`);
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
    for (const l of levels) kb.text(l === current ? `✓ ${l}` : l, `as:${agentIdParam}:effort:${l}`);
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
    for (const n of options) kb.text(n === current ? `✓ ${n}` : String(n), `as:${agentIdParam}:turns:${n}`);
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
      steps: [{ id: "model", prompt: `Type the model name for "${agentIdParam}":` }],
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
    if (!agent?.telegram) { await ctx.reply("Agent has no Telegram config."); return; }
    const current = agent.telegram.briefMode ?? true;
    const next = !current;
    const agents = { ...config.agents };
    agents[agentIdParam] = { ...agents[agentIdParam], telegram: { ...agents[agentIdParam].telegram!, briefMode: next } } as typeof agents[string];
    saveConfig({ agents });
    try { await ctx.editMessageText(`Brief mode: ${next ? "on" : "off"} ✓`); }
    catch { await ctx.reply(`Brief mode: ${next ? "on" : "off"} ✓`); }
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

  // Generic agent setting apply (think, effort, turns, model)
  b.callbackQuery(/^as:(.+?):(.+?):(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^as:(.+?):(.+?):(.+)$/);
    if (!match) return;
    const [, agentIdParam, field, value] = match;
    await ctx.answerCallbackQuery();
    const config = getConfig();
    if (!config.agents[agentIdParam]) { await ctx.reply("Agent not found."); return; }

    const agents = { ...config.agents };
    const agent = { ...agents[agentIdParam] };
    const fieldLabels: Record<string, string> = { think: "Thinking", effort: "Effort", turns: "Max Turns", model: "Model" };

    if (field === "think") (agent as Record<string, unknown>).thinking = value;
    else if (field === "effort") (agent as Record<string, unknown>).effort = value;
    else if (field === "turns") (agent as Record<string, unknown>).maxTurns = parseInt(value, 10);
    else if (field === "model") (agent as Record<string, unknown>).model = value;

    agents[agentIdParam] = agent;
    saveConfig({ agents });
    const label = fieldLabels[field] ?? field;
    try { await ctx.editMessageText(`${label} set to: ${value} ✓`); }
    catch { await ctx.reply(`${label} set to: ${value} ✓`); }
  });

  // ─── Pairing & bot approval callbacks ─────────────────────────────

  b.callbackQuery(/^pairing:(approve|deny):(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^pairing:(approve|deny):(.+)$/);
    if (!match) return;
    const [, action, code] = match;
    if (action === "approve") {
      const request = approveRequest(code);
      if (request) {
        try { await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ""}\n\n-> Approved`); } catch {}
        await notifyUserApproved(request, activeBots);
      } else {
        try { await ctx.editMessageText("Request expired or already handled."); } catch {}
      }
    } else {
      const request = denyRequest(code);
      if (request) {
        try { await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ""}\n\n-> Denied`); } catch {}
        await notifyUserOfDenial(request, activeBots);
      } else {
        try { await ctx.editMessageText("Request expired or already handled."); } catch {}
      }
    }
    await ctx.answerCallbackQuery();
  });

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
          const errMsg = err instanceof Error ? err.message : String(err);
          if (!errMsg.includes("already running") && !errMsg.includes("already starting")) {
            try { await ctx.editMessageText(`Failed to start bot: ${errMsg}`); } catch {}
            await ctx.answerCallbackQuery();
            return;
          }
        }
        try { await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ""}\n\n-> Approved. ${botLabel} is now running.`); } catch {}
      } else {
        try { await ctx.editMessageText("Approval not found or already handled."); } catch {}
      }
    } else {
      const approval = denyBotApproval(agentIdParam);
      if (approval) {
        try { await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ""}\n\n-> Denied. Bot will not start.`); } catch {}
      } else {
        try { await ctx.editMessageText("Approval not found or already handled."); } catch {}
      }
    }
    await ctx.answerCallbackQuery();
  });
}
