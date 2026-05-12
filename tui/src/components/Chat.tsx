// Chat scrollback. Welcome banner pinned to the top of the history.
// Content flows top-down (Claude Code / Codex convention). When the
// conversation overflows the viewport, stickyScroll auto-scrolls to
// keep the latest message in view.

import type { ReactNode } from "react"
import type { ChatEntry } from "../state/reducer.js"
import { AssistantMessage, SystemMessage, UserMessage } from "./Message.js"
import { SubagentBlock } from "./SubagentBlock.js"
import { ToolBlock } from "./ToolBlock.js"
import { Divider } from "./Divider.js"
import { EditGroup } from "./tools/EditGroup.js"

type Tool = Extract<ChatEntry, { kind: "tool" }>

export interface ChatProps {
  entries: ChatEntry[]
  header?: ReactNode
}

export function Chat({ entries, header }: ChatProps) {
  const items = groupEntries(entries)
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
      {header}
      {items.map(item => {
        if (item.kind === "edit-group") {
          return <EditGroup key={item.tools[0]!.id} tools={item.tools} />
        }
        return renderEntry(item.entry)
      })}
    </scrollbox>
  )
}

function renderEntry(entry: ChatEntry): ReactNode {
  switch (entry.kind) {
    case "user":
      return <UserMessage key={entry.id} text={entry.text} />
    case "assistant":
      return (
        <AssistantMessage
          key={entry.id}
          text={entry.text}
          thinking={entry.thinking}
          streaming={entry.streaming}
        />
      )
    case "tool":
      return <ToolBlock key={entry.id} tool={entry} />
    case "subagent":
      return <SubagentBlock key={entry.id} entry={entry} />
    case "system":
      return <SystemMessage key={entry.id} text={entry.text} tone={entry.tone} />
    case "divider":
      return <Divider key={entry.id} />
  }
}

// ── grouping ───────────────────────────────────────────────────────

type RenderItem =
  | { kind: "single"; entry: ChatEntry }
  | { kind: "edit-group"; tools: Tool[] }

// Collapse runs of consecutive Edit/Write tools targeting the same file
// into a single render unit. Other entry kinds break the run.
function groupEntries(entries: ChatEntry[]): RenderItem[] {
  const out: RenderItem[] = []
  let buffer: Tool[] = []
  const flush = () => {
    if (buffer.length === 0) return
    if (buffer.length === 1) {
      out.push({ kind: "single", entry: buffer[0]! })
    } else {
      out.push({ kind: "edit-group", tools: buffer })
    }
    buffer = []
  }
  for (const e of entries) {
    if (e.kind === "tool" && (e.name === "Edit" || e.name === "Write")) {
      const path = String(e.args.file_path ?? "")
      const head = buffer[0]
      const headPath = head ? String(head.args.file_path ?? "") : null
      if (head && headPath === path) {
        buffer.push(e)
      } else {
        flush()
        buffer.push(e)
      }
    } else {
      flush()
      out.push({ kind: "single", entry: e })
    }
  }
  flush()
  return out
}
