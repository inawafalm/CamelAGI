import { fg, t } from "@opentui/core"
import type { ChatEntry } from "../../state/reducer.js"
import { theme } from "../../theme.js"
import { ToolHeader } from "./ToolHeader.js"

const PREVIEW_LINES = 14

type Tool = Extract<ChatEntry, { kind: "tool" }>

export function WriteTool({ tool }: { tool: Tool }) {
  const filePath = String(tool.args.file_path ?? "")
  const content = String(tool.args.content ?? "")
  const lines = content.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  const truncated = lines.length > PREVIEW_LINES
  const preview = truncated ? lines.slice(0, PREVIEW_LINES) : lines

  return (
    <box flexDirection="column" width="100%" marginTop={1}>
      <ToolHeader
        tool={tool}
        primary={shortenPath(filePath)}
        secondary={`+${lines.length} -0`}
        verbOverride="Added"
      />
      <box flexDirection="column" width="100%" paddingLeft={2}>
        {preview.map((line, i) => {
          const num = String(i + 1).padStart(3, " ")
          return (
            <box key={i} width="100%" backgroundColor={theme.diffAdd}>
              <text
                content={`${num} +${line}`}
                fg={theme.diffAddFg}
                bg={theme.diffAdd}
              />
            </box>
          )
        })}
        {truncated ? (
          <text content={`  …(+${lines.length - PREVIEW_LINES} more)`} fg={theme.dim} />
        ) : null}
      </box>
      {tool.result && tool.status === "error" ? (
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
