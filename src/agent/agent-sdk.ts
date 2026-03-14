// Path 1: Claude Agent SDK (full agent with tools, thinking, subagents)

import { query, createSdkMcpServer, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { Message } from "../core/types.js";
import type { ToolDef } from "../core/types.js";
import { memorySearchTool, memoryGetTool, createScopedMemoryTools } from "../tools/memory.js";
import { agentMemoryDir } from "../workspace.js";
import { patchTool } from "../tools/patch.js";
import { cronTool } from "../tools/cron.js";
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
function createCamelAgiMcpServer(agentId?: string) {
  const defs = getToolDefs(agentId);
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
  let toolIdCounter = 0;

  const preToolHook: HookCallback = async (input: Record<string, unknown>) => {
    const name = (input.tool_name ?? input.name ?? "tool") as string;
    const args = (input.tool_input ?? input.input ?? {}) as Record<string, unknown>;
    const toolId = (input.tool_use_id ?? `tool-${++toolIdCounter}`) as string;

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

  const postToolHook: HookCallback = async (input: Record<string, unknown>) => {
    const name = (input.tool_name ?? input.name ?? "tool") as string;
    const toolId = (input.tool_use_id ?? `tool-${toolIdCounter}`) as string;
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

  const mcpServer = createCamelAgiMcpServer(opts?.agentId);

  const thinking = opts?.thinking && opts.thinking !== "off"
    ? { type: "adaptive" as const }
    : { type: "disabled" as const };

  const disallowedTools = opts?.toolPolicy?.deny?.length ? opts.toolPolicy.deny : undefined;

  const abortController = opts?.signal ? new AbortController() : undefined;
  if (opts?.signal && abortController) {
    if (opts.signal.aborted) abortController.abort();
    else opts.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  let result = "";
  let sdkSessionId: string | undefined;

  const q = query({
    prompt: effectivePrompt,
    options: {
      model,
      systemPrompt,
      allowedTools: [...BUILTIN_TOOLS],
      ...(disallowedTools && { disallowedTools }),
      mcpServers: { camelagi: mcpServer },
      maxTurns: opts?.maxTurns ?? DEFAULT_MAX_TURNS,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      cwd: process.cwd(),
      env: { ANTHROPIC_API_KEY: apiKey },
      thinking,
      ...(opts?.effort && { effort: opts.effort }),
      ...(opts?.maxBudgetUsd && { maxBudgetUsd: opts.maxBudgetUsd }),
      ...(opts?.resumeSessionId && { resume: opts.resumeSessionId }),
      ...(abortController && { abortController }),
      includePartialMessages: !!emit,
      settingSources: ["project"],
      hooks: {
        PreToolUse: [{ matcher: ".*", hooks: [preToolHook] }],
        PostToolUse: [{ matcher: ".*", hooks: [postToolHook] }],
      },
    },
  });

  for await (const message of q) {
    if (message.type === "result") {
      const resultMsg = message as unknown as {
        type: "result"; result: string; session_id?: string;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      };
      result = resultMsg.result;
      sdkSessionId = resultMsg.session_id;

      if (resultMsg.usage && emit) {
        emit({ type: "usage", inputTokens: resultMsg.usage.input_tokens ?? 0, outputTokens: resultMsg.usage.output_tokens ?? 0, cacheReadTokens: resultMsg.usage.cache_read_input_tokens, cacheWriteTokens: resultMsg.usage.cache_creation_input_tokens });
      }
      if (resultMsg.usage && opts?.sessionId) {
        recordUsage(opts.sessionId, { inputTokens: resultMsg.usage.input_tokens ?? 0, outputTokens: resultMsg.usage.output_tokens ?? 0, cacheReadTokens: resultMsg.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: resultMsg.usage.cache_creation_input_tokens ?? 0 });
      }
      emit?.({ type: "chunk", text: result });
    } else if (message.type === "system" && emit) {
      const sysMsg = message as unknown as { type: "system"; subtype?: string; session_id?: string; agent_id?: string; task_id?: string; tool_use_id?: string; tool_count?: number; duration_ms?: number };
      if (sysMsg.subtype === "init" && sysMsg.session_id) { sdkSessionId = sysMsg.session_id; emit({ type: "init", sessionId: sysMsg.session_id }); }
      else if (sysMsg.subtype === "task_started") { emit({ type: "subagent_start", agentId: sysMsg.agent_id ?? "subagent", taskId: sysMsg.task_id }); }
      else if (sysMsg.subtype === "task_progress") { emit({ type: "subagent_progress", agentId: sysMsg.agent_id ?? "subagent", toolCount: sysMsg.tool_count, duration: sysMsg.duration_ms ? Math.round(sysMsg.duration_ms / 1000) : undefined }); }
      else if (sysMsg.subtype === "task_notification") { emit({ type: "subagent_done", agentId: sysMsg.agent_id ?? "subagent", toolUseId: sysMsg.tool_use_id }); }
    } else if (message.type === "stream_event" && emit) {
      const streamMsg = message as unknown as { type: "stream_event"; event: { type: string; content_block?: { type: string }; delta?: { type: string; text?: string; thinking?: string } } };
      const event = streamMsg.event;
      if (event.type === "content_block_start" && event.content_block?.type === "thinking") { emit({ type: "thinking", state: "start" }); }
      else if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta" && event.delta.text) emit({ type: "stream_text", text: event.delta.text });
        else if (event.delta?.type === "thinking_delta" && event.delta.thinking) emit({ type: "thinking_delta", text: event.delta.thinking });
      }
      else if (event.type === "content_block_stop") { emit({ type: "thinking", state: "end" }); }
    }
  }

  const userMsg: Message = { role: "user", content: userMessage };
  const aiMsg: Message = { role: "assistant", content: result };
  return { response: result, newMessages: [userMsg, aiMsg], usage: null, sessionId: sdkSessionId };
}
