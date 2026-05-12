// CamelAGI welcome banner

import { fg, t, bold } from "@opentui/core"
import { theme } from "../theme.js"

export interface WelcomeProps {
  cwd: string
  model: string
  version: string
}

const TIPS = [
  "Type /  to see commands",
  "Shift+Tab cycles permission modes",
  "Esc interrupts a running task",
]

const CAMEL = [
  "      🐪      ",
  "   CamelAGI   ",
]

export function Welcome({ cwd, model, version }: WelcomeProps) {
  const cwdShort = shortenPath(cwd)
  const modelLabel = shortenModel(model)

  return (
    <box flexDirection="column" marginTop={1} marginBottom={1}>
      <box
        flexDirection="row"
        borderStyle="rounded"
        borderColor={theme.border}
        title={` CamelAGI v${version} `}
        titleAlignment="left"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <box flexDirection="column" width={30} paddingRight={2}>
          {CAMEL.map((line, i) => (
            <text key={i} content={t`${bold(fg(theme.assistant)(line))}`} />
          ))}
          <text content="" />
          <text content={modelLabel} fg={theme.assistant} />
          <text content={cwdShort} fg={theme.dim} />
        </box>
        <box flexDirection="column" flexGrow={1}>
          <text content={t`${bold(fg(theme.assistant)("Getting started"))}`} />
          {TIPS.map((tip, i) => (
            <text key={i} content={tip} fg={theme.assistant} />
          ))}
          <text content="" />
          <text content="─────────────────────────────────────" fg={theme.border} />
          <text content="" />
          <text content="Connect to gateway at ws://127.0.0.1:18305" fg={theme.dim} />
          <text content="Run 'camel serve' in another terminal first" fg={theme.dim} />
        </box>
      </box>
    </box>
  )
}

function shortenModel(model: string): string {
  const last = model.split("/").pop() ?? model
  return last
    .split("-")
    .map(part => part[0]?.toUpperCase() + part.slice(1))
    .join(" ")
}

function shortenPath(p: string): string {
  const home = process.env.HOME ?? ""
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p
}
