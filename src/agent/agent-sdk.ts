// Path 1: Claude Agent SDK (full agent with tools, thinking, subagents)

import { query, createSdkMcpServer, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import type { Message } from "../core/types.js";
import type { ToolDef } from "../core/types.js";

import fs from "node:fs";
import { memorySearchTool, memoryGetTool, createScopedMemoryTools } from "../tools/memory.js";
import { agentMemoryDir } from "../workspace.js";
import { patchTool } from "../tools/patch.js";
import { cronTool } from "../tools/cron.js";
import { createAdminTools, type AdminToolDeps } from "../tools/admin.js";
import { runHooks } from "../extensions/hooks.js";
import { recordUsage } from "../usage.js";
import { DEFAULT_MAX_TURNS } from "../core/constants.js";
import { checkApproval, waitForDecision, addToAllowlist } from "../extensions/approvals.js";
import { forwardApproval } from "../extensions/approval-forward.js";
import { adaptToolDef } from "./tool-adapter.js";
import type { RunResult, AgentOpts, AgentEvent } from "./types.js";

/** Get all custom tool definitions for an agent */
function getToolDefs(agentId?: string): ToolDef[] {
  const memRoot = agentMemoryDir(agentId);
  const scopedMemory = agentId
    ? createScopedMemoryTools(memRoot)
    : { search: memorySearchTool, get: memoryGetTool };

  return [scopedMemory.search, scopedMemory.get, patchTool, cronTool];
}

/** Create MCP server with CamelAGI-specific tools */
function createCamelAgiMcpServer(agentId?: string, adminDeps?: AdminToolDeps) {
  const defs = getToolDefs(agentId);
  if (adminDeps) {
    defs.push(...createAdminTools(adminDeps));
  }
  return createSdkMcpServer({
    name: "camelagi",
    tools: defs.map(adaptToolDef),
  });
}

const BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "Bash",
  "Glob", "Grep",
  "WebSearch", "WebFetch",
  "Agent",
] as const;

/** Extract text from an SDK "assistant" message's content blocks */
function extractAssistantText(msg: any): string {
  if (msg.type !== "assistant" || !msg.message?.content) return "";
  const parts = Array.isArray(msg.message.content) ? msg.message.content : [];
  return parts
    .filter((b: any) => b.type === "text" && b.text)
    .map((b: any) => b.text)
    .join("");
}

// --- Hook factories ---

function createPreToolHook(
  opts: AgentOpts | undefined,
  emit: ((event: AgentEvent) => void) | undefined,
  toolIdCounter: { value: number },
): HookCallback {
  return async (input: Record<string, unknown>) => {
    const name = (input.tool_name ?? input.name ?? "tool") as string;
    const args = (input.tool_input ?? input.input ?? {}) as Record<string, unknown>;
    const toolId = (input.tool_use_id ?? `tool-${++toolIdCounter.value}`) as string;

    if (opts?.hooksEnabled) {
      await runHooks("before_tool", {
        sessionId: opts.sessionId,
        toolName: name,
        toolArgs: args,
      });
    }

    // Approval check
    if (opts?.approvals && opts.approvals.mode !== "off") {
      const request = checkApproval(name, args, opts.approvals.mode, opts.approvals.allowlist);
      if (request) {
        emit?.({ type: "approval_request", id: request.id, toolName: name, preview: request.preview });

        if (!emit) {
          if (opts.approvals.forwardTo) {
            const forwarded = await forwardApproval(request.id, name, request.preview, opts.approvals.forwardTo);
            if (forwarded) {
              const decision = await waitForDecision(request.id, opts.approvals.timeoutSeconds * 1000, opts.approvals.fallback);
              if (decision === "allow-always") addToAllowlist(name, args);
              if (decision === "deny") return { decision: "block", reason: "User denied this tool call" };
            } else {
              if (opts.approvals.fallback === "deny") return { decision: "block", reason: "Tool call requires approval but forwarding failed" };
            }
          } else {
            if (opts.approvals.fallback === "deny") return { decision: "block", reason: "Tool call requires approval but no approval channel is available" };
          }
        } else {
          const decision = await waitForDecision(request.id, opts.approvals.timeoutSeconds * 1000, opts.approvals.fallback);
          emit({ type: "approval_resolved", id: request.id, decision });
          if (decision === "allow-always") addToAllowlist(name, args);
          else if (decision === "deny") return { decision: "block", reason: "User denied this tool call" };
        }
      }
    }

    if (emit) {
      emit({ type: "tool_call", id: toolId, name, args });
    } else {
      const argsStr = JSON.stringify(args).slice(0, 120);
      process.stderr.write(`\x1b[36m  → ${name}\x1b[0m\x1b[90m(${argsStr})\x1b[0m\n`);
    }

    return {};
  };
}

function createPostToolHook(
  opts: AgentOpts | undefined,
  emit: ((event: AgentEvent) => void) | undefined,
  toolIdCounter: { value: number },
): HookCallback {
  return async (input: Record<string, unknown>) => {
    const name = (input.tool_name ?? input.name ?? "tool") as string;
    const toolId = (input.tool_use_id ?? `tool-${toolIdCounter.value}`) as string;
    const resultText = String(input.tool_result ?? input.result ?? "");
    const preview = resultText.slice(0, 150).replace(/\n/g, "↵");

    if (opts?.hooksEnabled) {
      await runHooks("after_tool", { sessionId: opts.sessionId, toolName: name, toolResult: resultText });
    }

    if (emit) {
      emit({ type: "tool_result", id: toolId, name, preview });
    } else {
      process.stderr.write(`\x1b[90m  ← ${preview}${resultText.length > 150 ? "…" : ""}\x1b[0m\n`);
    }

    return {};
  };
}

// --- Query options builder ---

function buildQueryOptions(
  model: string,
  systemPrompt: string,
  apiKey: string,
  opts: AgentOpts | undefined,
  preToolHook: HookCallback,
  postToolHook: HookCallback,
  mcpServer: ReturnType<typeof createSdkMcpServer>,
): Record<string, unknown> {
  const emit = opts?.onEvent;
  const thinking = opts?.thinking && opts.thinking !== "off"
    ? { type: "adaptive" as const }
    : { type: "disabled" as const };

  const disallowedTools = opts?.toolPolicy?.deny?.length ? opts.toolPolicy.deny : undefined;

  const mcpServers = { camelagi: mcpServer, ...(opts?.mcpServers ?? {}) };
  const allowedTools = [
    ...BUILTIN_TOOLS,
    "mcp__camelagi__*",
    ...Object.keys(opts?.mcpServers ?? {}).map(name => `mcp__${name}__*`),
  ];
  const envVars = { ...(process.env ?? {}), ...buildSdkEnv(apiKey, opts?.provider, opts?.baseUrl) };

  const options: Record<string, unknown> = {
    model,
    systemPrompt,
    allowedTools,
    mcpServers,
    maxTurns: opts?.maxTurns ?? DEFAULT_MAX_TURNS,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    cwd: process.cwd(),
    env: envVars,
    thinking,
    includePartialMessages: !!emit,
    settingSources: ["project"],
    hooks: {
      PreToolUse: [{ matcher: ".*", hooks: [preToolHook] }],
      PostToolUse: [{ matcher: ".*", hooks: [postToolHook] }],
    },
  };
  if (disallowedTools) options.disallowedTools = disallowedTools;
  if (opts?.effort) options.effort = opts.effort;
  if (opts?.maxBudgetUsd) options.maxBudgetUsd = opts.maxBudgetUsd;
  if (opts?.resumeSessionId) options.resume = opts.resumeSessionId;

  // Abort signal bridging
  if (opts?.signal) {
    const ac = new AbortController();
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
    options.abortController = ac;
  }

  return options;
}

// --- SDK message processing ---

interface SdkStreamState {
  result: string;
  sdkSessionId: string | undefined;
}

async function processSdkMessages(
  q: AsyncIterable<unknown>,
  emit: ((event: AgentEvent) => void) | undefined,
  opts: AgentOpts | undefined,
): Promise<SdkStreamState> {
  const state: SdkStreamState = { result: "", sdkSessionId: undefined };

  try {
    for await (const message of q) {
      const msg = message as any;

      // "assistant" messages: non-Claude models (via OpenRouter) emit these
      // with the response text instead of a final "result" message.
      const assistantText = extractAssistantText(msg);
      if (assistantText) {
        state.result = assistantText;
        if (msg.session_id) state.sdkSessionId = msg.session_id;
      }

      if (msg.type === "result") {
        const resultMsg = msg as {
          type: "result"; result: string; session_id?: string;
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
        };
        if (resultMsg.result) state.result = resultMsg.result;
        state.sdkSessionId = resultMsg.session_id ?? state.sdkSessionId;

        if (resultMsg.usage && emit) {
          emit({ type: "usage", inputTokens: resultMsg.usage.input_tokens ?? 0, outputTokens: resultMsg.usage.output_tokens ?? 0, cacheReadTokens: resultMsg.usage.cache_read_input_tokens, cacheWriteTokens: resultMsg.usage.cache_creation_input_tokens });
        }
        if (resultMsg.usage && opts?.sessionId) {
          recordUsage(opts.sessionId, { inputTokens: resultMsg.usage.input_tokens ?? 0, outputTokens: resultMsg.usage.output_tokens ?? 0, cacheReadTokens: resultMsg.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: resultMsg.usage.cache_creation_input_tokens ?? 0 });
        }
        emit?.({ type: "chunk", text: state.result });
      } else if (msg.type === "system" && emit) {
        const sysMsg = msg as { type: "system"; subtype?: string; session_id?: string; agent_id?: string; task_id?: string; tool_use_id?: string; tool_count?: number; duration_ms?: number };
        if (sysMsg.subtype === "init" && sysMsg.session_id) { state.sdkSessionId = sysMsg.session_id; emit({ type: "init", sessionId: sysMsg.session_id }); }
        else if (sysMsg.subtype === "task_started") { emit({ type: "subagent_start", agentId: sysMsg.agent_id ?? "subagent", taskId: sysMsg.task_id }); }
        else if (sysMsg.subtype === "task_progress") { emit({ type: "subagent_progress", agentId: sysMsg.agent_id ?? "subagent", toolCount: sysMsg.tool_count, duration: sysMsg.duration_ms ? Math.round(sysMsg.duration_ms / 1000) : undefined }); }
        else if (sysMsg.subtype === "task_notification") { emit({ type: "subagent_done", agentId: sysMsg.agent_id ?? "subagent", toolUseId: sysMsg.tool_use_id }); }
      } else if (msg.type === "stream_event" && emit) {
        const streamMsg = msg as { type: "stream_event"; event: { type: string; content_block?: { type: string }; delta?: { type: string; text?: string; thinking?: string } } };
        const event = streamMsg.event;
        if (event.type === "content_block_start" && event.content_block?.type === "thinking") { emit({ type: "thinking", state: "start" }); }
        else if (event.type === "content_block_delta") {
          if (event.delta?.type === "text_delta" && event.delta.text) emit({ type: "stream_text", text: event.delta.text });
          else if (event.delta?.type === "thinking_delta" && event.delta.thinking) emit({ type: "thinking_delta", text: event.delta.thinking });
        }
        else if (event.type === "content_block_stop") { emit({ type: "thinking", state: "end" }); }
      }
    }
  } catch (err: unknown) {
    // If the subprocess exited but we already have a response, return it.
    // Otherwise, re-throw so the retry/error handling picks it up.
    if (!state.result) throw err;
  }

  return state;
}

// --- Main entry point ---

export async function runAgentSdk(
  apiKey: string,
  model: string,
  systemPrompt: string,
  history: Message[],
  userMessage: string,
  opts?: AgentOpts,
): Promise<RunResult> {
  // Build effective prompt: if resuming, just use user message.
  // Otherwise, prepend history as structured context in the prompt itself
  // (the SDK manages its own conversation state via session resumption).
  let effectivePrompt = userMessage;
  if (!opts?.resumeSessionId && history.length > 0) {
    const historyText = history
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n\n");
    effectivePrompt = `<previous_conversation>\n${historyText}\n</previous_conversation>\n\n${userMessage}`;
  }

  const emit = opts?.onEvent;
  const toolIdCounter = { value: 0 };

  const preToolHook = createPreToolHook(opts, emit, toolIdCounter);
  const postToolHook = createPostToolHook(opts, emit, toolIdCounter);
  const mcpServer = createCamelAgiMcpServer(opts?.agentId, opts?.adminDeps);
  const queryOptions = buildQueryOptions(model, systemPrompt, apiKey, opts, preToolHook, postToolHook, mcpServer);

  const q = query({ prompt: effectivePrompt, options: queryOptions as any });
  const { result, sdkSessionId } = await processSdkMessages(q, emit, opts);

  const userMsg: Message = { role: "user", content: userMessage };
  const aiMsg: Message = { role: "assistant", content: result };
  return { response: result, newMessages: [userMsg, aiMsg], usage: null, sessionId: sdkSessionId };
}

/** Build environment variables for the SDK subprocess based on provider */
function buildSdkEnv(apiKey: string, provider?: string, baseUrl?: string): Record<string, string> {
  // OpenRouter: use ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
  if (baseUrl?.includes("openrouter")) {
    // SDK expects /api not /api/v1
    const sdkBaseUrl = baseUrl.replace(/\/v1\/?$/, "");
    return {
      ANTHROPIC_BASE_URL: sdkBaseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_API_KEY: "",
    };
  }

  // Direct Anthropic
  if (provider === "anthropic" || !provider) {
    return { ANTHROPIC_API_KEY: apiKey };
  }

  // Custom base URL (non-OpenRouter)
  if (baseUrl) {
    return {
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_BASE_URL: baseUrl,
    };
  }

  // Default
  return { ANTHROPIC_API_KEY: apiKey };
}
