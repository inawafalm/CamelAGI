// CamelAGI gateway. The TUI connects via WebSocket.
// Override at launch: CAMELAGI_WS_URL=ws://192.168.1.5:18305
export const WS_URL =
  process.env.CAMELAGI_WS_URL ?? "ws://127.0.0.1:18305"

export const DEFAULT_MODEL = "claude-sonnet-4-20250514"
