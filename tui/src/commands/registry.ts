// Slash command registry for CamelAGI TUI.

import { spawn as spawnChild } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { PermissionMode } from "../agent/types.js"
import type { ChatState } from "../state/reducer.js"
import { MODELS, EFFORT_LEVELS, type Effort, findModel } from "../models.js"
import type { PickerItem } from "../components/Picker.js"

export interface Settings {
  model: string
  effort: Effort
  cwd: string
}

export interface CommandContext {
  pushSystem: (text: string, tone?: "info" | "warn" | "error") => void
  agent: {
    state: ChatState
    clear: () => void
    abort: () => void
    setPermissionMode: (mode: PermissionMode) => void
    switchModel: (model: string, thinking?: string, effort?: string) => void
    wsSend: (msg: Record<string, unknown>) => void
    sessionId: string
  }
  settings: Settings
  setSettings: (patch: Partial<Settings>) => void
  openPicker: (opts: {
    title: string
    items: PickerItem[]
    initialIndex?: number
    onSelect: (value: string) => void
  }) => void
  exit: () => void
}

export interface SlashCommand {
  name: string
  description: string
  hidden?: boolean
  run: (ctx: CommandContext, args: string[]) => Promise<void> | void
}

export const COMMANDS: SlashCommand[] = [
  {
    name: "model",
    description: "Pick a model",
    run: ctx => {
      const items: PickerItem[] = MODELS.map(m => ({
        value: m.id,
        label: m.label,
        description: m.notes ?? "",
        badge: m.vendor,
      }))
      const initialIndex = Math.max(0, MODELS.findIndex(m => m.id === ctx.settings.model))
      ctx.openPicker({
        title: "Select model",
        items,
        initialIndex,
        onSelect: value => {
          ctx.setSettings({ model: value })
          ctx.agent.switchModel(value)
          const meta = findModel(value)
          ctx.pushSystem(`Model → ${meta?.label ?? value}`)
        },
      })
    },
  },
  {
    name: "effort",
    description: "Set effort level (low | medium | high | max)",
    run: (ctx, args) => {
      const arg = args[0] as Effort | undefined
      if (arg && EFFORT_LEVELS.includes(arg)) {
        ctx.setSettings({ effort: arg })
        ctx.agent.switchModel(ctx.settings.model, undefined, arg)
        ctx.pushSystem(`Effort → ${arg}`)
        return
      }
      const items: PickerItem[] = EFFORT_LEVELS.map(level => ({
        value: level,
        label: level,
        description: descEffort(level),
      }))
      const initialIndex = Math.max(0, EFFORT_LEVELS.indexOf(ctx.settings.effort))
      ctx.openPicker({
        title: "Select effort level",
        items,
        initialIndex,
        onSelect: value => {
          ctx.setSettings({ effort: value as Effort })
          ctx.agent.switchModel(ctx.settings.model, undefined, value)
          ctx.pushSystem(`Effort → ${value}`)
        },
      })
    },
  },
  {
    name: "think",
    description: "Set thinking level (off | low | medium | high)",
    run: (ctx, args) => {
      const levels = ["off", "low", "medium", "high"] as const
      const arg = args[0]
      if (arg && levels.includes(arg as typeof levels[number])) {
        ctx.agent.switchModel(ctx.settings.model, arg)
        ctx.pushSystem(`Thinking → ${arg}`)
        return
      }
      ctx.openPicker({
        title: "Select thinking level",
        items: levels.map(l => ({ value: l, label: l })),
        onSelect: value => {
          ctx.agent.switchModel(ctx.settings.model, value)
          ctx.pushSystem(`Thinking → ${value}`)
        },
      })
    },
  },
  {
    name: "new",
    description: "Start a fresh session",
    run: ctx => {
      ctx.agent.clear()
      ctx.pushSystem("New session started.")
    },
  },
  {
    name: "clear",
    description: "Clear chat history",
    run: ctx => ctx.agent.clear(),
  },
  {
    name: "abort",
    description: "Abort the running agent",
    run: ctx => ctx.agent.abort(),
  },
  {
    name: "compact",
    description: "Force compaction of chat history",
    run: ctx => {
      ctx.agent.wsSend({ type: "compact", session: ctx.agent.sessionId })
      ctx.pushSystem("Compaction requested.")
    },
  },
  {
    name: "status",
    description: "Show session status and usage",
    run: ctx => {
      ctx.agent.wsSend({ type: "status", session: ctx.agent.sessionId })
    },
  },
  {
    name: "sessions",
    description: "List saved sessions",
    run: ctx => {
      ctx.agent.wsSend({ type: "sessions.list" })
    },
  },
  {
    name: "cwd",
    description: "Show or change working directory",
    run: (ctx, args) => {
      if (args.length === 0) {
        ctx.pushSystem(`Current cwd: ${ctx.settings.cwd}`)
        return
      }
      ctx.setSettings({ cwd: args.join(" ") })
      ctx.pushSystem(`cwd → ${args.join(" ")}`)
    },
  },
  {
    name: "copy",
    description: "Copy the last assistant message to clipboard",
    run: ctx => {
      const last = lastAssistantText(ctx.agent.state)
      if (!last) {
        ctx.pushSystem("No assistant message to copy yet.", "warn")
        return
      }
      copyToClipboard(last)
        .then(() => ctx.pushSystem(`Copied ${last.length} chars to clipboard.`))
        .catch(err => ctx.pushSystem(`Copy failed: ${(err as Error).message}`, "error"))
    },
  },
  {
    name: "save",
    description: "Save chat to a file in cwd",
    run: ctx => {
      const out = formatTranscript(ctx.agent.state)
      const filename = `camelagi-chat-${new Date().toISOString().replace(/[:.]/g, "-")}.md`
      const path = join(ctx.settings.cwd, filename)
      try {
        writeFileSync(path, out, "utf8")
        ctx.pushSystem(`Saved chat to ${path}`)
      } catch (err) {
        ctx.pushSystem(`Save failed: ${(err as Error).message}`, "error")
      }
    },
  },
  {
    name: "help",
    description: "Show all commands and shortcuts",
    run: ctx => {
      const longest = Math.max(...COMMANDS.filter(c => !c.hidden).map(c => c.name.length))
      const lines = [
        "Commands:",
        ...COMMANDS.filter(c => !c.hidden).map(c => `  /${c.name.padEnd(longest)}   ${c.description}`),
        "",
        "Shortcuts:",
        "  ctrl+c       abort current run, twice to exit",
        "  ctrl+l       clear chat",
        "  esc          cancel input / deny approval / close picker",
        "  ↑ / ↓        navigate menu / picker",
      ]
      ctx.pushSystem(lines.join("\n"))
    },
  },
  {
    name: "exit",
    description: "Quit",
    run: ctx => ctx.exit(),
  },
  {
    name: "quit",
    description: "Quit",
    hidden: true,
    run: ctx => ctx.exit(),
  },
]

export function findCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find(c => c.name === name)
}

export function filterCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase()
  return COMMANDS.filter(c => {
    if (!c.name.startsWith(q)) return false
    if (c.hidden && q.length < 3) return false
    return true
  })
}

function descEffort(e: Effort): string {
  switch (e) {
    case "low":    return "fastest, cheapest"
    case "medium": return "balanced"
    case "high":   return "more thinking (default)"
    case "max":    return "all-out reasoning"
  }
}

function lastAssistantText(state: ChatState): string | null {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const e = state.entries[i]
    if (e.kind === "assistant" && e.text) return e.text
  }
  return null
}

function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === "darwin" ? "pbcopy"
      : process.platform === "win32" ? "clip"
      : "xclip"
    const args = process.platform === "linux" ? ["-selection", "clipboard"] : []
    const child = spawnChild(cmd, args, { stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", reject)
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)))
    child.stdin.end(text)
  })
}

function formatTranscript(state: ChatState): string {
  const lines: string[] = [`# CamelAGI chat — ${new Date().toISOString()}`, ""]
  for (const e of state.entries) {
    switch (e.kind) {
      case "user":
        lines.push(`### You`, "", e.text, "")
        break
      case "assistant":
        if (e.thinking) lines.push(`> _thinking:_ ${e.thinking.replace(/\n/g, " ")}`, "")
        lines.push(`### Assistant`, "", e.text, "")
        break
      case "tool":
        lines.push(`**${e.name}** (${e.status})`, "```", JSON.stringify(e.args, null, 2), "```")
        if (e.result) lines.push("```", e.result, "```")
        lines.push("")
        break
      case "system":
        lines.push(`_system: ${e.text}_`, "")
        break
      case "subagent":
        lines.push(`**subagent: ${e.agentId}** — ${e.done ? "done" : "running"}`, "")
        break
    }
  }
  return lines.join("\n")
}
