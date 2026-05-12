export const theme = {
  // Codex-inspired neutral palette: minimal color, lots of dim, sparing accent.
  user: "#e5e7eb",
  userBg: "#373737",          // subtle highlight strip behind user messages
  codeBg: "#0f172a",           // darker bg for fenced code blocks
  assistant: "#e5e7eb",
  thinking: "#a78bfa",
  toolRunning: "#fbbf24",
  toolDone: "#34d399",
  toolError: "#f87171",
  toolDenied: "#f59e0b",
  system: "#9ca3af",
  dim: "#6b7280",
  border: "#334155",
  borderActive: "#64748b",
  accent: "#22d3ee",           // teal — used for links, /commands, list numbers
  divider: "#334155",
  diffAdd: "#022900",
  diffRemove: "#3D0200",
  diffAddFg: "#86efac",
  diffRemoveFg: "#fca5a5",
  modeAcceptEdits: "#34d399",
  modeBypass: "#f87171",
  modePlan: "#60a5fa",
  bullet: "#9ca3af",           // • marker color
  branch: "#64748b",           // └ tree branch
  number: "#22d3ee",           // colored list numbers
} as const
