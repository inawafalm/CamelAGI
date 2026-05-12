import { fg, t } from "@opentui/core"
import type { ChatEntry } from "../../state/reducer.js"
import { theme } from "../../theme.js"
import { ToolHeader } from "./ToolHeader.js"
import { DiffView, diffStats } from "./DiffView.js"

type Tool = Extract<ChatEntry, { kind: "tool" }>

export function EditTool({ tool }: { tool: Tool }) {
  const filePath = String(tool.args.file_path ?? "")
  const oldString = String(tool.args.old_string ?? "")
  const newString = String(tool.args.new_string ?? "")

  const showDiff = tool.status !== "denied" && tool.status !== "error"
  const stats = diffStats(oldString, newString)

  return (
    <box flexDirection="column" width="100%" marginTop={1}>
      <ToolHeader
        tool={tool}
        primary={shortenPath(filePath)}
        secondary={`+${stats.added} -${stats.removed}`}
        verbOverride="Updated"
      />
      {showDiff ? (
        <box flexDirection="column" width="100%" paddingLeft={2}>
          <DiffView oldText={oldString} newText={newString} />
        </box>
      ) : null}
      {tool.result && (tool.status === "error" || tool.status === "denied") ? (
        <text content={t`  ${fg(theme.branch)("└ ")}${fg(theme.toolError)(tool.result)}`} />
      ) : null}
    </box>
  )
}

function shortenPath(p: string): string {
  const parts = p.split("/")
  if (parts.length <= 2) return p
  return ".../" + parts.slice(-2).join("/")
}
