import { fg, t } from "@opentui/core"
import type { ChatEntry } from "../../state/reducer.js"
import { theme } from "../../theme.js"

type Tool = Extract<ChatEntry, { kind: "tool" }>

export function statusVisual(status: Tool["status"]) {
  switch (status) {
    case "running": return { glyph: "●", color: theme.toolRunning, label: "running" }
    case "done":    return { glyph: "●", color: theme.bullet,      label: "done" }
    case "error":   return { glyph: "✗", color: theme.toolError,   label: "error" }
    case "denied":  return { glyph: "⏸", color: theme.toolDenied,  label: "denied" }
  }
}

export function ToolHeader({
  tool,
  primary,
  secondary,
  verbOverride,
}: {
  tool: Tool
  primary?: string
  secondary?: string
  /** Display label (Codex action-verb style). Falls back to tool.name. */
  verbOverride?: string
}) {
  const { glyph, color } = statusVisual(tool.status)
  const name = verbOverride ?? toolVerb(tool.name)
  const content = primary && secondary
    ? t`${fg(color)(glyph + " ")}${fg(theme.assistant)(name)}  ${fg(theme.dim)(primary)}  ${fg(theme.dim)(secondary)}`
    : primary
      ? t`${fg(color)(glyph + " ")}${fg(theme.assistant)(name)}  ${fg(theme.dim)(primary)}`
      : secondary
        ? t`${fg(color)(glyph + " ")}${fg(theme.assistant)(name)}  ${fg(theme.dim)(secondary)}`
        : t`${fg(color)(glyph + " ")}${fg(theme.assistant)(name)}`
  return <text content={content} />
}

/** Map tool ids to action-verb labels (Codex aesthetic). Only the loud
 *  ones get verbs; everything else keeps its native name. */
function toolVerb(name: string): string {
  switch (name) {
    case "Bash": return "Ran"
    case "Glob": return "Searched"
    default:     return name
  }
}
