import { fg, t } from "@opentui/core"
import type { ChatEntry } from "../state/reducer.js"
import { theme } from "../theme.js"

type Subagent = Extract<ChatEntry, { kind: "subagent" }>

export function SubagentBlock({ entry }: { entry: Subagent }) {
  const parts = [`subagent: ${entry.agentId}`]
  if (entry.toolCount != null) parts.push(`${entry.toolCount} tools`)
  if (entry.duration != null) parts.push(`${entry.duration}s`)
  return (
    <box flexDirection="column" marginTop={1}>
      <text content={t`${fg(entry.done ? theme.toolDone : theme.accent)(entry.done ? "• " : "◆ ")}${fg(theme.assistant)(parts.join("  ·  "))}`} />
    </box>
  )
}
