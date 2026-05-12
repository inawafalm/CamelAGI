// Bottom row Claude Code-style:
//   [permission banner / status]              [token hint right-aligned]
// Replaced by SlashMenu when the user is composing a /command.

import { fg, t } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import type { ChatState } from "../state/reducer.js"
import type { PermissionMode } from "../agent/types.js"
import { theme } from "../theme.js"

export interface BottomBarProps {
  state: ChatState
}

export function BottomBar({ state }: BottomBarProps) {
  const { width } = useTerminalDimensions()
  const left = leftContent(state)
  const right = rightContent(state)
  const padded = padBetween(left.text, right.text, Math.max(40, width - 4))

  return (
    <box paddingLeft={1} paddingRight={1}>
      <text
        content={
          left.styled && right.styled
            ? t`${fg(left.color)(left.text)}${fg(theme.dim)(padded.spacer)}${fg(theme.dim)(right.text)}`
            : right.styled
              ? t`${fg(theme.dim)(left.text)}${fg(theme.dim)(padded.spacer)}${fg(theme.dim)(right.text)}`
              : t`${fg(left.color)(left.text)}${fg(theme.dim)(padded.spacer)}${fg(theme.dim)(right.text)}`
        }
      />
    </box>
  )
}

function leftContent(state: ChatState): { text: string; color: string; styled: boolean } {
  if (state.permissionMode === "default") {
    return { text: "", color: theme.dim, styled: false }
  }
  const { label, color } = banner(state.permissionMode)
  const hint = isBusy(state.status)
    ? "(shift+tab to cycle · esc to interrupt)"
    : "(shift+tab to cycle)"
  return { text: `▶▶ ${label} ${hint}`, color, styled: true }
}

function rightContent(state: ChatState): { text: string; styled: boolean } {
  const total = state.usage ? state.usage.inputTokens + state.usage.outputTokens : 0
  if (total > 0) return { text: `new task? /clear to save ${formatTokens(total)} tokens`, styled: true }
  return { text: "", styled: false }
}

function banner(mode: PermissionMode): { label: string; color: string } {
  switch (mode) {
    case "acceptEdits":       return { label: "accept edits on", color: theme.modeAcceptEdits }
    case "bypassPermissions": return { label: "bypass permissions on", color: theme.modeBypass }
    case "plan":              return { label: "plan mode on", color: theme.modePlan }
    default:                  return { label: "", color: theme.dim }
  }
}

function isBusy(s: ChatState["status"]) {
  return s === "thinking" || s === "streaming" || s === "awaiting_approval"
}

function padBetween(left: string, right: string, width: number): { spacer: string } {
  const gap = Math.max(2, width - left.length - right.length)
  return { spacer: " ".repeat(gap) }
}

function formatTokens(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
