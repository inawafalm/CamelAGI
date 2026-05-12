// Plain text input row. No border (Claude Code style: dividers above/below
// supplied by the parent). Owns its own buffer; emits onSubmit on Enter.
// Slash-mode bookkeeping is exposed via onSlashStateChange so the parent
// can swap the bottom area between BottomBar and SlashMenu.

import { useEffect, useMemo, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { fg, t, bold } from "@opentui/core"
import { filterCommands, type SlashCommand } from "../commands/registry.js"
import { theme } from "../theme.js"

export interface InputProps {
  disabled?: boolean
  onSubmit: (text: string) => void
  onSlash: (commandName: string, args: string[]) => void
  onAbort?: () => void
  onCyclePermission?: () => void
  /** Notifies parent of current slash-mode state so it can render the menu in the bottom area. */
  onSlashState?: (state: { matches: SlashCommand[]; selectedIndex: number; argMode?: boolean } | null) => void
  placeholder?: string
}

export function Input({
  disabled,
  onSubmit,
  onSlash,
  onAbort,
  onCyclePermission,
  onSlashState,
  placeholder,
}: InputProps) {
  const [value, setValue] = useState("")
  const [menuIdx, setMenuIdx] = useState(0)

  const inSlashMode = value.startsWith("/")
  const slashTokens = inSlashMode ? value.slice(1).split(/\s+/) : []
  const slashQuery = inSlashMode ? slashTokens[0] ?? "" : ""

  const matches = useMemo<SlashCommand[]>(() => {
    if (!inSlashMode) return []
    if (slashTokens.length === 1) return filterCommands(slashQuery)
    return []
  }, [inSlashMode, slashQuery, slashTokens.length])

  // Keep menuIdx in range as matches change.
  if (menuIdx >= matches.length && matches.length > 0) {
    setMenuIdx(0)
  }

  // Notify parent.
  useEffect(() => {
    if (matches.length > 0) onSlashState?.({ matches, selectedIndex: menuIdx })
    else onSlashState?.(null)
  }, [matches, menuIdx, onSlashState])

  useKeyboard(key => {
    if (key.shift && key.name === "tab") {
      onCyclePermission?.()
      return
    }
    if (disabled) {
      if (key.name === "escape") onAbort?.()
      return
    }
    if (matches.length > 0) {
      if (key.name === "up") { setMenuIdx(i => Math.max(0, i - 1)); return }
      if (key.name === "down") { setMenuIdx(i => Math.min(matches.length - 1, i + 1)); return }
      if (key.name === "tab") {
        const pick = matches[menuIdx]
        if (pick) setValue(`/${pick.name} `)
        return
      }
      if (key.name === "return") {
        const pick = matches[menuIdx]
        if (pick) {
          setValue("")
          setMenuIdx(0)
          onSlash(pick.name, [])
        }
        return
      }
    }
    if (key.name === "return") {
      const trimmed = value.trim()
      setValue("")
      setMenuIdx(0)
      if (!trimmed) return
      if (trimmed.startsWith("/")) {
        const tokens = trimmed.slice(1).split(/\s+/)
        const [name, ...args] = tokens
        onSlash(name, args)
        return
      }
      onSubmit(trimmed)
      return
    }
    if (key.name === "escape") {
      if (value) setValue("")
      else onAbort?.()
      return
    }
    if (key.name === "backspace") {
      setValue(v => v.slice(0, -1))
      return
    }
    if (typeof key.sequence === "string" && key.sequence.length === 1) {
      const ch = key.sequence
      const code = ch.charCodeAt(0)
      if (code >= 32 && code !== 127) setValue(v => v + ch)
    }
  })

  // Bigger, bolder caret + chunkier block cursor for visibility.
  const cursor = !disabled ? bold(fg(theme.assistant)("█")) : ""
  const prompt = bold(fg(theme.assistant)("❯ "))
  const showPlaceholder = !value && placeholder && !disabled
  const promptContent = showPlaceholder
    ? t`${prompt}${fg(theme.dim)(placeholder)}${cursor}`
    : t`${prompt}${fg(theme.assistant)(value)}${cursor}`

  return (
    <box paddingLeft={1} paddingRight={1} marginTop={1} marginBottom={1}>
      <text content={promptContent} />
    </box>
  )
}
