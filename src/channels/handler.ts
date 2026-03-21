// Shared channel handler: commands, message flow, streaming
// Each channel calls these with its adapter — no platform-specific code here.

import type { Config } from "../core/config.js";
import { saveConfig } from "../core/config.js";
import type { AgentEvent } from "../agent.js";
import type { ChannelAdapter, ResolvedAgentBase, RuntimeState } from "./adapter.js";
import { createClient } from "../model.js";
import { loadMessages, deleteSession, listSessions } from "../session.js";
import { isRunActive } from "../runtime/runs.js";
import { queueOrProcess } from "../runtime/queue.js";
import { compactHistory } from "../runtime/compact.js";
import { orchestrate } from "../runtime/orchestrate.js";
import { getSessionUsage, formatUsageSummary, formatTokens } from "../usage.js";
import { CHARS_PER_TOKEN } from "../core/constants.js";
import { BlockChunker } from "../chunker.js";
import { listSkillNames } from "../extensions/skills.js";
import { log as slog } from "../core/log.js";

// ─── Agent resolution (channel-agnostic) ─────────────────────────────

import { buildSystemPrompt } from "../system-prompt.js";
import type { RuntimeOverrides } from "./adapter.js";

/** Resolve agent config with optional runtime overrides (no platform-specific fields) */
export function resolveAgentBase(
  agentId: string,
  config: Config,
  globalSystemPrompt: string,
  overrides?: RuntimeOverrides,
): ResolvedAgentBase {
  if (agentId === "default") {
    return {
      id: "default",
      name: "CamelAGI",
      model: overrides?.model ?? config.model,
      systemPrompt: globalSystemPrompt,
      thinking: overrides?.thinking ?? config.thinking,
      effort: overrides?.effort ?? config.effort,
      maxTurns: config.maxTurns,
    };
  }

  const agent = config.agents[agentId];
  const basePrompt = agent?.systemPrompt ?? config.systemPrompt;
  return {
    id: agentId,
    name: agent?.name ?? agentId,
    model: overrides?.model ?? agent?.model ?? config.model,
    systemPrompt: buildSystemPrompt(basePrompt, config.skills, agentId),
    thinking: overrides?.thinking ?? (agent?.thinking ?? config.thinking) as Config["thinking"],
    effort: overrides?.effort ?? (agent?.effort ?? config.effort) as Config["effort"],
    maxTurns: agent?.maxTurns ?? config.maxTurns,
  };
}

// ─── Commands ─────────────────────────────────────────────────────────

export interface CommandResult {
  handled: boolean;
  response?: string;
  /** If set, response should be sent as a file with this name */
  asFile?: string;
}

/**
 * Handle a slash command. Returns { handled: true, response } if it was a known command.
 * Channel calls this, then sends `response` via its own API.
 */
export async function handleCommand(
  cmd: string,
  arg: string,
  opts: {
    agentId: string;
    conversationId: string;
    sessionId: string;
    agent: ResolvedAgentBase;
    runtime: RuntimeState;
    getConfig: () => Config;
  },
): Promise<CommandResult> {
  const { agentId, conversationId, sessionId, agent, runtime, getConfig } = opts;

  switch (cmd) {
    case "help":
      return {
        handled: true,
        response: [
          `${agent.name} Commands:\n`,
          "/help — List commands and current config",
          "/clear — Clear this chat's history",
          "/status — Show model, message count, token usage",
          "/model <name> — Switch model for this chat",
          "/think <level> — Set thinking (off|low|medium|high)",
          "/effort <level> — Set effort (low|medium|high|max)",
          "/mcp — Manage MCP tool servers",
          "/usage — Token usage for this session",
          "/skills — List active skills",
          "/export — Export session as markdown file",
          "/session [name] — Show or switch session",
          "/compact — Force compaction of chat history",
          "",
          `Model: ${agent.model}`,
          `Thinking: ${agent.thinking}`,
          `Effort: ${agent.effort}`,
          `Max turns: ${agent.maxTurns}`,
        ].join("\n"),
      };

    case "clear":
      deleteSession(sessionId);
      runtime.models.delete(conversationId);
      runtime.thinking.delete(conversationId);
      runtime.effort.delete(conversationId);
      runtime.sessions.delete(conversationId);
      return { handled: true, response: "Session cleared." };

    case "status": {
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
      if (runtime.models.has(conversationId)) lines.push(`(runtime override, resets on /clear or restart)`);
      return { handled: true, response: lines.join("\n") };
    }

    case "model": {
      if (!arg) {
        return { handled: true, response: `Current model: ${agent.model}\n\nUsage: /model <name>` };
      }
      runtime.models.set(conversationId, arg);
      return { handled: true, response: `Model switched to: ${arg}\n(runtime only, resets on /clear or restart)` };
    }

    case "think": {
      const levels = ["off", "low", "medium", "high"] as const;
      const level = arg as typeof levels[number];
      if (!arg) {
        return { handled: true, response: `Thinking: ${agent.thinking}\n\nUsage: /think off|low|medium|high` };
      }
      if (!levels.includes(level)) {
        return { handled: true, response: "Invalid level. Use: off, low, medium, high" };
      }
      runtime.thinking.set(conversationId, level);
      return { handled: true, response: `Thinking set to: ${level}\n(runtime only, resets on /clear or restart)` };
    }

    case "effort": {
      const levels = ["low", "medium", "high", "max"] as const;
      const level = arg as typeof levels[number];
      if (!arg) {
        return { handled: true, response: `Effort: ${agent.effort}\n\nUsage: /effort low|medium|high|max` };
      }
      if (!levels.includes(level)) {
        return { handled: true, response: "Invalid level. Use: low, medium, high, max" };
      }
      runtime.effort.set(conversationId, level);
      return { handled: true, response: `Effort set to: ${level}\n(runtime only, resets on /clear or restart)` };
    }

    case "compact": {
      const config = getConfig();
      const history = loadMessages(sessionId);
      if (history.length === 0) return { handled: true, response: "No history to compact." };

      const client = createClient(config);
      const result = await compactHistory(client, agent.model, history, {
        ...(config.compaction ?? {}),
        enabled: true,
        agentId: agentId === "default" ? undefined : agentId,
      });
      if (result) {
        return { handled: true, response: `Compacted: ${history.length} -> ${result.length} messages` };
      }
      return { handled: true, response: `History is already compact (${history.length} messages).` };
    }

    case "usage": {
      const usage = getSessionUsage(sessionId);
      const messages = loadMessages(sessionId);
      if (usage.calls === 0) {
        return { handled: true, response: "No usage yet in this session." };
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
      return { handled: true, response: lines.join("\n") };
    }

    case "skills": {
      const skills = listSkillNames();
      if (skills.length === 0) {
        return { handled: true, response: "No skills installed.\n\nAdd skills to ~/.camelagi/skills/" };
      }
      return { handled: true, response: `Active skills: ${skills.join(", ")}` };
    }

    case "export": {
      const messages = loadMessages(sessionId);
      if (messages.length === 0) {
        return { handled: true, response: "No messages to export." };
      }
      const md = messages.map(m =>
        m.role === "user" ? `## You\n\n${m.content}` : `## Assistant\n\n${m.content}`
      ).join("\n\n---\n\n");
      return { handled: true, response: md, asFile: `${sessionId}.md` };
    }

    case "session": {
      if (!arg) {
        return { handled: true, response: `Current session: ${sessionId}` };
      }
      if (arg === "list") {
        const sessions = listSessions();
        if (sessions.length === 0) {
          return { handled: true, response: "No sessions." };
        }
        const lines = sessions.slice(0, 20).map(s => {
          const msgs = loadMessages(s.id).length;
          return `${s.id} (${msgs} msgs)`;
        });
        return { handled: true, response: lines.join("\n") };
      }
      // Switch session
      runtime.sessions.set(conversationId, arg);
      const existing = loadMessages(arg);
      return {
        handled: true,
        response: `Switched to session: ${arg}${existing.length > 0 ? ` (${existing.length} messages)` : " (new)"}`,
      };
    }

    case "mcp": {
      const config = getConfig();
      // Determine which MCP scope: agent-specific or global
      const isAgent = agentId && agentId !== "default" && config.agents[agentId];
      const scope = isAgent ? `agent "${config.agents[agentId].name}"` : "global";
      const servers = isAgent
        ? config.agents[agentId]?.mcp?.servers ?? {}
        : config.mcp.servers;

      if (!arg) {
        // List servers
        const entries = Object.entries(servers);
        if (entries.length === 0) {
          return {
            handled: true,
            response: [
              `No MCP servers (${scope}).\n`,
              "Add one:",
              "  /mcp add http <url>",
              "  /mcp add sse <url>",
              "  /mcp add <name> <command...>",
              "  /mcp remove <name>",
            ].join("\n"),
          };
        }
        const lines = entries.map(([name, s]) => {
          const cfg = s as Record<string, unknown>;
          if (cfg.type === "stdio") {
            const args = Array.isArray(cfg.args) ? (cfg.args as string[]).join(" ") : "";
            return `• ${name} (stdio)\n  ${cfg.command} ${args}`.trimEnd();
          }
          return `• ${name} (${cfg.type})\n  ${cfg.url}`;
        });
        return { handled: true, response: `MCP Servers (${scope}):\n\n${lines.join("\n\n")}` };
      }

      const parts = arg.split(/\s+/);
      const sub = parts[0];

      if (sub === "add") {
        const type = parts[1];
        if (!type) {
          return { handled: true, response: "Usage:\n  /mcp add http <url>\n  /mcp add sse <url>\n  /mcp add <name> <command...>" };
        }

        let name: string;
        let serverConfig: Record<string, unknown>;

        if (type === "http" || type === "sse") {
          const url = parts[2];
          if (!url) return { handled: true, response: `Usage: /mcp add ${type} <url>` };
          try { new URL(url); } catch { return { handled: true, response: "Invalid URL." }; }
          // Auto-generate name from hostname
          const host = new URL(url).hostname;
          name = host.replace(/^(www|api|mcp)\./, "").replace(/\.(com|io|ai|dev|org|net)$/, "").replace(/\./g, "-") || "server";
          let i = 2;
          const existingNames = Object.keys(servers);
          while (existingNames.includes(name)) { name = `${name}${i++}`; }
          serverConfig = { type, url };
        } else {
          // stdio: /mcp add <name> <command...>
          name = type;
          const command = parts.slice(2);
          if (command.length === 0) return { handled: true, response: "Usage: /mcp add <name> <command...>\n\ne.g. /mcp add github npx -y @modelcontextprotocol/server-github" };
          serverConfig = { type: "stdio", command: command[0], args: command.slice(1) };
        }

        const updated = { ...servers, [name]: serverConfig } as Record<string, unknown>;
        if (isAgent) {
          const agents = { ...config.agents };
          agents[agentId] = { ...agents[agentId], mcp: { servers: updated } } as typeof agents[string];
          saveConfig({ agents });
        } else {
          saveConfig({ mcp: { servers: updated } });
        }
        return { handled: true, response: `Added MCP server: ${name} (${scope})` };
      }

      if (sub === "remove" || sub === "rm") {
        const name = parts[1];
        if (!name) return { handled: true, response: "Usage: /mcp remove <name>" };
        if (!(name in servers)) return { handled: true, response: `Server "${name}" not found.` };

        const updated = { ...servers };
        delete (updated as Record<string, unknown>)[name];
        if (isAgent) {
          const agents = { ...config.agents };
          agents[agentId] = { ...agents[agentId], mcp: { servers: updated } };
          saveConfig({ agents });
        } else {
          saveConfig({ mcp: { servers: updated } });
        }
        return { handled: true, response: `Removed MCP server: ${name}` };
      }

      return { handled: true, response: "Usage: /mcp [add|remove]\n\n/mcp — list servers\n/mcp add http <url>\n/mcp add sse <url>\n/mcp add <name> <command...>\n/mcp remove <name>" };
    }

    default:
      return { handled: false };
  }
}

// ─── Message handler ──────────────────────────────────────────────────

export interface HandleMessageOpts {
  channelType: string;
  agentId: string;
  conversationId: string;
  sessionId: string;
  text: string;
  agent: ResolvedAgentBase;
  adapter: ChannelAdapter;
  getConfig: () => Config;
  signal?: AbortSignal;
  /** Called on approval_request events — channel handles platform-specific UI */
  onApproval?: (event: AgentEvent & { type: "approval_request" }) => Promise<void>;
}

/**
 * Handle an incoming message: call orchestrate, stream via adapter, return response.
 * This is the core shared flow all channels use.
 */
export async function handleMessage(opts: HandleMessageOpts): Promise<string> {
  const { channelType, agentId, conversationId, sessionId, text, agent, adapter, getConfig, signal } = opts;
  const config = getConfig();

  slog.info(channelType, "Incoming message", { agent: agent.name, sessionId, text: text.slice(0, 160) });

  if (isRunActive(sessionId)) {
    await queueOrProcess(sessionId, text);
    return "";
  }

  const client = createClient(config);
  let messageId: string | null = null;
  let lastSentText = "";
  let pendingText = "";
  let timer: NodeJS.Timeout | null = null;
  let lastSentAt = 0;

  const flushDraft = async (isFinal: boolean) => {
    const trimmed = pendingText.slice(0, adapter.maxMessageLength);
    if (!trimmed || trimmed === lastSentText) return;
    if (!messageId && !isFinal && trimmed.length < 30) return;

    try {
      if (!messageId) {
        messageId = await adapter.send(conversationId, trimmed);
      } else {
        await adapter.edit(conversationId, messageId, trimmed);
      }
      lastSentText = trimmed;
      lastSentAt = Date.now();
    } catch { /* best effort */ }
  };

  const scheduleDraft = () => {
    if (timer) return;
    const elapsed = Date.now() - lastSentAt;
    const wait = Math.max(0, adapter.throttleMs - elapsed);
    timer = setTimeout(async () => {
      timer = null;
      await flushDraft(false);
    }, wait);
  };

  try {
    await adapter.setStatus(conversationId, "received");
    await adapter.setStatus(conversationId, "thinking");

    const result = await orchestrate({
      sessionId,
      message: text,
      config,
      systemPrompt: agent.systemPrompt,
      client,
      signal,
      agentId: agentId === "default" ? undefined : agentId,
      label: agent.name,
      model: agent.model,
      agentSystemPrompt: agent.systemPrompt,
      thinking: agent.thinking,
      effort: agent.effort,
      onEvent: async (event: AgentEvent) => {
        if (event.type === "stream_text") {
          pendingText += event.text;
          scheduleDraft();
        } else if (event.type === "chunk") {
          pendingText = event.text;
          scheduleDraft();
        } else if (event.type === "tool_call" || event.type === "subagent_start") {
          await adapter.setStatus(conversationId, "tool");
        } else if (event.type === "thinking" && event.state === "start") {
          await adapter.setStatus(conversationId, "extended_thinking");
        } else if (event.type === "approval_request" && opts.onApproval) {
          await opts.onApproval(event as AgentEvent & { type: "approval_request" });
        }
      },
    });

    const response = result.response || "(no response)";
    slog.info(channelType, "Response sent", { agent: agent.name, sessionId, text: response.slice(0, 160) });

    // Final flush
    if (timer) { clearTimeout(timer); timer = null; }
    pendingText = response;
    await flushDraft(true);

    // If response exceeds max length, delete draft and send chunked
    if (messageId && response.length > adapter.maxMessageLength) {
      try { await adapter.delete(conversationId, messageId); } catch {}
      await sendChunked(adapter, conversationId, response);
    } else if (!messageId) {
      await sendChunked(adapter, conversationId, response);
    }

    await adapter.setStatus(conversationId, "done");
    return response;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : undefined;
    slog.error(channelType, "Agent run failed", { agent: agent.name, sessionId, error: errMsg });
    if (errStack) console.error(errStack);

    if (timer) { clearTimeout(timer); timer = null; }
    if (messageId) {
      try { await adapter.edit(conversationId, messageId, `Error: ${errMsg}`); }
      catch { await adapter.send(conversationId, `Error: ${errMsg}`); }
    } else {
      await adapter.send(conversationId, `Error: ${errMsg}`);
    }
    await adapter.setStatus(conversationId, "error");
    return "";
  }
}

// ─── Chunking ─────────────────────────────────────────────────────────

async function sendChunked(adapter: ChannelAdapter, conversationId: string, text: string): Promise<void> {
  if (text.length <= adapter.maxMessageLength) {
    await adapter.send(conversationId, text);
    return;
  }

  const minChunk = Math.floor(adapter.maxMessageLength * 0.2);
  const maxChunk = Math.floor(adapter.maxMessageLength * 0.85);
  const chunks: string[] = [];
  const chunker = new BlockChunker({ minChars: minChunk, maxChars: maxChunk, onChunk: (c) => chunks.push(c) });
  chunker.append(text);
  chunker.flush();
  for (const chunk of chunks) {
    await adapter.send(conversationId, chunk);
  }
}
