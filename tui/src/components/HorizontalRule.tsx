import { useTerminalDimensions } from "@opentui/react"
import { theme } from "../theme.js"

export function HorizontalRule({ marginTop = 0, marginBottom = 0 }: { marginTop?: number; marginBottom?: number }) {
  const { width } = useTerminalDimensions()
  const w = Math.max(20, Math.min(width, 400))
  return (
    <box marginTop={marginTop} marginBottom={marginBottom}>
      <text content={"─".repeat(w)} fg={theme.divider} />
    </box>
  )
}
