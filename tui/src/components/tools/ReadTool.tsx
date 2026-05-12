import { fg, t } from "@opentui/core"
import type { ChatEntry } from "../../state/reducer.js"
import { theme } from "../../theme.js"
import { ToolHeader } from "./ToolHeader.js"

type Tool = Extract<ChatEntry, { kind: "tool" }>

export function ReadTool({ tool }: { tool: Tool }) {
  const filePath = String(tool.args.file_path ?? "")
  const offset = tool.args.offset != null ? Number(tool.args.offset) : undefined
  const limit = tool.args.limit != null ? Number(tool.args.limit) : undefined

  const result = tool.result ?? ""
  const lineCount = result ? result.split("\n").length : 0
  const summary = tool.status === "running"
    ? "reading…"
    : tool.status === "done"
      ? `${lineCount} line${lineCount === 1 ? "" : "s"}`
      : tool.status === "error"
        ? (result || "error").split("\n")[0].slice(0, 80)
        : ""

  const range = offset != null || limit != null
    ? `lines ${offset ?? 1}–${limit ? (offset ?? 0) + limit : "end"}`
    : undefined

  return (
    <box flexDirection="column" marginTop={1}>
      <ToolHeader tool={tool} primary={shortenPath(filePath)} secondary={range} />
      {summary ? (
        <text content={t`  ${fg(theme.branch)("└ ")}${fg(theme.dim)(summary)}`} />
      ) : null}
    </box>
  )
}

function shortenPath(p: string): string {
  const parts = p.split("/")
  if (parts.length <= 2) return p
  return ".../" + parts.slice(-2).join("/")
}
