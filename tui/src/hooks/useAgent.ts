// WebSocket-based agent hook. Connects to CamelAGI gateway and maps events
// into the same reducer dispatch calls the original spawn-based hook used.

import { useCallback, useEffect, useReducer, useRef } from "react"
import { parseEvent } from "../agent/parse.js"
import type { ApprovalBehavior, PermissionMode } from "../agent/types.js"
import { initialState, reduce } from "../state/reducer.js"
import { WS_URL } from "../config.js"

export interface UseAgentOptions {
  model: string
  effort?: string
  cwd: string
  wsUrl?: string
  token?: string
  sessionId?: string
}

export function useAgent(opts: UseAgentOptions) {
  const [state, dispatch] = useReducer(reduce, initialState)
  const wsRef = useRef<WebSocket | null>(null)
  const runningRef = useRef(false)
  const optsRef = useRef(opts)
  optsRef.current = opts
  const sessionIdRef = useRef(opts.sessionId ?? `tui-${Date.now()}`)

  // Connect WebSocket on mount
  useEffect(() => {
    const url = opts.wsUrl ?? WS_URL
    const fullUrl = opts.token ? `${url}?token=${opts.token}` : url
    const ws = new WebSocket(fullUrl)
    wsRef.current = ws

    ws.addEventListener("open", () => {
      dispatch({ type: "system_note", text: "Connected to gateway" })
    })

    ws.addEventListener("message", (event) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }

      const type = msg.type as string

      // Gateway-specific messages that aren't standard agent events
      if (type === "done") {
        const usage = msg.usage as Record<string, unknown> | undefined
        dispatch({
          type: "agent_event",
          event: {
            type: "done",
            response: String(msg.response ?? ""),
            usage: usage ? {
              inputTokens: Number(usage.inputTokens ?? 0),
              outputTokens: Number(usage.outputTokens ?? 0),
              cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
              cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
            } : undefined,
          },
        })
        runningRef.current = false
        return
      }

      if (type === "error") {
        dispatch({
          type: "agent_event",
          event: { type: "error", message: String(msg.message ?? "Unknown error") },
        })
        runningRef.current = false
        return
      }

      if (type === "aborted") {
        dispatch({ type: "abort" })
        runningRef.current = false
        return
      }

      if (type === "compacted") {
        dispatch({
          type: "system_note",
          text: `History compacted: ${msg.oldCount} → ${msg.newCount} messages`,
        })
        return
      }

      if (type === "retry") {
        dispatch({
          type: "system_note",
          text: `Retrying (attempt ${msg.attempt}, ${msg.kind})...`,
          tone: "warn",
        })
        return
      }

      if (type === "queued") {
        dispatch({ type: "system_note", text: "Message queued — waiting for current run to finish" })
        return
      }

      if (type === "model.switched") {
        dispatch({
          type: "system_note",
          text: `Model: ${msg.model}${msg.thinking ? ` | Thinking: ${msg.thinking}` : ""}${msg.effort ? ` | Effort: ${msg.effort}` : ""}`,
        })
        return
      }

      // Standard agent events — parse through the same pipeline as spawn mode
      const events = parseEvent(msg)
      for (const ev of events) {
        dispatch({ type: "agent_event", event: ev })
      }
    })

    ws.addEventListener("close", () => {
      dispatch({ type: "system_note", text: "Disconnected from gateway", tone: "warn" })
      wsRef.current = null
      runningRef.current = false
    })

    ws.addEventListener("error", () => {
      dispatch({
        type: "agent_event",
        event: { type: "error", message: "WebSocket connection failed. Is the gateway running?" },
      })
    })

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [opts.wsUrl, opts.token])

  const wsSend = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      dispatch({
        type: "agent_event",
        event: { type: "error", message: "Not connected to gateway" },
      })
      return
    }
    ws.send(JSON.stringify(msg))
  }, [])

  const submit = useCallback((prompt: string) => {
    if (runningRef.current) return

    dispatch({ type: "user_submit", text: prompt })
    runningRef.current = true

    wsSend({
      type: "chat",
      message: prompt,
      session: sessionIdRef.current,
    })
  }, [wsSend])

  const respondToApproval = useCallback((behavior: ApprovalBehavior) => {
    if (!state.pendingApproval) return
    wsSend({
      type: "approval.decide",
      id: state.pendingApproval.id,
      decision: behavior === "allow" ? "allow-once" : "deny",
    })
    dispatch({ type: "approval_resolved" })
  }, [state.pendingApproval, wsSend])

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    dispatch({ type: "set_permission_mode", mode })
  }, [])

  const abort = useCallback(() => {
    wsSend({ type: "abort" })
    runningRef.current = false
    dispatch({ type: "abort" })
  }, [wsSend])

  const clear = useCallback(() => {
    abort()
    sessionIdRef.current = `tui-${Date.now()}`
    dispatch({ type: "clear" })
  }, [abort])

  const pushSystem = useCallback((text: string, tone?: "info" | "warn" | "error") => {
    dispatch({ type: "system_note", text, tone })
  }, [])

  const switchModel = useCallback((model: string, thinking?: string, effort?: string) => {
    wsSend({ type: "model.switch", model, thinking, effort })
  }, [wsSend])

  return {
    state, submit, respondToApproval, setPermissionMode, abort, clear,
    pushSystem, switchModel, wsSend, sessionId: sessionIdRef.current,
  }
}
