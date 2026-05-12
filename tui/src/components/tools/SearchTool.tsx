import { fg, t } from "@opentui/core"
import type { ChatEntry } from "../../state/reducer.js"
import { theme } from "../../theme.js"
import { ToolHeader } from "./ToolHeader.js"

type Tool = Extract<ChatEntry, { kind: "tool" }>

export function SearchTool({ tool }: { tool: Tool }) {
  const pattern = String(tool.args.pattern ?? tool.args.query ?? "")
  const path = tool.args.path ? String(tool.args.path) : undefined
  const result = tool.result ?? ""
  const matchLines = result.split("\n").filter(l => l.trim().length > 0)
  const summary = tool.status === "running"
    ? "searching…"
    : tool.status === "done"
      ? `${matchLines.length} match${matchLines.length === 1 ? "" : "es"}`
      : ""

  return (
    <box flexDirection="column" marginTop={1}>
      <ToolHeader tool={tool} primary={pattern} secondary={path} />
      {summary ? (
        <text content={t`  ${fg(theme.branch)("└ ")}${fg(theme.dim)(summary)}`} />
      ) : null}
    </box>
  )
}
