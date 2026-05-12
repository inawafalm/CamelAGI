import { useTerminalDimensions } from "@opentui/react"
import { theme } from "../theme.js"

export function Divider() {
  const { width } = useTerminalDimensions()
  const w = Math.max(20, Math.min(width - 2, 200))
  return (
    <box marginTop={1} marginBottom={1}>
      <text content={"─".repeat(w)} fg={theme.divider} />
    </box>
  )
}
