// Gateway REST API routes

import type { Express } from "express";
import { loadConfig, saveConfig } from "../core/config.js";
import { createClient } from "../model.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { agentMemoryDir, seedAgentWorkspace } from "../workspace.js";
import { loadMessages, listSessions, deleteSession } from "../session.js";
import { getActiveRunCount } from "../runtime/runs.js";
import { getLaneStats } from "../runtime/lanes.js";
import { orchestrate } from "../runtime/orchestrate.js";
import { errorMessage } from "../core/errors.js";
import { submitDecision, type ApprovalDecision } from "../extensions/approvals.js";
import fs from "node:fs";
import path from "node:path";
import { listPendingRequests, approveRequest, denyRequest } from "../telegram/pairing.js";
import { listPendingBotApprovals, approveBotApproval, denyBotApproval } from "../telegram/bot-approval.js";
import { notifyUserOtpRequired, notifyUserOfDenial } from "../telegram/pairing-notify.js";
import type { GatewayState } from "./state.js";
import { checkAuth, logMessage } from "./state.js";

export function registerRoutes(app: Express, state: GatewayState): void {
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: Math.floor((Date.now() - state.startTime) / 1000),
      sessions: listSessions().length,
      clients: state.clients.size,
      activeRuns: getActiveRunCount(),
      lanes: getLaneStats(),
    });
  });

  app.post("/chat", async (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { message, session } = req.body;
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
      });

      if (result.response) {
        logMessage(state, "http", "out", sid, result.response);
      }
      res.json({ response: result.response, session: sid });
    } catch (err: unknown) {
      logMessage(state, "http", "out", sid, `ERROR: ${errorMessage(err)}`);
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // Sessions
  app.get("/sessions", (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
    res.json(listSessions());
  });

  app.get("/sessions/:id/messages", (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
    const messages = loadMessages(req.params.id);
    res.json(messages.map((m) => ({ role: m.role, content: m.content })));
  });

  app.delete("/sessions/:id", (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
    deleteSession(req.params.id);
    res.json({ ok: true });
  });

  // Agents
  app.get("/agents", async (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
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

  app.post("/agents", (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
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

  app.delete("/agents/:id", (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
    const { id } = req.params;
    if (!state.config.agents[id]) { res.status(404).json({ error: `Agent "${id}" not found` }); return; }
    const agents = { ...state.config.agents };
    delete agents[id];
    saveConfig({ agents });
    state.config = loadConfig();
    res.json({ ok: true });
  });

  // SOUL.md
  app.get("/agents/:id/soul", (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
    const { id } = req.params;
    if (!state.config.agents[id]) { res.status(404).json({ error: `Agent "${id}" not found` }); return; }
    const soulPath = path.join(agentMemoryDir(id), "SOUL.md");
    if (!fs.existsSync(soulPath)) { res.json({ content: "" }); return; }
    res.json({ content: fs.readFileSync(soulPath, "utf-8") });
  });

  app.put("/agents/:id/soul", (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
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
  app.get("/config", (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
    const safe = { ...state.config, apiKey: state.config.apiKey ? `***${state.config.apiKey.slice(-4)}` : undefined };
    res.json(safe);
  });

  app.patch("/config", (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
    const updates = req.body;
    if (!updates || typeof updates !== "object") { res.status(400).json({ error: "JSON body required" }); return; }
    delete updates.apiKey;
    delete updates.serve;
    saveConfig(updates);
    state.config = loadConfig();
    state.client = createClient(state.config);
    state.systemPrompt = buildSystemPrompt(state.config.systemPrompt, state.config.skills);
    res.json({ ok: true });
  });

  // Pairing
  app.get("/pairing", (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
    res.json(listPendingRequests());
  });

  app.post("/pairing/:code/approve", async (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
    const request = approveRequest(req.params.code);
    if (request) {
      res.json({ ok: true, otp: request.otp, userId: request.userId, agentId: request.agentId });
      // Notify the Telegram user to enter the OTP
      try {
        const { getActiveBots } = await import("../telegram.js");
        await notifyUserOtpRequired(request, getActiveBots());
      } catch { /* telegram may not be running */ }
    } else {
      res.status(404).json({ error: "Request not found or expired" });
    }
  });

  app.post("/pairing/:code/deny", async (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
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
  app.get("/bot-approvals", (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
    res.json(listPendingBotApprovals());
  });

  app.post("/bot-approvals/:agentId/approve", async (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
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

  app.post("/bot-approvals/:agentId/deny", (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
    const approval = denyBotApproval(req.params.agentId);
    if (approval) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: "Approval not found" });
    }
  });

  // Approvals
  app.post("/approvals/:id/decide", (req, res) => {
    if (!checkAuth(state, req.headers.authorization)) { res.status(401).json({ error: "Unauthorized" }); return; }
    const { id } = req.params;
    const { decision } = req.body;
    if (!decision) { res.status(400).json({ error: "decision is required (allow-once, allow-always, deny)" }); return; }
    const resolved = submitDecision(id, decision as ApprovalDecision);
    res.json({ ok: resolved });
  });
}
