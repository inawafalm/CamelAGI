// Path 2: Cursor SDK — two modes:
// 1. Direct Cursor API (has cursorApiKey) → uses Cursor's native backend
// 2. Gateway mode (no cursorApiKey) → routes through OpenRouter / any OpenAI-compatible provider
// Both keep Cursor's local tools (file read/write/edit, shell, MCP, subagents)

import type { Message } from "../core/types.js";
import type { RunResult, AgentOpts, AgentEvent } from "./types.js";
import { recordUsage } from "../usage.js";

let gatewayConfigured = false;
let gatewayHandle: { url: string; close(): Promise<void> } | null = null;

// Agent cache uses `any` to avoid importing @cursor/sdk types at the top level
const agentCache = new Map<string, any>();

async function ensureGateway(apiKey: string, baseUrl?: string): Promise<void> {
  if (gatewayConfigured) return;

  const { configureCursorGateway } = await import("cursor-sdk-gateway");

  const resolvedBase = baseUrl
    ? baseUrl.replace(/\/v1\/?$/, "/v1")
    : "https://openrouter.ai/api/v1";

  gatewayHandle = await configureCursorGateway({
    provider: "openai-compatible",
    baseURL: resolvedBase,
    apiKey,
  });

  gatewayConfigured = true;
}

function mapCursorEvent(msg: any, emit: (event: AgentEvent) => void): string {
  let text = "";

  switch (msg.type) {
    case "assistant":
      for (const block of msg.message.content) {
        if (block.type === "text") {
          text = block.text;
          emit({ type: "stream_text", text: block.text });
        } else if (block.type === "tool_use") {
          emit({
            type: "tool_call",
            id: block.id,
            name: block.name,
            args: (block.input ?? {}) as Record<string, unknown>,
          });
        }
      }
      break;

    case "tool_call":
      if (msg.status === "running") {
        emit({
          type: "tool_call",
          id: msg.call_id,
          name: msg.name,
          args: (msg.args ?? {}) as Record<string, unknown>,
        });
      } else if (msg.status === "completed" || msg.status === "error") {
        const preview = String(msg.result ?? "").slice(0, 150).replace(/\n/g, "↵");
        emit({ type: "tool_result", id: msg.call_id, name: msg.name, preview });
      }
      break;

    case "thinking":
      emit({ type: "thinking", state: "start" });
      if (msg.text) emit({ type: "thinking_delta", text: msg.text });
      emit({ type: "thinking", state: "end" });
      break;

    case "system":
      if (msg.subtype === "init") {
        emit({ type: "init", sessionId: msg.agent_id });
      }
      break;

    case "task":
      if (msg.text) emit({ type: "stream_text", text: msg.text });
      break;
  }

  return text;
}

function buildMcpServers(
  opts?: AgentOpts,
): Record<string, any> | undefined {
  if (!opts?.mcpServers || Object.keys(opts.mcpServers).length === 0) return undefined;

  const servers: Record<string, any> = {};
  for (const [name, server] of Object.entries(opts.mcpServers)) {
    if ("command" in server) {
      servers[name] = {
        type: "stdio",
        command: server.command,
        args: server.args,
        env: server.env,
      };
    } else if ("url" in server) {
      servers[name] = {
        type: server.type ?? "http",
        url: server.url,
        headers: server.headers,
      };
    }
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

export async function runAgentCursor(
  apiKey: string,
  model: string,
  systemPrompt: string,
  history: Message[],
  userMessage: string,
  opts?: AgentOpts,
): Promise<RunResult> {
  const directCursorKey = opts?.cursorApiKey;
  const useDirectCursor = !!directCursorKey;

  // Gateway mode: configure BEFORE any @cursor/sdk import
  if (!useDirectCursor) {
    await ensureGateway(apiKey, opts?.baseUrl);
  }

  // Dynamic import — must happen AFTER gateway is configured
  const cursorSdk = await import("@cursor/sdk");
  const Agent = cursorSdk.Agent;

  const emit = opts?.onEvent;
  const cacheKey = opts?.agentId ?? opts?.sessionId ?? "default";
  const mcpServers = buildMcpServers(opts);

  let effectivePrompt = userMessage;
  if (history.length > 0) {
    const cached = agentCache.get(cacheKey);
    if (!cached) {
      const historyText = history
        .map((m) => `[${m.role}]: ${m.content}`)
        .join("\n\n");
      effectivePrompt = `<previous_conversation>\n${historyText}\n</previous_conversation>\n\n${userMessage}`;
    }
  }

  let agent = agentCache.get(cacheKey);
  if (!agent) {
    agent = await Agent.create({
      ...(useDirectCursor ? { apiKey: directCursorKey } : {}),
      model: { id: model },
      local: { cwd: process.cwd() },
      ...(mcpServers ? { mcpServers } : {}),
    });
    agentCache.set(cacheKey, agent);
  }

  let resultText = "";
  const run = await agent.send(effectivePrompt, {
    ...(mcpServers ? { mcpServers } : {}),
  });

  for await (const msg of run.stream()) {
    const text = mapCursorEvent(msg, emit ?? (() => {}));
    if (text) resultText = text;
  }

  const result = await run.wait();
  if (result.result) resultText = result.result;

  if (resultText) {
    emit?.({ type: "chunk", text: resultText });
  }

  if (opts?.sessionId) {
    recordUsage(opts.sessionId, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  }

  const userMsg: Message = { role: "user", content: userMessage };
  const aiMsg: Message = { role: "assistant", content: resultText };
  return { response: resultText, newMessages: [userMsg, aiMsg], usage: null, sessionId: agent.agentId };
}

export function disposeCursorAgent(cacheKey: string): void {
  const agent = agentCache.get(cacheKey);
  if (agent) {
    agent.close();
    agentCache.delete(cacheKey);
  }
}
