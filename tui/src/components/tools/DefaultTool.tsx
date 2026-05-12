import type { ChatEntry } from "../../state/reducer.js"
import { theme } from "../../theme.js"
import { ToolHeader } from "./ToolHeader.js"

const PREVIEW_LINES = 6

type Tool = Extract<ChatEntry, { kind: "tool" }>

export function DefaultTool({ tool }: { tool: Tool }) {
  const argSummary = summarizeArgs(tool.args)
  const result = tool.result ?? (tool.status === "running" ? "" : "")
  const lines = result ? result.split("\n").filter(l => l.length > 0) : []
  const truncated = lines.length > PREVIEW_LINES
  const preview = truncated ? lines.slice(0, PREVIEW_LINES) : lines

  return (
    <box flexDirection="column" marginTop={1}>
      <ToolHeader tool={tool} primary={argSummary} />
      {preview.map((line, i) => (
        <text key={i} content={"    " + line} fg={theme.dim} />
      ))}
      {truncated ? (
        <text content={`    …(+${lines.length - PREVIEW_LINES} more)`} fg={theme.dim} />
      ) : null}
    </box>
  )
}

function summarizeArgs(args: Record<string, unknown>): string | undefined {
  const primary = (args.url ?? args.query ?? args.path ?? args.file_path) as string | undefined
  if (typeof primary === "string") return truncate(primary, 60)
  if (Object.keys(args).length === 0) return undefined
  try { return truncate(JSON.stringify(args), 80) } catch { return undefined }
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}
