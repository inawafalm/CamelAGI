// Path 2: OpenAI-compatible with tool loop (any provider)

import OpenAI from "openai";
import type { Message, ToolDef } from "../core/types.js";
import { recordUsage } from "../usage.js";
import { runHooks } from "../extensions/hooks.js";
import { DEFAULT_MAX_TURNS } from "../core/constants.js";
import { adaptToolDefToOpenAI } from "./tool-adapter.js";
import { memorySearchTool, memoryGetTool, createScopedMemoryTools } from "../tools/memory.js";
import { agentMemoryDir } from "../workspace.js";
import { patchTool } from "../tools/patch.js";
import { cronTool } from "../tools/cron.js";
import type { RunResult, AgentOpts } from "./types.js";

/** Get all custom tool definitions for an agent */
function getToolDefs(agentId?: string): ToolDef[] {
  const memRoot = agentMemoryDir(agentId);
  const scopedMemory = agentId
    ? createScopedMemoryTools(memRoot)
    : { search: memorySearchTool, get: memoryGetTool };

  return [scopedMemory.search, scopedMemory.get, patchTool, cronTool];
}

export async function runAgentOpenAI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  history: Message[],
  userMessage: string,
  opts?: AgentOpts,
): Promise<RunResult> {
  const emit = opts?.onEvent;

  // Use `any[]` for the messages array — OpenAI SDK accepts this and it avoids
  // importing complex union types that differ across SDK versions.
  const messages: any[] = [
    { role: "system", content: systemPrompt },
  ];

  for (const m of history) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.content });
    }
  }

  messages.push({ role: "user", content: userMessage });

  let baseUrl = opts?.baseUrl;
  if (!baseUrl) {
    if (opts?.provider === "openai") baseUrl = "https://api.openai.com/v1";
    else if (opts?.provider === "anthropic") baseUrl = "https://api.anthropic.com/v1/";
  }

  const client = new OpenAI({
    apiKey,
    ...(baseUrl && { baseURL: baseUrl }),
  });

  // Convert tool definitions to OpenAI format
  const toolDefs = getToolDefs(opts?.agentId);
  const tools = toolDefs.map(adaptToolDefToOpenAI);
  const toolMap = new Map(toolDefs.map(t => [t.name, t]));

  const maxTurns = opts?.maxTurns ?? DEFAULT_MAX_TURNS;
  let result = "";
  let toolIdCounter = 0;

  // Tool loop: keep calling until no tool_calls or maxTurns exhausted
  for (let turn = 0; turn < maxTurns; turn++) {
    if (opts?.signal?.aborted) throw new Error("Aborted");

    const stream = await client.chat.completions.create({
      model,
      messages,
      stream: true,
      ...(tools.length > 0 && { tools }),
    });

    let content = "";
    const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

    for await (const chunk of stream) {
      if (opts?.signal?.aborted) throw new Error("Aborted");

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      // Accumulate content
      const delta = choice.delta;
      if (delta?.content) {
        content += delta.content;
        emit?.({ type: "stream_text", text: delta.content });
      }

      // Accumulate tool calls from deltas
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCalls.has(idx)) {
            toolCalls.set(idx, { id: tc.id ?? `tool-${++toolIdCounter}`, name: tc.function?.name ?? "", args: "" });
          }
          const entry = toolCalls.get(idx)!;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
        }
      }

      // Report usage from the final chunk
      if (chunk.usage && opts?.sessionId) {
        recordUsage(opts.sessionId, {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
        emit?.({
          type: "usage",
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        });
      }
    }

    // No tool calls — we're done
    if (toolCalls.size === 0) {
      result = content;
      break;
    }

    // Build assistant message with tool calls
    const assistantToolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
    for (const [, tc] of toolCalls) {
      assistantToolCalls.push({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.args },
      });
    }

    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: assistantToolCalls,
    });

    // Execute tool calls and append results
    for (const [, tc] of toolCalls) {
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(tc.args || "{}");
      } catch {
        parsedArgs = {};
      }

      // Pre-tool hook
      if (opts?.hooksEnabled) {
        await runHooks("before_tool", {
          sessionId: opts.sessionId,
          toolName: tc.name,
          toolArgs: parsedArgs,
        });
      }

      if (emit) {
        emit({ type: "tool_call", id: tc.id, name: tc.name, args: parsedArgs });
      } else {
        const argsStr = JSON.stringify(parsedArgs).slice(0, 120);
        process.stderr.write(`\x1b[36m  → ${tc.name}\x1b[0m\x1b[90m(${argsStr})\x1b[0m\n`);
      }

      // Execute tool
      let toolResult: string;
      const toolDef = toolMap.get(tc.name);
      if (toolDef) {
        try {
          toolResult = await toolDef.execute(parsedArgs);
        } catch (err: unknown) {
          toolResult = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        toolResult = `ERROR: Unknown tool "${tc.name}"`;
      }

      // Post-tool hook
      if (opts?.hooksEnabled) {
        await runHooks("after_tool", {
          sessionId: opts.sessionId,
          toolName: tc.name,
          toolResult,
        });
      }

      const preview = toolResult.slice(0, 150).replace(/\n/g, "↵");
      if (emit) {
        emit({ type: "tool_result", id: tc.id, name: tc.name, preview });
      } else {
        process.stderr.write(`\x1b[90m  ← ${preview}${toolResult.length > 150 ? "…" : ""}\x1b[0m\n`);
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: toolResult,
      });
    }

    // Last turn — force a final completion without tools
    if (turn === maxTurns - 1) {
      result = content;
    }
  }

  // If we never got a final text response, do one more call without tools
  if (!result && messages[messages.length - 1].role === "tool") {
    const finalStream = await client.chat.completions.create({
      model,
      messages,
      stream: true,
    });

    for await (const chunk of finalStream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        result += delta;
        emit?.({ type: "stream_text", text: delta });
      }
    }
  }

  emit?.({ type: "chunk", text: result });

  const userMsg: Message = { role: "user", content: userMessage };
  const aiMsg: Message = { role: "assistant", content: result };
  return { response: result, newMessages: [userMsg, aiMsg], usage: null };
}
