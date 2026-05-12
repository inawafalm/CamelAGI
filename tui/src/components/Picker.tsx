// Generic interactive list picker with type-to-filter search.
// Up/Down navigate, Enter confirms, Esc cancels, printable keys edit query.

import { useState, useMemo, useEffect } from "react"
import { useKeyboard } from "@opentui/react"
import { fg, t } from "@opentui/core"
import { theme } from "../theme.js"

export interface PickerItem {
  value: string
  label: string
  description?: string
  badge?: string
}

export interface PickerProps {
  title: string
  items: PickerItem[]
  initialIndex?: number
  onSelect: (value: string) => void
  onCancel: () => void
}

const MAX_VISIBLE = 8

export function Picker({ title, items, initialIndex = 0, onSelect, onCancel }: PickerProps) {
  const [query, setQuery] = useState("")
  const [idx, setIdx] = useState(Math.min(initialIndex, Math.max(0, items.length - 1)))

  const filtered = useMemo(() => {
    if (!query) return items
    const q = query.toLowerCase()
    return items.filter(i =>
      i.label.toLowerCase().includes(q)
      || (i.description ?? "").toLowerCase().includes(q)
      || (i.badge ?? "").toLowerCase().includes(q),
    )
  }, [items, query])

  // Snap selection back into range whenever the filter changes.
  useEffect(() => {
    setIdx(i => Math.min(Math.max(0, i), Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  useKeyboard(key => {
    if (key.name === "up") {
      setIdx(i => Math.max(0, i - 1))
    } else if (key.name === "down") {
      setIdx(i => Math.min(filtered.length - 1, i + 1))
    } else if (key.name === "return") {
      if (filtered.length > 0) onSelect(filtered[idx].value)
    } else if (key.name === "escape") {
      onCancel()
    } else if (key.name === "backspace") {
      setQuery(q => q.slice(0, -1))
    } else if (
      key.sequence
      && key.sequence.length === 1
      && key.sequence >= " "
      && key.sequence <= "~"
    ) {
      setQuery(q => q + key.sequence)
    }
  })

  if (items.length === 0) return null

  const start = Math.max(
    0,
    Math.min(idx - Math.floor(MAX_VISIBLE / 2), Math.max(0, filtered.length - MAX_VISIBLE)),
  )
  const visible = filtered.slice(start, start + MAX_VISIBLE)

  // Fixed column widths derived from the full item set so widths don't jiggle as you filter.
  const labelWidth = Math.min(28, Math.max(...items.map(i => i.label.length)))
  const badgeWidth = Math.min(12, Math.max(...items.map(i => (i.badge ?? "").length)))

  // Total height: title + filter + blank + visible rows + blank + footer + padding(2)
  const height = visible.length + 7

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      height={height}
      borderStyle="rounded"
      borderColor={theme.borderActive}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      marginTop={1}
    >
      <text content={t`${fg(theme.accent)("› ")}${fg(theme.assistant)(title)}`} />
      <text
        content={t`${fg(theme.dim)("  search ")}${fg(theme.assistant)(query || " ")}${fg(theme.dim)(query ? "" : "(type to filter)")}`}
      />
      <text content="" />
      {visible.length === 0 ? (
        <text content="  no matches" fg={theme.dim} />
      ) : (
        visible.map((item, i) => {
          const realIdx = start + i
          const active = realIdx === idx
          const marker = active ? "› " : "  "
          const markerColor = active ? theme.accent : theme.dim
          const labelColor = active ? theme.assistant : theme.dim
          const label = clip(item.label, labelWidth).padEnd(labelWidth)
          const badge = clip(item.badge ?? "", badgeWidth).padEnd(badgeWidth)
          const desc = item.description ?? ""
          return (
            <text
              key={item.value}
              content={t`${fg(markerColor)(marker)}${fg(labelColor)(label)}  ${fg(theme.dim)(badge)}  ${fg(theme.dim)(desc)}`}
            />
          )
        })
      )}
      <text content="" />
      <text content="↑/↓ choose · enter confirm · esc cancel · type to filter" fg={theme.dim} />
    </box>
  )
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…"
}
