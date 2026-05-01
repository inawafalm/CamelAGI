// Gateway REST API routes

import type { Express, Request, Response, NextFunction } from "express";
import { loadConfig, saveConfig } from "../core/config.js";
import { createClient } from "../model.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { agentMemoryDir, seedAgentWorkspace } from "../workspace.js";
import { loadMessages, listSessions, deleteSession, getSessionMeta } from "../session.js";
import type { SdkTag } from "../session.js";
import { getActiveRunCount } from "../runtime/runs.js";
import { getLaneStats } from "../runtime/lanes.js";
import { orchestrate } from "../runtime/orchestrate.js";
import { errorMessage } from "../core/errors.js";
import { submitDecision, type ApprovalDecision } from "../extensions/approvals.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { listPendingRequests, approveRequest, denyRequest } from "../extensions/pairing.js";
import { listPendingBotApprovals, approveBotApproval, denyBotApproval } from "../extensions/bot-approval.js";
import { notifyUserApproved, notifyUserOfDenial } from "../telegram/pairing-notify.js";
import type { GatewayState } from "./state.js";
import { checkAuth, logMessage } from "./state.js";

/** Express middleware that rejects unauthenticated requests with 401 */
function requireAuth(state: GatewayState) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!checkAuth(state, req.headers.authorization)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}

export function registerRoutes(app: Express, state: GatewayState): void {
  app.get("/health", (req, res) => {
    // When token is configured but request is unauthenticated, return minimal response
    if (state.token && !checkAuth(state, req.headers.authorization)) {
      res.json({ status: "ok" });
      return;
    }
    res.json({
      status: "ok",
      uptime: Math.floor((Date.now() - state.startTime) / 1000),
      sessions: listSessions().length,
      clients: state.clients.size,
      activeRuns: getActiveRunCount(),
      lanes: getLaneStats(),
      tailscaleUrl: state.tailscaleUrl ?? null,
    });
  });

  const auth = requireAuth(state);

  app.post("/chat", auth, async (req, res) => {
    const { message, session, sdk } = req.body;
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const sid = session ?? `http-${Date.now()}`;
    logMessage(state, "http", "in", sid, message);

    try {
      const result = await orchestrate({
        sessionId: sid,
        message,
        config: state.config,
        systemPrompt: state.systemPrompt,
        client: state.client,
        sdk: sdk as SdkTag | undefined,
      });

      if (result.response) {
        logMessage(state, "http", "out", sid, result.response);
      }
      res.json({ response: result.response, session: sid, sdk: result.sdk });
    } catch (err: unknown) {
      logMessage(state, "http", "out", sid, `ERROR: ${errorMessage(err)}`);
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // Sessions
  app.get("/sessions", auth, (_req, res) => {
    res.json(listSessions());
  });

  app.get("/sessions/:id/messages", auth, (req, res) => {
    const messages = loadMessages(req.params.id);
    res.json(messages.map((m) => ({ role: m.role, content: m.content })));
  });

  app.delete("/sessions/:id", auth, (req, res) => {
    deleteSession(req.params.id);
    res.json({ ok: true });
  });

  // Agents
  app.get("/agents", auth, async (_req, res) => {
    let runningIds: string[] = [];
    try {
      const { getAllChannels } = await import("../channels/registry.js");
      runningIds = getAllChannels().flatMap(c => c.getActiveAgentIds());
    } catch { /* channels may not be loaded */ }
    const agents = Object.entries(state.config.agents).map(([id, a]) => ({
      id,
      name: a.name,
      admin: a.admin ?? false,
      model: a.model ?? state.config.model,
      telegram: !!a.telegram?.botToken,
      running: runningIds.includes(id),
      dir: agentMemoryDir(id),
    }));
    res.json(agents);
  });

  app.post("/agents", auth, (req, res) => {
    const { id, name, model, description, telegramToken, allowedUsers } = req.body;
    if (!id || !name) { res.status(400).json({ error: "id and name are required" }); return; }
    if (state.config.agents[id]) { res.status(409).json({ error: `Agent "${id}" already exists` }); return; }

    seedAgentWorkspace(id, name, description);
    const agentConfig: Record<string, unknown> = { name };
    if (model && model !== state.config.model) agentConfig.model = model;
    if (telegramToken) {
      agentConfig.telegram = { botToken: telegramToken, allowedUsers: allowedUsers ?? [] };
    }
    const agents = { ...state.config.agents, [id]: agentConfig };
    saveConfig({ agents });
    state.config = loadConfig();
    res.status(201).json({ id, name, dir: agentMemoryDir(id) });
  });

  app.delete("/agents/:id", auth, (req, res) => {
    const { id } = req.params;
    if (!state.config.agents[id]) { res.status(404).json({ error: `Agent "${id}" not found` }); return; }
    const agents = { ...state.config.agents };
    delete agents[id];
    saveConfig({ agents });
    state.config = loadConfig();
    res.json({ ok: true });
  });

  // SOUL.md
  app.get("/agents/:id/soul", auth, (req, res) => {
    const { id } = req.params;
    if (!state.config.agents[id]) { res.status(404).json({ error: `Agent "${id}" not found` }); return; }
    const soulPath = path.join(agentMemoryDir(id), "SOUL.md");
    if (!fs.existsSync(soulPath)) { res.json({ content: "" }); return; }
    res.json({ content: fs.readFileSync(soulPath, "utf-8") });
  });

  app.put("/agents/:id/soul", auth, (req, res) => {
    const { id } = req.params;
    if (!state.config.agents[id]) { res.status(404).json({ error: `Agent "${id}" not found` }); return; }
    const { content } = req.body;
    if (typeof content !== "string") { res.status(400).json({ error: "content is required" }); return; }
    const dir = agentMemoryDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SOUL.md"), content);
    res.json({ ok: true });
  });

  // Config
  app.get("/config", auth, (_req, res) => {
    const safe = {
      ...state.config,
      apiKey: state.config.apiKey ? `***${state.config.apiKey.slice(-4)}` : undefined,
      cursorApiKey: state.config.cursorApiKey ? `***${state.config.cursorApiKey.slice(-4)}` : undefined,
    };
    res.json(safe);
  });

  app.patch("/config", auth, (req, res) => {
    const updates = req.body;
    if (!updates || typeof updates !== "object") { res.status(400).json({ error: "JSON body required" }); return; }
    delete updates.apiKey;
    delete updates.cursorApiKey;
    delete updates.serve;
    saveConfig(updates);
    state.config = loadConfig();
    state.client = createClient(state.config);
    state.systemPrompt = buildSystemPrompt(state.config.systemPrompt, state.config.skills);
    res.json({ ok: true });
  });

  // Pairing
  app.get("/pairing", auth, (_req, res) => {
    res.json(listPendingRequests());
  });

  app.post("/pairing/:code/approve", auth, async (req, res) => {
    const request = approveRequest(req.params.code);
    if (request) {
      res.json({ ok: true, userId: request.userId, agentId: request.agentId });
      // Notify the Telegram user they've been approved
      try {
        const { getActiveBots } = await import("../telegram.js");
        await notifyUserApproved(request, getActiveBots());
      } catch { /* telegram may not be running */ }
    } else {
      res.status(404).json({ error: "Request not found or expired" });
    }
  });

  app.post("/pairing/:code/deny", auth, async (req, res) => {
    const request = denyRequest(req.params.code);
    if (request) {
      res.json({ ok: true });
      // Notify the Telegram user of denial
      try {
        const { getActiveBots } = await import("../telegram.js");
        await notifyUserOfDenial(request, getActiveBots());
      } catch { /* telegram may not be running */ }
    } else {
      res.status(404).json({ error: "Request not found or expired" });
    }
  });

  // Bot approvals
  app.get("/bot-approvals", auth, (_req, res) => {
    res.json(listPendingBotApprovals());
  });

  app.post("/bot-approvals/:agentId/approve", auth, async (req, res) => {
    const approval = approveBotApproval(req.params.agentId);
    if (!approval) { res.status(404).json({ error: "Approval not found" }); return; }

    try {
      const { startBot } = await import("../telegram.js");
      await startBot(approval.agentId, approval.botToken, () => state.config, () => state.systemPrompt);
      res.json({ ok: true, agentId: approval.agentId, botUsername: approval.botUsername });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.post("/bot-approvals/:agentId/deny", auth, (req, res) => {
    const approval = denyBotApproval(req.params.agentId);
    if (approval) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: "Approval not found" });
    }
  });

  // Approvals
  app.post("/approvals/:id/decide", auth, (req, res) => {
    const { id } = req.params;
    const { decision } = req.body;
    if (!decision) { res.status(400).json({ error: "decision is required (allow-once, allow-always, deny)" }); return; }
    const resolved = submitDecision(id, decision as ApprovalDecision);
    res.json({ ok: resolved });
  });

  // ─── Agent workspace files ──────────────────────────────────────
  app.get("/agents/:id/workspace/:file", auth, (req, res) => {
    const { id, file } = req.params;
    const allowed = ["SOUL.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md"];
    if (!allowed.includes(file)) return res.status(400).json({ error: "Invalid file" });
    const filePath = path.join(agentMemoryDir(id), file);
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
    res.json({ content });
  });

  app.put("/agents/:id/workspace/:file", auth, (req, res) => {
    const { id, file } = req.params;
    const allowed = ["SOUL.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md"];
    if (!allowed.includes(file)) return res.status(400).json({ error: "Invalid file" });
    const { content } = req.body;
    if (typeof content !== "string") return res.status(400).json({ error: "content required" });
    const filePath = path.join(agentMemoryDir(id), file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    res.json({ ok: true });
  });

  // Agent memory notes list
  app.get("/agents/:id/memory", auth, (req, res) => {
    const memDir = path.join(agentMemoryDir(req.params.id), "memory");
    if (!fs.existsSync(memDir)) return res.json([]);
    const files = fs.readdirSync(memDir).filter(f => f.endsWith(".md")).sort().reverse();
    const notes = files.map(f => ({
      name: f,
      content: fs.readFileSync(path.join(memDir, f), "utf-8"),
      size: fs.statSync(path.join(memDir, f)).size,
    }));
    res.json(notes);
  });

  // ─── Cron jobs ──────────────────────────────────────────────────
  app.get("/cron", auth, async (_req, res) => {
    const { getAllJobStatuses } = await import("../extensions/cron.js");
    res.json(getAllJobStatuses());
  });

  // ─── Usage ──────────────────────────────────────────────────────
  app.get("/usage/:sessionId", auth, async (req, res) => {
    const { getSessionUsage } = await import("../usage.js");
    const usage = getSessionUsage(req.params.sessionId);
    res.json(usage);
  });

  // ─── Skills ─────────────────────────────────────────────────────
  app.get("/skills", auth, async (_req, res) => {
    const { listSkillNames } = await import("../extensions/skills.js");
    const skills = listSkillNames();
    res.json(skills);
  });

  // ─── Export ─────────────────────────────────────────────────────
  app.get("/sessions/:id/export", auth, (req, res) => {
    const messages = loadMessages(req.params.id);
    const lines = messages.map(m => {
      const prefix = m.role === "user" ? "**You:**" : m.role === "assistant" ? "**Assistant:**" : `**${m.role}:**`;
      return `${prefix}\n\n${m.content}\n\n---\n`;
    });
    const md = `# Session: ${req.params.id}\n\n${lines.join("\n")}`;
    res.setHeader("Content-Type", "text/markdown");
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}.md"`);
    res.send(md);
  });

  // ─── MCP servers ────────────────────────────────────────────────
  app.get("/mcp", auth, (_req, res) => {
    const config = state.config;
    const global = config.mcp?.servers ?? {};
    const perAgent: Record<string, Record<string, unknown>> = {};
    for (const [id, agent] of Object.entries(config.agents)) {
      if (agent.mcp?.servers && Object.keys(agent.mcp.servers).length > 0) {
        perAgent[id] = agent.mcp.servers as Record<string, unknown>;
      }
    }
    res.json({ global, perAgent });
  });

  // ─── Clone agent ────────────────────────────────────────────────
  app.post("/agents/:id/clone", auth, async (req, res) => {
    const sourceId = req.params.id;
    const { newId, newName } = req.body;
    if (!newId || !newName) return res.status(400).json({ error: "newId and newName required" });

    const config = state.config;
    const source = config.agents[sourceId];
    if (!source) return res.status(404).json({ error: "Source agent not found" });
    if (config.agents[newId]) return res.status(409).json({ error: "Agent ID already exists" });

    // Clone config (without telegram token)
    const cloned: Record<string, unknown> = { ...source, name: newName };
    delete (cloned as any).telegram;
    delete (cloned as any).admin;

    const agents = { ...config.agents, [newId]: cloned };
    const { saveConfig: save } = await import("../core/config.js");
    save({ agents });

    // Clone workspace files
    seedAgentWorkspace(newId, newName);
    const sourceDir = agentMemoryDir(sourceId);
    const destDir = agentMemoryDir(newId);
    for (const file of ["SOUL.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md"]) {
      const src = path.join(sourceDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(destDir, file));
      }
    }

    res.status(201).json({ id: newId, name: newName });
  });

  // ─── Channel status ─────────────────────────────────────────────
  app.get("/channels", auth, (_req, res) => {
    const config = state.config;
    const channels: { id: string; name: string; type: string; running: boolean; username?: string }[] = [];

    for (const [id, agent] of Object.entries(config.agents)) {
      if (agent.telegram?.botToken) {
        channels.push({ id, name: agent.name, type: "telegram", running: true });
      }
      if (agent.discord?.botToken) {
        channels.push({ id, name: agent.name, type: "discord", running: true });
      }
    }

    res.json(channels);
  });

  // ─── Logs ───────────────────────────────────────────────────────
  app.get("/logs", auth, (req, res) => {
    const logDir = path.join(os.homedir(), ".camelagi", "logs");
    const logFile = path.join(logDir, "requests.log");
    if (!fs.existsSync(logFile)) return res.json([]);

    const content = fs.readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean).slice(-100);
    res.json(lines);
  });

  // ─── Models ─────────────────────────────────────────────────────
  app.get("/models", auth, async (_req, res) => {
    const { resolvePreset, fetchOpenRouterModels } = await import("../core/models.js");
    const preset = resolvePreset(state.config.provider, state.config.baseUrl);
    let models = [...preset.models];

    if (state.config.baseUrl?.includes("openrouter") && state.config.apiKey) {
      const live = await fetchOpenRouterModels(state.config.apiKey);
      if (live.length > 0) {
        const presetSet = new Set(preset.models);
        const rest = live.map(m => m.id).filter(id => !presetSet.has(id));
        models = [...preset.models, ...rest];
      }
    }

    res.json(models);
  });

  // ─── Pending approvals list ─────────────────────────────────────
  app.get("/approvals/pending", auth, async (_req, res) => {
    try {
      const { pendingCount } = await import("../extensions/approvals.js");
      res.json({ count: pendingCount() });
    } catch {
      res.json({ count: 0 });
    }
  });
}
