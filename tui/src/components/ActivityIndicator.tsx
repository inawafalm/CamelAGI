// Claude Code-style live status: ✦ Thinking… (7s · esc to interrupt)
// The verb shimmers (color oscillates between two shades) and rotates
// through a curated word list every few seconds while the model is in
// generic "thinking/responding" mode. Specific labels like "Running Bash"
// stay fixed.

import { useEffect, useRef, useState } from "react"
import { fg, t } from "@opentui/core"
import { theme } from "../theme.js"

// Verbs in many languages, each in its native script. The rotation picks
// at random so a single session feels multilingual.
const VERBS = [
  // English
  "Thinking", "Working", "Pondering", "Reasoning", "Crafting",
  "Analyzing", "Synthesizing", "Brainstorming", "Reflecting", "Mulling",
  // Spanish
  "Pensando", "Trabajando", "Reflexionando", "Analizando", "Creando",
  // French
  "Réfléchissant", "Travaillant", "Analysant", "Créant",
  // German
  "Denkend", "Arbeitend", "Überlegend", "Analysierend",
  // Italian
  "Pensando", "Lavorando", "Analizzando",
  // Portuguese
  "Trabalhando", "Refletindo", "Criando",
  // Dutch
  "Denkend", "Werkend",
  // Swedish
  "Tänker", "Arbetar",
  // Polish
  "Myślę", "Pracuję", "Tworzę",
  // Turkish
  "Düşünüyorum", "Çalışıyorum",
  // Greek
  "Σκέφτομαι", "Εργάζομαι",
  // Russian
  "Думаю", "Работаю", "Размышляю", "Анализирую", "Создаю",
  // Arabic
  "أفكر", "أعمل", "أحلل", "أتأمل", "أبدع",
  // Hebrew
  "חושב", "עובד", "מנתח",
  // Hindi
  "सोच रहा हूँ", "काम कर रहा हूँ",
  // Japanese
  "考え中", "作業中", "分析中", "思案中",
  // Chinese
  "思考中", "工作中", "分析中", "创作中",
  // Korean
  "생각중", "작업중", "분석중",
  // Vietnamese
  "Đang suy nghĩ", "Đang làm việc",
  // Thai
  "กำลังคิด", "กำลังทำงาน",
  // Swahili
  "Kufikiri", "Kufanya kazi",
]

const SHIMMER_DIM = "#475569"     // slate-600
const SHIMMER_BRIGHT = "#e5e7eb"  // gray-200
const VERB_ROTATE_MS = 4000

export interface ActivityIndicatorProps {
  active: boolean
  startedAt: number | null
  label: string | null
  liveTokens: number
}

export function ActivityIndicator({ active, startedAt, label, liveTokens }: ActivityIndicatorProps) {
  // Force re-render at 10Hz for shimmer animation + 1Hz elapsed clock.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick(x => x + 1), 100)
    return () => clearInterval(id)
  }, [active])

  // Verb selection. Generic labels rotate through random words; specific
  // labels (like "Running Bash") are shown verbatim.
  const isGeneric = !label || label === "Thinking" || label === "Responding"
  const verbIdxRef = useRef<number>(Math.floor(Math.random() * VERBS.length))
  const lastRotateRef = useRef<number>(Date.now())

  useEffect(() => {
    if (!active || !isGeneric) return
    verbIdxRef.current = Math.floor(Math.random() * VERBS.length)
    lastRotateRef.current = Date.now()
  }, [active, isGeneric, label])

  if (!active || !startedAt) return null

  // Time-based rotation. Every VERB_ROTATE_MS, pick a new random verb.
  if (isGeneric && Date.now() - lastRotateRef.current >= VERB_ROTATE_MS) {
    let next = Math.floor(Math.random() * VERBS.length)
    if (VERBS.length > 1 && next === verbIdxRef.current) next = (next + 1) % VERBS.length
    verbIdxRef.current = next
    lastRotateRef.current = Date.now()
  }

  const verb = isGeneric ? VERBS[verbIdxRef.current] : (label ?? VERBS[0])
  const shimmerColor = computeShimmer(startedAt)
  const dots = ".".repeat(Math.floor((Date.now() / 400) % 4)) // 0..3, cycles ~1.6s

  const elapsed = formatElapsed(Date.now() - startedAt)
  const tokens = formatTokens(liveTokens)
  const meta = `(${elapsed}${tokens ? ` · ↓ ${tokens} tokens` : ""} · esc to interrupt)`

  return (
    <box paddingLeft={1} paddingRight={1} marginTop={1}>
      <text content={t`${fg(theme.toolDone)("✦ ")}${fg(shimmerColor)(verb + dots)}  ${fg(theme.dim)(meta)}`} />
    </box>
  )
}

// 0.6 Hz sine oscillation between SHIMMER_DIM and SHIMMER_BRIGHT.
function computeShimmer(startedAt: number): string {
  const t = (Date.now() - startedAt) / 1000
  const alpha = (Math.sin(t * 4) + 1) / 2 // 0..1, ~0.6 Hz
  return lerpHex(SHIMMER_DIM, SHIMMER_BRIGHT, alpha)
}

function lerpHex(a: string, b: string, alpha: number): string {
  const ar = parseInt(a.slice(1, 3), 16)
  const ag = parseInt(a.slice(3, 5), 16)
  const ab = parseInt(a.slice(5, 7), 16)
  const br = parseInt(b.slice(1, 3), 16)
  const bg = parseInt(b.slice(3, 5), 16)
  const bb = parseInt(b.slice(5, 7), 16)
  const r = Math.round(ar + (br - ar) * alpha)
  const g = Math.round(ag + (bg - ag) * alpha)
  const bl = Math.round(ab + (bb - ab) * alpha)
  return "#" + [r, g, bl].map(v => v.toString(16).padStart(2, "0")).join("")
}

function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}m ${s}s`
}

function formatTokens(n: number) {
  if (n <= 0) return ""
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
