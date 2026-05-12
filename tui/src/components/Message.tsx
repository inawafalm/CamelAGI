// Codex-style messages.
// User: full-width subtle-highlight bar with ›  prefix.
// Assistant: inline text prefixed by • bullet, no border.
// System: same dim treatment as assistant but with the system tone color.

import { fg, t } from "@opentui/core"
import { theme } from "../theme.js"
import { Markdown } from "./Markdown.js"

export function UserMessage({ text }: { text: string }) {
  return (
    <box
      flexDirection="column"
      marginTop={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.userBg}
    >
      {splitLines(text).map((line, i) => (
        <text
          key={i}
          content={i === 0 ? t`${fg(theme.dim)("› ")}${fg(theme.user)(line)}` : t`  ${fg(theme.user)(line)}`}
          bg={theme.userBg}
        />
      ))}
    </box>
  )
}

export function AssistantMessage({
  text,
  thinking,
  streaming,
}: {
  text: string
  thinking: string
  streaming: boolean
}) {
  return (
    <box flexDirection="column" marginTop={1}>
      {thinking ? (
        <box flexDirection="column" marginBottom={text ? 1 : 0}>
          <text content={t`${fg(theme.thinking)("● thinking")}${streaming ? fg(theme.dim)("…") : ""}`} />
          {splitLines(thinking).map((line, i) => (
            <text key={i} content={"  " + line} fg={theme.dim} />
          ))}
        </box>
      ) : null}
      {text && text.trim() ? (
        <>
          <Markdown text={text} />
          {streaming ? <text content={t`${fg(theme.dim)("▍")}`} /> : null}
        </>
      ) : null}
      {streaming && !(text && text.trim()) ? (
        <text content={t`${fg(theme.dim)("…")}`} />
      ) : null}
    </box>
  )
}

export function SystemMessage({ text, tone }: { text: string; tone?: "info" | "warn" | "error" }) {
  const color = tone === "error" ? theme.toolError : tone === "warn" ? theme.toolRunning : theme.system
  const lines = splitLines(text)
  return (
    <box flexDirection="column" marginTop={1}>
      {lines.map((line, i) => {
        const prefix = i === 0 ? fg(theme.bullet)("● ") : "  "
        return <text key={i} content={t`${prefix}${fg(color)(line)}`} />
      })}
    </box>
  )
}

function splitLines(s: string): string[] {
  return s.split("\n")
}
