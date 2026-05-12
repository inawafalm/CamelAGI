// Pure reducer: (state, event) => state. The component tree is a function
// of state, not events — so streaming, retries, and approvals are all just
// state transitions. Keep this file free of any I/O or side effects.

import type { AgentEvent, ApprovalRequest, PermissionMode, UsageInfo } from "../agent/types.js"

export type ChatStatus = "idle" | "thinking" | "streaming" | "awaiting_approval" | "error"

export type ChatEntry =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; thinking: string; streaming: boolean }
  | {
      kind: "tool"
      id: string
      name: string
      args: Record<string, unknown>
      status: "running" | "done" | "error" | "denied"
      result?: string
    }
  | { kind: "subagent"; id: string; agentId: string; toolCount?: number; duration?: number; done: boolean }
  | { kind: "system"; id: string; text: string; tone?: "info" | "warn" | "error" }
  | { kind: "divider"; id: string }

export interface ChatState {
  entries: ChatEntry[]
  status: ChatStatus
  pendingApproval: ApprovalRequest | null
  permissionMode: PermissionMode
  sessionId: string | null
  usage: UsageInfo | null
  liveTokens: number
  runStartedAt: number | null
  activityLabel: string | null
  error: string | null
}

export const initialState: ChatState = {
  entries: [],
  status: "idle",
  pendingApproval: null,
  permissionMode: "bypassPermissions",
  sessionId: null,
  usage: null,
  liveTokens: 0,
  runStartedAt: null,
  activityLabel: null,
  error: null,
}

export type StateAction =
  | { type: "user_submit"; text: string }
  | { type: "agent_event"; event: AgentEvent }
  | { type: "set_permission_mode"; mode: PermissionMode }
  | { type: "approval_resolved" }
  | { type: "system_note"; text: string; tone?: "info" | "warn" | "error" }
  | { type: "clear" }
  | { type: "abort" }

let nextId = 0
const newId = (prefix: string) => `${prefix}-${++nextId}`

export function reduce(state: ChatState, action: StateAction): ChatState {
  switch (action.type) {
    case "user_submit":
      return {
        ...state,
        entries: [
          ...state.entries,
          { kind: "user", id: newId("u"), text: action.text },
        ],
        status: "thinking",
        liveTokens: 0,
        runStartedAt: Date.now(),
        activityLabel: "Thinking",
        error: null,
      }

    case "agent_event":
      return reduceEvent(state, action.event)

    case "set_permission_mode":
      return { ...state, permissionMode: action.mode }

    case "approval_resolved":
      return {
        ...state,
        pendingApproval: null,
        status: state.status === "awaiting_approval" ? "thinking" : state.status,
      }

    case "system_note":
      return {
        ...state,
        entries: [
          ...state.entries,
          { kind: "system", id: newId("sys"), text: action.text, tone: action.tone },
        ],
      }

    case "clear":
      return { ...initialState, permissionMode: state.permissionMode }

    case "abort":
      return {
        ...state,
        status: "idle",
        runStartedAt: null,
        activityLabel: null,
        entries: finalizeStreaming(state.entries),
      }
  }
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

function reduceEvent(state: ChatState, ev: AgentEvent): ChatState {
  switch (ev.type) {
    case "init":
      return { ...state, sessionId: ev.sessionId || state.sessionId }

    case "stream_text": {
      const entries = appendAssistantText(state.entries, ev.text)
      return {
        ...state,
        entries,
        status: "streaming",
        activityLabel: "Responding",
        liveTokens: state.liveTokens + estimateTokens(ev.text),
      }
    }

    case "thinking_delta": {
      const entries = appendAssistantThinking(state.entries, ev.text)
      return {
        ...state,
        entries,
        status: "thinking",
        activityLabel: "Thinking",
        liveTokens: state.liveTokens + estimateTokens(ev.text),
      }
    }

    case "thinking":
      return state

    case "tool_call": {
      const entry: ChatEntry = {
        kind: "tool",
        id: ev.id,
        name: ev.name,
        args: ev.args,
        status: "running",
      }
      return {
        ...state,
        entries: [...finalizeStreaming(state.entries), entry],
        status: "thinking",
        activityLabel: `Running ${ev.name}`,
      }
    }

    case "tool_result": {
      const entries = state.entries.map(e => {
        if (e.kind !== "tool" || e.id !== ev.id) return e
        return {
          ...e,
          status: ev.isError ? ("error" as const) : ("done" as const),
          result: ev.preview,
        }
      })
      return { ...state, entries, activityLabel: "Thinking" }
    }

    case "approval_request":
      return {
        ...state,
        pendingApproval: ev.request,
        status: "awaiting_approval",
      }

    case "permission_denied": {
      const entries = state.entries.map(e =>
        e.kind === "tool" && e.id === ev.id
          ? { ...e, status: "denied" as const, result: ev.message }
          : e
      )
      return { ...state, entries }
    }

    case "subagent_start":
      return {
        ...state,
        entries: [
          ...finalizeStreaming(state.entries),
          { kind: "subagent", id: newId("sa"), agentId: ev.agentId, done: false },
        ],
      }

    case "subagent_progress": {
      const entries = updateLatestSubagent(state.entries, ev.agentId, sa => ({
        ...sa,
        toolCount: ev.toolCount ?? sa.toolCount,
        duration: ev.duration ?? sa.duration,
      }))
      return { ...state, entries }
    }

    case "subagent_done": {
      const entries = updateLatestSubagent(state.entries, ev.agentId, sa => ({ ...sa, done: true }))
      return { ...state, entries }
    }

    case "usage":
      return { ...state, usage: ev.usage }

    case "done":
      return {
        ...state,
        entries: finalizeStreaming(state.entries),
        usage: ev.usage ?? state.usage,
        status: "idle",
        runStartedAt: null,
        activityLabel: null,
      }

    case "error":
      return {
        ...state,
        status: "error",
        error: ev.message,
        entries: [
          ...finalizeStreaming(state.entries),
          { kind: "system", id: newId("err"), text: ev.message, tone: "error" },
        ],
      }
  }
}

function appendAssistantText(entries: ChatEntry[], text: string): ChatEntry[] {
  const last = entries[entries.length - 1]
  if (last && last.kind === "assistant" && last.streaming) {
    return entries.map((e, i) =>
      i === entries.length - 1 && e.kind === "assistant"
        ? { ...e, text: e.text + text }
        : e
    )
  }
  return [
    ...entries,
    { kind: "assistant", id: newId("a"), text, thinking: "", streaming: true },
  ]
}

function appendAssistantThinking(entries: ChatEntry[], text: string): ChatEntry[] {
  const last = entries[entries.length - 1]
  if (last && last.kind === "assistant" && last.streaming) {
    return entries.map((e, i) =>
      i === entries.length - 1 && e.kind === "assistant"
        ? { ...e, thinking: e.thinking + text }
        : e
    )
  }
  return [
    ...entries,
    { kind: "assistant", id: newId("a"), text: "", thinking: text, streaming: true },
  ]
}

function finalizeStreaming(entries: ChatEntry[]): ChatEntry[] {
  return entries.map(e =>
    e.kind === "assistant" && e.streaming ? { ...e, streaming: false } : e
  )
}

function updateLatestSubagent(
  entries: ChatEntry[],
  agentId: string,
  fn: (sa: Extract<ChatEntry, { kind: "subagent" }>) => Extract<ChatEntry, { kind: "subagent" }>,
): ChatEntry[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === "subagent" && e.agentId === agentId && !e.done) {
      const updated = fn(e)
      return [...entries.slice(0, i), updated, ...entries.slice(i + 1)]
    }
  }
  return entries
}
