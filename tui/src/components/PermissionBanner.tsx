import { fg, t } from "@opentui/core"
import type { PermissionMode } from "../agent/types.js"
import { theme } from "../theme.js"

const ORDER: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan"]

export function nextMode(current: PermissionMode): PermissionMode {
  const i = ORDER.indexOf(current)
  return ORDER[(i + 1) % ORDER.length]
}

export function PermissionBanner({ mode, busy }: { mode: PermissionMode; busy?: boolean }) {
  if (mode === "default") return null
  const { label, color } = banner(mode)
  const hint = busy
    ? "(shift+tab to cycle · esc to interrupt)"
    : "(shift+tab to cycle)"
  return (
    <text content={t`${fg(color)("▶▶ ")}${fg(color)(label)} ${fg(theme.dim)(hint)}`} />
  )
}

function banner(mode: PermissionMode): { label: string; color: string } {
  switch (mode) {
    case "acceptEdits":       return { label: "accept edits on", color: theme.modeAcceptEdits }
    case "bypassPermissions": return { label: "bypass permissions on", color: theme.modeBypass }
    case "plan":              return { label: "plan mode on", color: theme.modePlan }
    default:                  return { label: "", color: theme.dim }
  }
}
