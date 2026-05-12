import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { fg, t } from "@opentui/core"
import type { ApprovalRequest } from "../agent/types.js"
import { theme } from "../theme.js"

const OPTIONS = [
  { value: "allow", label: "Allow once", desc: "Run this time only" },
  { value: "deny", label: "Deny", desc: "Block this tool call" },
] as const

export interface ApprovalPromptProps {
  request: ApprovalRequest
  onResolve: (behavior: "allow" | "deny") => void
}

export function ApprovalPrompt({ request, onResolve }: ApprovalPromptProps) {
  const [idx, setIdx] = useState(0)

  useKeyboard(key => {
    if (key.name === "up" || key.name === "k") setIdx(i => Math.max(0, i - 1))
    else if (key.name === "down" || key.name === "j") setIdx(i => Math.min(OPTIONS.length - 1, i + 1))
    else if (key.name === "return") onResolve(OPTIONS[idx].value)
    else if (key.name === "escape") onResolve("deny")
  })

  const summary = summarize(request)

  return (
    <box flexDirection="column" borderStyle="double" borderColor={theme.toolRunning} padding={1}>
      <text content={t`${fg(theme.toolRunning)("⚠ approval required: ")}${fg(theme.assistant)(request.tool)}`} />
      {summary ? <text content={summary} fg={theme.dim} /> : null}
      <box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => {
          const active = i === idx
          const marker = active ? "› " : "  "
          const markerColor = active ? theme.accent : theme.dim
          const labelColor = active ? theme.assistant : theme.dim
          return (
            <text
              key={opt.value}
              content={t`${fg(markerColor)(marker)}${fg(labelColor)(opt.label)}  ${fg(theme.dim)("— " + opt.desc)}`}
            />
          )
        })}
      </box>
      <text content="↑/↓ to choose · enter to confirm · esc to deny" fg={theme.dim} />
    </box>
  )
}

function summarize(req: ApprovalRequest): string {
  const primary = (req.input.file_path ?? req.input.path ?? req.input.command ?? req.input.url) as
    | string
    | undefined
  if (typeof primary === "string") return primary.length > 100 ? primary.slice(0, 99) + "…" : primary
  try { return JSON.stringify(req.input).slice(0, 200) } catch { return "" }
}
