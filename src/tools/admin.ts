// Admin tools: AI-powered agent management (replaces wizard-based admin for LLM agents)

import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig, type Config } from "../core/config.js";
import { agentMemoryDir, seedAgentWorkspace } from "../workspace.js";
import { listSessions, deleteSession, loadMessages } from "../session.js";
import { listPendingRequests, approveRequest, denyRequest } from "../extensions/pairing.js";
import { aggregateAgentUsage, formatTokens, formatCost } from "../usage.js";
import { SOUL_TEMPLATES, nameToId, validateBotToken, PRESETS } from "../telegram/wizards.js";
import type { ToolDef } from "../core/types.js";

export interface AdminToolDeps {
  getSystemPrompt: () => string;
}

export function createAdminTools(deps: AdminToolDeps): ToolDef[] {
  return [
    adminAgentsTool(deps),
    adminConfigTool,
    adminMcpTool,
    adminSoulTool,
    adminBotTool(deps),
    adminSessionsTool,
    adminUsageTool,
    adminPairingTool,
  ];
}

// ─── admin_agents: list, create, update, delete ─────────────────────

function adminAgentsTool(deps: AdminToolDeps): ToolDef {
  return {
    name: "admin_agents",
    description: `Manage agents — list, create, update, or delete.

Actions:
- list: Show all agents with status, model, config
- create: Create a new agent with name, mode, model, telegram token, soul template, etc.
- update: Change an agent's setting (model, thinking, effort, maxTurns, name, briefMode)
- delete: Remove an agent (stops bot, removes config, preserves workspace files)

Soul templates for create: coding, research, writing, general, custom`,
    schema: z.object({
      action: z.enum(["list", "create", "update", "delete"]).describe("Action to perform"),
      agentId: z.string().nullable().optional().describe("Agent ID (for update/delete)"),
      name: z.string().nullable().optional().describe("Agent name (for create)"),
      mode: z.enum(["llm", "claude-code"]).nullable().optional().describe("Agent mode (for create, default: llm)"),
      model: z.string().nullable().optional().describe("Model override (for create/update)"),
      thinking: z.enum(["off", "low", "medium", "high"]).nullable().optional().describe("Thinking level (for create/update)"),
      effort: z.enum(["low", "medium", "high", "max"]).nullable().optional().describe("Effort level (for create/update)"),
      maxTurns: z.number().nullable().optional().describe("Max turns (for create/update)"),
      telegramBotToken: z.string().nullable().optional().describe("Telegram bot token from BotFather (for create)"),
      soulTemplate: z.enum(["coding", "research", "writing", "general", "custom"]).nullable().optional().describe("Personality template (for create)"),
      customSoul: z.string().nullable().optional().describe("Custom SOUL.md content (when soulTemplate is 'custom')"),
      briefMode: z.boolean().nullable().optional().describe("Brief mode toggle (for update, requires telegram)"),
      field: z.string().nullable().optional().describe("Field name to update (for update — model, thinking, effort, maxTurns, name, briefMode)"),
      value: z.string().nullable().optional().describe("New value for the field (for update)"),
    }),
    execute: async (args) => {
      const { action } = args as { action: string };
      const config = loadConfig();

      if (action === "list") {
        return listAgents(config);
      }

      if (action === "create") {
        return createAgent(config, args, deps);
      }

      if (action === "update") {
        return updateAgent(config, args);
      }

      if (action === "delete") {
        return deleteAgent(config, args);
      }

      return `Unknown action: ${action}`;
    },
  };
}

async function listAgents(config: Config): Promise<string> {
  const entries = Object.entries(config.agents);
  if (entries.length === 0) return "No agents configured.";

  let runningBots: string[] = [];
  try {
    const { getActiveBotIds } = await import("../telegram.js");
    runningBots = getActiveBotIds();
  } catch { /* not in telegram context */ }

  const lines: string[] = [];
  for (const [id, a] of entries) {
    const running = runningBots.includes(id);
    const status = running ? "running" : a.telegram?.botToken ? "stopped" : "no bot";
    const model = a.model ?? config.model;
    const thinking = a.thinking ?? config.thinking;
    const effort = a.effort ?? config.effort;
    const maxTurns = a.maxTurns ?? config.maxTurns;
    const mcpCount = a.mcp ? Object.keys(a.mcp.servers).length : 0;
    const mode = a.mode ?? "llm";

    lines.push(`[${id}] ${a.name}`);
    lines.push(`  Status: ${status} | Mode: ${mode} | Admin: ${a.admin ? "yes" : "no"}`);
    lines.push(`  Model: ${model} | Thinking: ${thinking} | Effort: ${effort} | Max Turns: ${maxTurns}`);
    if (mcpCount > 0) lines.push(`  MCP: ${mcpCount} server(s)`);
    if (a.telegram?.botToken) lines.push(`  Telegram: configured`);
    if (a.discord?.botToken) lines.push(`  Discord: configured`);
    lines.push("");
  }
  return lines.join("\n");
}

async function createAgent(config: Config, args: Record<string, unknown>, deps: AdminToolDeps): Promise<string> {
  const name = args.name as string | undefined;
  if (!name) return "Error: name is required for create.";

  const existingIds = Object.keys(config.agents);
  const id = nameToId(name, existingIds);
  const mode = (args.mode as string) ?? "llm";
  const model = args.model as string | undefined;
  const thinking = args.thinking as string | undefined;
  const effort = args.effort as string | undefined;
  const maxTurns = args.maxTurns as number | undefined;
  const telegramBotToken = args.telegramBotToken as string | undefined;
  const soulTemplate = (args.soulTemplate as string) ?? "general";
  const customSoul = args.customSoul as string | undefined;

  // Validate telegram token if provided
  let tokenInfo = "";
  if (telegramBotToken) {
    const result = await validateBotToken(telegramBotToken);
    if (!result.ok) {
      return `Telegram token validation failed: ${result.error}`;
    }
    tokenInfo = `\nTelegram: @${result.username}`;
  }

  // Seed workspace
  const description = soulTemplate === "custom" ? customSoul : undefined;
  seedAgentWorkspace(id, name, description);

  // Apply soul template
  const tmpl = SOUL_TEMPLATES[soulTemplate];
  if (tmpl?.soul) {
    const soulPath = path.join(agentMemoryDir(id), "SOUL.md");
    fs.writeFileSync(soulPath, tmpl.soul);
  } else if (soulTemplate === "custom" && customSoul) {
    const soulPath = path.join(agentMemoryDir(id), "SOUL.md");
    fs.writeFileSync(soulPath, customSoul);
  }

  // Build agent config
  const agentConfig: Record<string, unknown> = { name };
  if (mode === "claude-code") agentConfig.mode = "claude-code";
  if (model) agentConfig.model = model;
  if (thinking) agentConfig.thinking = thinking;
  if (effort) agentConfig.effort = effort;
  if (maxTurns) agentConfig.maxTurns = maxTurns;
  if (telegramBotToken) {
    agentConfig.telegram = {
      botToken: telegramBotToken,
      allowedUsers: config.agents.admin?.telegram?.allowedUsers ?? [],
    };
  }

  const agents = { ...config.agents, [id]: agentConfig };
  saveConfig({ agents });

  // Start bot if token provided
  if (telegramBotToken) {
    try {
      const { startBot } = await import("../telegram.js");
      await startBot(id, telegramBotToken, () => loadConfig(), deps.getSystemPrompt);
      tokenInfo += " (started)";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tokenInfo += ` (bot not started: ${msg})`;
    }
  }

  const modeLabel = mode === "claude-code" ? "Claude Code" : `LLM — ${model ?? config.model}`;
  return [
    `Agent created!`,
    ``,
    `Name: ${name}`,
    `ID: ${id}`,
    `Mode: ${modeLabel}`,
    thinking ? `Thinking: ${thinking}` : null,
    effort ? `Effort: ${effort}` : null,
    maxTurns ? `Max Turns: ${maxTurns}` : null,
    tokenInfo || null,
    `Workspace: ${agentMemoryDir(id)}`,
  ].filter(Boolean).join("\n");
}

function updateAgent(config: Config, args: Record<string, unknown>): string {
  const agentId = args.agentId as string | undefined;
  if (!agentId) return "Error: agentId is required for update.";
  if (!config.agents[agentId]) return `Error: agent "${agentId}" not found.`;

  const agents = { ...config.agents };
  const agent = { ...agents[agentId] } as Record<string, unknown>;

  // Direct field updates from args
  const directFields = ["model", "thinking", "effort", "maxTurns", "name"] as const;
  let updated = false;
  const changes: string[] = [];

  for (const f of directFields) {
    if (args[f] !== undefined && args[f] !== null) {
      agent[f] = args[f];
      changes.push(`${f} = ${args[f]}`);
      updated = true;
    }
  }

  // Brief mode (nested under telegram)
  if (args.briefMode !== undefined && args.briefMode !== null) {
    if (!agent.telegram) return "Error: agent has no Telegram config — briefMode requires Telegram.";
    agent.telegram = { ...(agent.telegram as Record<string, unknown>), briefMode: args.briefMode };
    changes.push(`briefMode = ${args.briefMode}`);
    updated = true;
  }

  // Generic field/value update
  if (!updated && args.field && args.value !== undefined) {
    const field = args.field as string;
    let value: unknown = args.value;
    if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (typeof value === "string" && /^\d+$/.test(value)) value = parseInt(value, 10);

    if (field === "briefMode") {
      if (!agent.telegram) return "Error: agent has no Telegram config.";
      agent.telegram = { ...(agent.telegram as Record<string, unknown>), briefMode: value };
    } else {
      agent[field] = value;
    }
    changes.push(`${field} = ${value}`);
    updated = true;
  }

  if (!updated) return "Error: no changes specified. Provide field values or field+value params.";

  agents[agentId] = agent as typeof agents[string];
  saveConfig({ agents });
  return `Updated ${agentId}:\n${changes.map(c => `  ${c}`).join("\n")}`;
}

async function deleteAgent(config: Config, args: Record<string, unknown>): Promise<string> {
  const agentId = args.agentId as string | undefined;
  if (!agentId) return "Error: agentId is required for delete.";
  if (!config.agents[agentId]) return `Error: agent "${agentId}" not found.`;
  if (config.agents[agentId].admin) return `Error: cannot delete admin agent "${agentId}".`;

  // Stop bot if running
  try {
    const { stopBot } = await import("../telegram.js");
    stopBot(agentId);
  } catch { /* not in telegram context */ }

  const agents = { ...config.agents };
  delete agents[agentId];
  saveConfig({ agents });

  return `Agent "${agentId}" deleted. Workspace files preserved at ${agentMemoryDir(agentId)}`;
}

// ─── admin_config: get, set, setup_provider ─────────────────────────

const adminConfigTool: ToolDef = {
  name: "admin_config",
  description: `View or modify CamelAGI configuration.

Actions:
- get: View current config (full or specific key). API key is masked.
- set: Update a config value. Supports dot-notation for nested keys (e.g. "approvals.mode").
- setup_provider: Configure API provider, key, model, and base URL in one call.

Available providers for setup_provider: anthropic, openai, openrouter, ollama, custom`,
  schema: z.object({
    action: z.enum(["get", "set", "setup_provider"]).describe("Action to perform"),
    key: z.string().nullable().optional().describe("Config key (for get/set, dot-separated for nested)"),
    value: z.string().nullable().optional().describe("New value (for set)"),
    provider: z.enum(["anthropic", "openai", "openrouter", "ollama", "custom"]).nullable().optional().describe("Provider (for setup_provider)"),
    apiKey: z.string().nullable().optional().describe("API key (for setup_provider)"),
    baseUrl: z.string().nullable().optional().describe("Base URL (for setup_provider with custom/openrouter)"),
    model: z.string().nullable().optional().describe("Model name (for setup_provider)"),
  }),
  execute: async (args) => {
    const { action } = args as { action: string };
    const config = loadConfig();

    if (action === "get") {
      const key = args.key as string | undefined;
      if (!key) {
        return [
          `Provider: ${config.provider}`,
          `Model: ${config.model}`,
          config.baseUrl ? `Base URL: ${config.baseUrl}` : null,
          `API Key: ${config.apiKey ? "***" + config.apiKey.slice(-4) : "not set"}`,
          `Thinking: ${config.thinking}`,
          `Effort: ${config.effort}`,
          `Max Turns: ${config.maxTurns}`,
          `Timeout: ${config.timeoutSeconds}s`,
          `Approvals: ${config.approvals.mode}`,
          `Compaction: ${config.compaction.enabled ? "on" : "off"} (max ${config.compaction.maxTokens} tokens)`,
          `Voice: ${config.voice.enabled ? config.voice.provider : "disabled"}`,
          `Agents: ${Object.keys(config.agents).length}`,
          `MCP Servers: ${Object.keys(config.mcp.servers).length}`,
          `Cron Jobs: ${config.cron.length}`,
        ].filter(Boolean).join("\n");
      }

      const parts = key.split(".");
      let value: unknown = config as unknown;
      for (const part of parts) {
        if (value && typeof value === "object") {
          value = (value as Record<string, unknown>)[part];
        } else {
          return `Key not found: ${key}`;
        }
      }
      if (key.includes("apiKey") || key.includes("botToken")) {
        const str = String(value ?? "");
        return `${key} = ${str ? "***" + str.slice(-4) : "not set"}`;
      }
      return `${key} = ${JSON.stringify(value, null, 2)}`;
    }

    if (action === "set") {
      const key = args.key as string | undefined;
      const rawValue = args.value as string | undefined;
      if (!key || rawValue === undefined) return "Error: key and value are required for set.";

      let parsed: unknown = rawValue;
      if (rawValue === "true") parsed = true;
      else if (rawValue === "false") parsed = false;
      else if (/^\d+$/.test(rawValue)) parsed = parseInt(rawValue, 10);

      const parts = key.split(".");
      let update: Record<string, unknown>;
      if (parts.length === 1) {
        update = { [key]: parsed };
      } else {
        const topKey = parts[0];
        const subKey = parts.slice(1).join(".");
        const existing = (config as Record<string, unknown>)[topKey];
        if (typeof existing === "object" && existing !== null) {
          update = { [topKey]: { ...(existing as Record<string, unknown>), [subKey]: parsed } };
        } else {
          return `Unknown config section: ${topKey}`;
        }
      }

      saveConfig(update);
      return `Config updated: ${key} = ${rawValue}`;
    }

    if (action === "setup_provider") {
      const provider = args.provider as string | undefined;
      if (!provider) return "Error: provider is required for setup_provider.";

      const preset = PRESETS[provider];
      const values: Record<string, unknown> = {
        provider: preset?.provider ?? "openai",
      };

      const apiKey = args.apiKey as string | undefined;
      const baseUrl = args.baseUrl as string | undefined;
      const model = args.model as string | undefined;

      if (apiKey) values.apiKey = apiKey;
      if (model) values.model = model;
      else if (preset?.models.length) values.model = preset.models[0];

      if (provider === "custom" && baseUrl) {
        values.baseUrl = baseUrl;
      } else if (preset?.baseUrl) {
        values.baseUrl = preset.baseUrl;
      }

      saveConfig(values);

      const maskedKey = apiKey ? `***${apiKey.slice(-4)}` : "not set";
      return [
        `Provider configured!`,
        ``,
        `Provider: ${values.provider}`,
        `Model: ${values.model}`,
        values.baseUrl ? `Base URL: ${values.baseUrl}` : null,
        `API Key: ${maskedKey}`,
      ].filter(Boolean).join("\n");
    }

    return `Unknown action: ${action}`;
  },
};

// ─── admin_mcp: add, remove, list ───────────────────────────────────

const adminMcpTool: ToolDef = {
  name: "admin_mcp",
  description: `Manage MCP (Model Context Protocol) tool servers.

Actions:
- list: Show all MCP servers (global and per-agent)
- add: Add a new MCP server
- remove: Remove an MCP server

Transport types for add:
- stdio: Local command (e.g. "npx -y @modelcontextprotocol/server-github")
- http: Remote server via URL
- sse: Streaming server via URL

Servers can be global or agent-specific (set agentId for per-agent).`,
  schema: z.object({
    action: z.enum(["list", "add", "remove"]).describe("Action to perform"),
    agentId: z.string().nullable().optional().describe("Agent ID for per-agent MCP (omit for global)"),
    name: z.string().nullable().optional().describe("Server name (auto-derived if omitted for add)"),
    transport: z.enum(["stdio", "http", "sse"]).nullable().optional().describe("Transport type (for add)"),
    command: z.string().nullable().optional().describe("Full command for stdio (e.g. 'npx -y @modelcontextprotocol/server-github')"),
    url: z.string().nullable().optional().describe("Server URL (for http/sse)"),
    env: z.record(z.string(), z.string()).nullable().optional().describe("Environment variables (for stdio)"),
    headers: z.record(z.string(), z.string()).nullable().optional().describe("HTTP headers (for http/sse)"),
    authToken: z.string().nullable().optional().describe("Bearer auth token (for http/sse, added to headers)"),
  }),
  execute: async (args) => {
    const { action } = args as { action: string };
    const config = loadConfig();
    const agentId = args.agentId as string | undefined;

    if (action === "list") {
      const lines: string[] = [];

      // Global servers
      const globalEntries = Object.entries(config.mcp.servers);
      if (globalEntries.length > 0) {
        lines.push("Global MCP Servers:");
        for (const [name, s] of globalEntries) {
          const cfg = s as Record<string, unknown>;
          if (cfg.type === "stdio") {
            const cmdArgs = Array.isArray(cfg.args) ? (cfg.args as string[]).join(" ") : "";
            lines.push(`  [${name}] stdio — ${cfg.command} ${cmdArgs}`.trimEnd());
          } else {
            lines.push(`  [${name}] ${cfg.type} — ${cfg.url}`);
          }
        }
      } else {
        lines.push("No global MCP servers.");
      }

      // Per-agent servers
      for (const [id, a] of Object.entries(config.agents)) {
        if (!a.mcp?.servers || Object.keys(a.mcp.servers).length === 0) continue;
        lines.push(`\n${a.name} (${id}) MCP Servers:`);
        for (const [name, s] of Object.entries(a.mcp.servers)) {
          const cfg = s as Record<string, unknown>;
          if (cfg.type === "stdio") {
            const cmdArgs = Array.isArray(cfg.args) ? (cfg.args as string[]).join(" ") : "";
            lines.push(`  [${name}] stdio — ${cfg.command} ${cmdArgs}`.trimEnd());
          } else {
            lines.push(`  [${name}] ${cfg.type} — ${cfg.url}`);
          }
        }
      }

      return lines.join("\n") || "No MCP servers configured.";
    }

    if (action === "add") {
      const transport = args.transport as string | undefined;
      if (!transport) return "Error: transport is required (stdio, http, or sse).";

      const currentServers = agentId && config.agents[agentId]
        ? config.agents[agentId]?.mcp?.servers ?? {}
        : config.mcp.servers;
      const existing = Object.keys(currentServers);

      let serverName: string;
      let serverConfig: Record<string, unknown>;

      if (transport === "stdio") {
        const command = args.command as string | undefined;
        if (!command) return "Error: command is required for stdio transport.";
        const parts = command.trim().split(/\s+/);
        serverName = (args.name as string) ?? deriveStdioName(command, existing);
        serverConfig = {
          type: "stdio",
          command: parts[0],
          args: parts.slice(1),
        };
        if (args.env) serverConfig.env = args.env;
      } else {
        const url = args.url as string | undefined;
        if (!url) return "Error: url is required for http/sse transport.";
        serverName = (args.name as string) ?? deriveUrlName(url, existing);
        serverConfig = { type: transport, url };
        const headers: Record<string, string> = {};
        if (args.headers) Object.assign(headers, args.headers);
        if (args.authToken) headers.Authorization = `Bearer ${args.authToken}`;
        if (Object.keys(headers).length > 0) serverConfig.headers = headers;
      }

      const updated = { ...currentServers, [serverName]: serverConfig };
      if (agentId && config.agents[agentId]) {
        const agents = { ...config.agents };
        agents[agentId] = { ...agents[agentId], mcp: { servers: updated } } as typeof agents[string];
        saveConfig({ agents });
      } else {
        saveConfig({ mcp: { servers: updated } });
      }

      const scope = agentId ? config.agents[agentId]?.name ?? agentId : "global";
      return `MCP server added (${scope}):\n  Name: ${serverName}\n  Type: ${transport}\n  ${args.url ?? args.command}`;
    }

    if (action === "remove") {
      const name = args.name as string | undefined;
      if (!name) return "Error: name is required for remove.";

      if (agentId && config.agents[agentId]) {
        const servers = { ...(config.agents[agentId]?.mcp?.servers ?? {}) };
        if (!(name in servers)) return `Server "${name}" not found in agent "${agentId}".`;
        delete (servers as Record<string, unknown>)[name];
        const agents = { ...config.agents };
        agents[agentId] = { ...agents[agentId], mcp: { servers } } as typeof agents[string];
        saveConfig({ agents });
      } else {
        const servers = { ...config.mcp.servers };
        if (!(name in servers)) return `Global server "${name}" not found.`;
        delete (servers as Record<string, unknown>)[name];
        saveConfig({ mcp: { servers } });
      }

      return `Removed MCP server: ${name}`;
    }

    return `Unknown action: ${action}`;
  },
};

function deriveStdioName(command: string, existing: string[]): string {
  const match = command.match(/(?:@[\w-]+\/)?([\w-]+)\s*$/);
  let base = match?.[1] ?? "server";
  base = base.replace(/^(mcp-server-|server-|mcp-)/, "").replace(/(-mcp|-server)$/, "");
  if (!base) base = "server";
  let name = base;
  let i = 2;
  while (existing.includes(name)) { name = `${base}${i++}`; }
  return name;
}

function deriveUrlName(url: string, existing: string[]): string {
  try {
    const host = new URL(url).hostname;
    let base = host.replace(/^(www|api|mcp)\./, "").replace(/\.(com|io|ai|dev|org|net)$/, "").replace(/\./g, "-");
    if (!base) base = "server";
    let name = base;
    let i = 2;
    while (existing.includes(name)) { name = `${base}${i++}`; }
    return name;
  } catch {
    return `server${existing.length + 1}`;
  }
}

// ─── admin_soul: read, write ────────────────────────────────────────

const adminSoulTool: ToolDef = {
  name: "admin_soul",
  description: `Read or write an agent's SOUL.md personality file.

Actions:
- read: Get the current SOUL.md content for an agent
- write: Replace the SOUL.md content for an agent`,
  schema: z.object({
    action: z.enum(["read", "write"]).describe("Action to perform"),
    agentId: z.string().describe("Agent ID"),
    content: z.string().nullable().optional().describe("New SOUL.md content (for write)"),
  }),
  execute: async (args) => {
    const { action, agentId } = args as { action: string; agentId: string };
    const config = loadConfig();

    if (!config.agents[agentId]) return `Error: agent "${agentId}" not found.`;

    const soulPath = path.join(agentMemoryDir(agentId), "SOUL.md");

    if (action === "read") {
      if (!fs.existsSync(soulPath)) return `No SOUL.md for "${agentId}" yet.`;
      const content = fs.readFileSync(soulPath, "utf-8").trim();
      return content || "(empty)";
    }

    if (action === "write") {
      const content = args.content as string | undefined;
      if (!content) return "Error: content is required for write.";
      const dir = agentMemoryDir(agentId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(soulPath, content);
      return `SOUL.md updated for "${agentId}" (${content.length} chars).`;
    }

    return `Unknown action: ${action}`;
  },
};

// ─── admin_bot: status, start, stop, restart ────────────────────────

function adminBotTool(deps: AdminToolDeps): ToolDef {
  return {
    name: "admin_bot",
    description: `Manage Telegram bot lifecycle.

Actions:
- status: Show which bots are running/stopped
- start: Start a specific agent's bot
- stop: Stop a specific agent's bot
- restart: Stop + start (specific agent or all non-admin bots)`,
    schema: z.object({
      action: z.enum(["status", "start", "stop", "restart"]).describe("Action to perform"),
      agentId: z.string().nullable().optional().describe("Agent ID (for start/stop, optional for restart = all)"),
    }),
    execute: async (args) => {
      const { action } = args as { action: string };
      const agentId = args.agentId as string | undefined;
      const config = loadConfig();

      // Dynamic import to avoid circular dependency issues at module load time
      const { getActiveBotIds, startBot, stopBot } = await import("../telegram.js");

      if (action === "status") {
        const running = getActiveBotIds();
        const allIds = Object.keys(config.agents);
        const lines: string[] = [];
        for (const id of allIds) {
          const a = config.agents[id];
          const isRunning = running.includes(id);
          const hasTelegram = !!a.telegram?.botToken;
          const status = isRunning ? "running" : hasTelegram ? "stopped" : "no bot";
          lines.push(`${id}: ${status}`);
        }
        return lines.length > 0 ? lines.join("\n") : "No agents configured.";
      }

      if (action === "start") {
        if (!agentId) return "Error: agentId is required for start.";
        const agent = config.agents[agentId];
        if (!agent) return `Error: agent "${agentId}" not found.`;
        if (!agent.telegram?.botToken) return `Error: agent "${agentId}" has no Telegram bot token.`;
        try {
          await startBot(agentId, agent.telegram.botToken, () => loadConfig(), deps.getSystemPrompt);
          return `Bot "${agentId}" started.`;
        } catch (err) {
          return `Error starting bot: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (action === "stop") {
        if (!agentId) return "Error: agentId is required for stop.";
        const stopped = stopBot(agentId);
        return stopped ? `Bot "${agentId}" stopped.` : `Bot "${agentId}" was not running.`;
      }

      if (action === "restart") {
        if (agentId) {
          const agent = config.agents[agentId];
          if (!agent) return `Error: agent "${agentId}" not found.`;
          if (!agent.telegram?.botToken) return `Error: agent "${agentId}" has no Telegram bot token.`;
          stopBot(agentId);
          try {
            await startBot(agentId, agent.telegram.botToken, () => loadConfig(), deps.getSystemPrompt);
            return `Restarted ${agentId}`;
          } catch (err) {
            return `Error restarting: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // Restart all non-admin bots
        const restarted: string[] = [];
        const errors: string[] = [];
        for (const [id, a] of Object.entries(config.agents)) {
          if (a.admin || !a.telegram?.botToken) continue;
          stopBot(id);
          try {
            await startBot(id, a.telegram.botToken, () => loadConfig(), deps.getSystemPrompt);
            restarted.push(id);
          } catch (err) {
            errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        const lines = [];
        if (restarted.length > 0) lines.push(`Restarted: ${restarted.join(", ")}`);
        if (errors.length > 0) lines.push(`Errors:\n${errors.join("\n")}`);
        return lines.join("\n") || "No bots to restart.";
      }

      return `Unknown action: ${action}`;
    },
  };
}

// ─── admin_sessions: list, clear ────────────────────────────────────

const adminSessionsTool: ToolDef = {
  name: "admin_sessions",
  description: `Manage chat sessions.

Actions:
- list: Show recent sessions (up to 20)
- clear: Delete sessions older than a given age (1d, 1w, 1m)`,
  schema: z.object({
    action: z.enum(["list", "clear"]).describe("Action to perform"),
    olderThan: z.enum(["1d", "1w", "1m"]).nullable().optional().describe("Age threshold for clear (default: 1w)"),
  }),
  execute: async (args) => {
    const { action } = args as { action: string };

    if (action === "list") {
      const sessions = listSessions();
      if (sessions.length === 0) return "No sessions.";
      const recent = sessions.slice(0, 20);
      const lines = [`Sessions (${sessions.length} total):\n`];
      for (const s of recent) {
        const age = formatAge(s.createdAt);
        const msgs = loadMessages(s.id).length;
        const label = s.label ? ` — ${s.label}` : "";
        lines.push(`${s.id}${label}`);
        lines.push(`  ${s.model} · ${msgs} msgs · ${age}`);
      }
      if (sessions.length > 20) lines.push(`\n... and ${sessions.length - 20} more`);
      return lines.join("\n");
    }

    if (action === "clear") {
      const period = (args.olderThan as string) ?? "1w";
      const cutoff = { "1d": 86400000, "1w": 604800000, "1m": 2592000000 }[period] ?? 604800000;
      const now = Date.now();
      const sessions = listSessions();
      let deleted = 0;
      for (const s of sessions) {
        if (now - s.createdAt > cutoff) { deleteSession(s.id); deleted++; }
      }
      return `Deleted ${deleted} session(s) older than ${period}.`;
    }

    return `Unknown action: ${action}`;
  },
};

function formatAge(timestamp: number): string {
  const ms = Date.now() - timestamp;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── admin_usage: per-agent usage summary ───────────────────────────

const adminUsageTool: ToolDef = {
  name: "admin_usage",
  description: "Show per-agent token usage and estimated costs.",
  schema: z.object({}),
  execute: async () => {
    const config = loadConfig();
    const entries = Object.entries(config.agents).filter(([, a]) => !a.admin);
    if (entries.length === 0) return "No agents configured.";

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

    if (!hasData) return "No usage data yet.";
    if (totalCost > 0) lines.push(`Total estimated cost: ~${formatCost(totalCost)}`);
    return lines.join("\n");
  },
};

// ─── admin_pairing: list, approve, deny ─────────────────────────────

const adminPairingTool: ToolDef = {
  name: "admin_pairing",
  description: `Manage user access pairing requests.

Actions:
- list: Show all pending access requests
- approve: Approve a request by code (adds user to allowedUsers)
- deny: Deny a request by code`,
  schema: z.object({
    action: z.enum(["list", "approve", "deny"]).describe("Action to perform"),
    code: z.string().nullable().optional().describe("Pairing code (for approve/deny)"),
  }),
  execute: async (args) => {
    const { action } = args as { action: string };

    if (action === "list") {
      const requests = listPendingRequests();
      if (requests.length === 0) return "No pending access requests.";
      const lines = requests.map(r => {
        const who = r.username ? `@${r.username}` : r.firstName ?? String(r.userId);
        const age = formatAge(r.requestedAt);
        return `${who} (user ${r.userId}) → agent "${r.agentId}"\n  Code: ${r.code} · ${age}`;
      });
      return lines.join("\n\n");
    }

    if (action === "approve") {
      const code = args.code as string | undefined;
      if (!code) return "Error: code is required for approve.";
      const request = approveRequest(code);
      if (!request) return "Request not found or already handled.";
      const who = request.username ? `@${request.username}` : request.firstName ?? String(request.userId);
      return `Approved: ${who} now has access to "${request.agentId}".`;
    }

    if (action === "deny") {
      const code = args.code as string | undefined;
      if (!code) return "Error: code is required for deny.";
      const request = denyRequest(code);
      if (!request) return "Request not found or already handled.";
      const who = request.username ? `@${request.username}` : request.firstName ?? String(request.userId);
      return `Denied access for ${who}.`;
    }

    return `Unknown action: ${action}`;
  },
};
