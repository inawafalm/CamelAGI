// Normalize raw stream-json events from node-host/host.mjs into the typed
// AgentEvent union. Direct port of liquidagente-desktop/src/lib/localAgent.ts:58-188.
// Keep these two in lockstep — divergence here means the TUI silently
// misses events the React app handles.

import type { AgentEvent, UsageInfo } from "./types.js"

type Raw = Record<string, unknown>

const PERMISSION_DENIAL_MARKERS = [
  "requested permissions",
  "requires approval",
  "haven't granted",
  "multiple operations",
  "permission denied",
  "not allowed",
]

export function parseEvent(raw: Raw): AgentEvent[] {
  const out: AgentEvent[] = []
  const type = raw.type as string

  if (type === "error" || type === "host_error") {
    out.push({ type: "error", message: String(raw.message ?? "unknown error") })
    return out
  }

  if (type === "approval-request") {
    out.push({
      type: "approval_request",
      request: {
        id: String(raw.id ?? ""),
        tool: String(raw.tool ?? ""),
        input: (raw.input as Record<string, unknown>) ?? {},
        blockedPath: raw.blockedPath as string | undefined,
        decisionReason: raw.decisionReason as string | undefined,
      },
    })
    return out
  }

  if (type === "system") {
    const subtype = raw.subtype as string
    if (subtype === "init") {
      out.push({ type: "init", sessionId: String(raw.session_id ?? "") })
    } else if (subtype === "task_started") {
      out.push({
        type: "subagent_start",
        agentId: String(raw.agent_id ?? "subagent"),
        taskId: raw.task_id as string | undefined,
      })
    } else if (subtype === "task_progress") {
      const ms = raw.duration_ms as number | undefined
      out.push({
        type: "subagent_progress",
        agentId: String(raw.agent_id ?? "subagent"),
        toolCount: raw.tool_count as number | undefined,
        duration: ms ? Math.round(ms / 1000) : undefined,
      })
    } else if (subtype === "task_notification") {
      out.push({
        type: "subagent_done",
        agentId: String(raw.agent_id ?? "subagent"),
        toolUseId: raw.tool_use_id as string | undefined,
      })
    }
    return out
  }

  if (type === "assistant") {
    const msg = raw.message as Raw | undefined
    const content = msg?.content as Array<Raw> | undefined
    if (!content) return out
    for (const block of content) {
      if (block.type === "text" && block.text) {
        out.push({ type: "stream_text", text: String(block.text) })
      } else if (block.type === "tool_use") {
        out.push({
          type: "tool_call",
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          args: (block.input as Record<string, unknown>) ?? {},
        })
      }
    }
    return out
  }

  if (type === "user") {
    const msg = raw.message as Raw | undefined
    const content = msg?.content as Array<Raw> | undefined
    if (!content) return out
    for (const block of content) {
      if (block.type !== "tool_result") continue
      const resultContent = block.content
      let preview = ""
      if (typeof resultContent === "string") {
        preview = resultContent
      } else if (Array.isArray(resultContent)) {
        preview = (resultContent as Array<Raw>)
          .filter(b => b.type === "text")
          .map(b => String(b.text ?? ""))
          .join("\n")
      }
      const isError = block.is_error === true
      const isPermissionDenial = isError && PERMISSION_DENIAL_MARKERS.some(m => preview.includes(m))
      if (isPermissionDenial) {
        out.push({
          type: "permission_denied",
          id: String(block.tool_use_id ?? ""),
          message: preview,
        })
      }
      out.push({
        type: "tool_result",
        id: String(block.tool_use_id ?? ""),
        preview: preview.slice(0, 2000),
        isError,
      })
    }
    return out
  }

  if (type === "result") {
    const usage = parseUsage(raw.usage as Raw | undefined)
    if (usage) out.push({ type: "usage", usage })
    out.push({
      type: "done",
      response: String(raw.result ?? ""),
      subtype: raw.subtype as string | undefined,
      usage,
    })
    return out
  }

  if (type === "tool_use") {
    out.push({
      type: "tool_call",
      id: String(raw.tool_use_id ?? ""),
      name: String(raw.name ?? ""),
      args: (raw.input as Record<string, unknown>) ?? {},
    })
    return out
  }

  if (type === "tool_result") {
    out.push({
      type: "tool_result",
      id: String(raw.tool_use_id ?? ""),
      preview: String(raw.content ?? ""),
    })
    return out
  }

  if (type === "stream_event") {
    const event = raw.event as Raw | undefined
    if (!event) return out
    if (event.type === "content_block_start" && (event.content_block as Raw)?.type === "thinking") {
      out.push({ type: "thinking", state: "start" })
    } else if (event.type === "content_block_delta") {
      const delta = event.delta as Raw | undefined
      if (delta?.type === "text_delta" && delta.text) {
        out.push({ type: "stream_text", text: String(delta.text) })
      } else if (delta?.type === "thinking_delta" && delta.thinking) {
        out.push({ type: "thinking_delta", text: String(delta.thinking) })
      }
    } else if (event.type === "content_block_stop") {
      out.push({ type: "thinking", state: "end" })
    }
    return out
  }

  return out
}

function parseUsage(u: Raw | undefined): UsageInfo | undefined {
  if (!u) return undefined
  return {
    inputTokens: Number(u.input_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
    cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
    cacheWriteTokens: Number(u.cache_creation_input_tokens ?? 0),
  }
}
