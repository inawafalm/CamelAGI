// Simple, robust rendering: one <text content="..." fg/bg /> per row.
// (Earlier multi-slot t`` template approach was hitting layout drift in
// OpenTUI when slots had wide padded content.)

import { theme } from "../theme.js"
import type { SlashCommand } from "../commands/registry.js"

export interface SlashMenuProps {
  commands: SlashCommand[]
  selectedIndex: number
  /** When true, drop the leading "/" — items are arg suggestions, not commands. */
  argMode?: boolean
}

const MAX_VISIBLE = 12

export function SlashMenu({ commands, selectedIndex, argMode }: SlashMenuProps) {
  if (commands.length === 0) return null

  // When no row is selected (selectedIndex < 0) anchor the window at the top
  // so we don't compute a negative or shifted slice.
  const anchor = selectedIndex < 0 ? 0 : selectedIndex
  const start = Math.max(
    0,
    Math.min(anchor - Math.floor(MAX_VISIBLE / 2), commands.length - MAX_VISIBLE),
  )
  const visible = commands.slice(start, start + MAX_VISIBLE)
  const longest = Math.max(...commands.map(c => c.name.length))

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {visible.map((cmd, i) => {
        const realIdx = start + i
        const active = selectedIndex >= 0 && realIdx === selectedIndex
        const marker = active ? "› " : "  "
        const prefix = argMode ? "" : "/"
        const line = `${marker}${prefix}${cmd.name.padEnd(longest)}   ${cmd.description}`
        return (
          <text
            key={cmd.name}
            content={line}
            fg={active ? theme.assistant : theme.dim}
            bg={active ? theme.userBg : undefined}
          />
        )
      })}
    </box>
  )
}
