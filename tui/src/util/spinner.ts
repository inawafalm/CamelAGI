// Braille-pattern spinner frames — the de-facto standard for terminal
// spinners. OpenTUI doesn't ship one, so we share this single source
// instead of duplicating the array across components.

export const SPINNER_FRAMES = [
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
] as const

export function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!
}
