// Codex-style Bash block: action header + brief description, no stdout
// dump (the agent summarizes the output in its response — showing it twice
// just clutters the chat). Command is kept on a dim secondary line so it's
// still visible when you need it.

import { fg, t } from "@opentui/core"
import type { ChatEntry } from "../../state/reducer.js"
import { theme } from "../../theme.js"
import { ToolHeader } from "./ToolHeader.js"

type Tool = Extract<ChatEntry, { kind: "tool" }>

export function BashTool({ tool }: { tool: Tool }) {
  const command = String(tool.args.command ?? "")
  const description = tool.args.description ? String(tool.args.description) : undefined
  // Surface the agent's description as the tool subtitle (Codex pattern).
  // The actual command stays one line below in dim.
  return (
    <box flexDirection="column" marginTop={1}>
      <ToolHeader tool={tool} primary={undefined} secondary={description ?? command} verbOverride="Ran" />
      <text content={t`  ${fg(theme.branch)("└ ")}${fg(theme.dim)("$ " + command)}`} />
      {tool.status === "error" && tool.result ? (
        <text content={t`  ${fg(theme.branch)("└ ")}${fg(theme.toolError)((tool.result.split("\n")[0] ?? "").slice(0, 200))}`} />
      ) : null}
    </box>
  )
}
