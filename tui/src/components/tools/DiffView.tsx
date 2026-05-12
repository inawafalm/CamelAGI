// Codex-style diff view: line-numbered rows, green/red tint, no patch header.

import { diffLines } from "diff"
import { theme } from "../../theme.js"

const DEFAULT_VISIBLE = 14

export interface DiffViewProps {
  oldText: string
  newText: string
  expanded?: boolean
}

export function diffStats(oldText: string, newText: string): { added: number; removed: number } {
  const changes = diffLines(oldText ?? "", newText ?? "")
  let added = 0
  let removed = 0
  for (const c of changes) {
    const segs = c.value.split("\n")
    if (segs[segs.length - 1] === "") segs.pop()
    if (c.added) added += segs.length
    else if (c.removed) removed += segs.length
  }
  return { added, removed }
}

export function DiffView({ oldText, newText, expanded = false }: DiffViewProps) {
  const rows = buildRows(oldText ?? "", newText ?? "")
  const visible = expanded ? rows : rows.slice(0, DEFAULT_VISIBLE)
  const truncated = !expanded && rows.length > DEFAULT_VISIBLE

  return (
    <box flexDirection="column" width="100%">
      {visible.map((r, i) => <DiffRow key={i} {...r} />)}
      {truncated ? (
        <text content={`  …(+${rows.length - DEFAULT_VISIBLE} more lines)`} fg={theme.dim} />
      ) : null}
    </box>
  )
}

type Row = { kind: "add" | "remove" | "context"; lineNo: number; text: string }

function buildRows(oldText: string, newText: string): Row[] {
  const changes = diffLines(oldText, newText)
  const rows: Row[] = []
  let newLineNo = 1
  let oldLineNo = 1
  for (const c of changes) {
    const segs = c.value.split("\n")
    if (segs[segs.length - 1] === "") segs.pop()
    for (const seg of segs) {
      if (c.added) {
        rows.push({ kind: "add", lineNo: newLineNo++, text: seg })
      } else if (c.removed) {
        rows.push({ kind: "remove", lineNo: oldLineNo++, text: seg })
      } else {
        // Skip pure-empty context rows — they show up as orphan line numbers.
        if (seg.length > 0) {
          rows.push({ kind: "context", lineNo: newLineNo, text: seg })
        }
        newLineNo++
        oldLineNo++
      }
    }
  }
  // Trim leading/trailing empty context rows — they're just noise from
  // trailing newlines and look like orphan line numbers.
  while (rows.length && rows[0].kind === "context" && rows[0].text === "") rows.shift()
  while (rows.length && rows[rows.length - 1].kind === "context" && rows[rows.length - 1].text === "") rows.pop()
  return rows
}

function DiffRow({ kind, lineNo, text }: Row) {
  const num = String(lineNo).padStart(3, " ")
  if (kind === "add") {
    return (
      <box width="100%" backgroundColor={theme.diffAdd}>
        <text content={`${num} +${text}`} fg={theme.diffAddFg} bg={theme.diffAdd} />
      </box>
    )
  }
  if (kind === "remove") {
    return (
      <box width="100%" backgroundColor={theme.diffRemove}>
        <text content={`${num} -${text}`} fg={theme.diffRemoveFg} bg={theme.diffRemove} />
      </box>
    )
  }
  return <text content={`${num}  ${text}`} fg={theme.dim} />
}
