// Renders a run of consecutive Edit/Write tools on the same file as a
// single block. Avoids the "Updated math.swift" header repeating 7×
// when the agent batches edits.

import { fg, t } from "@opentui/core"
import type { ChatEntry } from "../../state/reducer.js"
import { theme } from "../../theme.js"
import { ToolHeader } from "./ToolHeader.js"
import { DiffView, diffStats } from "./DiffView.js"

type Tool = Extract<ChatEntry, { kind: "tool" }>

export function EditGroup({ tools }: { tools: Tool[] }) {
  if (tools.length === 1) {
    // Group of 1 — caller should have rendered the single tool directly,
    // but handle gracefully.
  }

  const filePath = String(tools[0]!.args.file_path ?? "")
  const allWrites = tools.every(t => t.name === "Write")
  const verb = allWrites ? "Added" : "Updated"

  // Aggregate stats across every edit in the group.
  let totalAdd = 0
  let totalRemove = 0
  for (const tool of tools) {
    if (tool.name === "Write") {
      const c = String(tool.args.content ?? "")
      const lines = c.split("\n")
      if (lines[lines.length - 1] === "") lines.pop()
      totalAdd += lines.length
    } else {
      const s = diffStats(
        String(tool.args.old_string ?? ""),
        String(tool.args.new_string ?? ""),
      )
      totalAdd += s.added
      totalRemove += s.removed
    }
  }

  // Use the latest tool's status for the header glyph (running/done/error).
  const headerTool = tools[tools.length - 1]!

  return (
    <box flexDirection="column" width="100%" marginTop={1}>
      <ToolHeader
        tool={headerTool}
        primary={shortenPath(filePath)}
        secondary={`+${totalAdd} -${totalRemove}  ·  ${tools.length} edits`}
        verbOverride={verb}
      />
      <box flexDirection="column" width="100%" paddingLeft={2}>
        {tools.map((tool, i) => (
          <Hunk key={tool.id} tool={tool} index={i} total={tools.length} />
        ))}
      </box>
    </box>
  )
}

function Hunk({ tool, index, total }: { tool: Tool; index: number; total: number }) {
  const showSep = index < total - 1
  if (tool.name === "Write") {
    const content = String(tool.args.content ?? "")
    const lines = content.split("\n")
    if (lines[lines.length - 1] === "") lines.pop()
    return (
      <box flexDirection="column" width="100%">
        {lines.map((line, i) => {
          const num = String(i + 1).padStart(3, " ")
          return (
            <box key={i} width="100%" backgroundColor={theme.diffAdd}>
              <text content={`${num} +${line}`} fg={theme.diffAddFg} bg={theme.diffAdd} />
            </box>
          )
        })}
        {showSep ? <text content={t`${fg(theme.dim)("  ⋯")}`} /> : null}
      </box>
    )
  }
  return (
    <box flexDirection="column" width="100%">
      <DiffView
        oldText={String(tool.args.old_string ?? "")}
        newText={String(tool.args.new_string ?? "")}
      />
      {showSep ? <text content={t`${fg(theme.dim)("  ⋯")}`} /> : null}
    </box>
  )
}

function shortenPath(p: string): string {
  const parts = p.split("/")
  if (parts.length <= 2) return p
  return ".../" + parts.slice(-2).join("/")
}
