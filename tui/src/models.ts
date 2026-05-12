// Model list matching CamelAGI's supported models

export interface ModelOption {
  id: string
  label: string
  vendor: string
  notes?: string
}

export const MODELS: ModelOption[] = [
  { id: "claude-sonnet-4-20250514",  label: "Claude Sonnet 4",  vendor: "Anthropic", notes: "balanced default" },
  { id: "claude-opus-4-20250514",    label: "Claude Opus 4",    vendor: "Anthropic", notes: "best reasoning" },
  { id: "claude-haiku-4-20250506",   label: "Claude Haiku 4",   vendor: "Anthropic", notes: "fastest" },
  { id: "gpt-4o",                    label: "GPT-4o",           vendor: "OpenAI" },
  { id: "gpt-4o-mini",              label: "GPT-4o Mini",      vendor: "OpenAI",    notes: "fast" },
  { id: "google/gemini-2.5-pro",     label: "Gemini 2.5 Pro",  vendor: "Google" },
  { id: "deepseek/deepseek-r1",      label: "DeepSeek R1",     vendor: "DeepSeek" },
  { id: "deepseek/deepseek-chat",    label: "DeepSeek Chat",   vendor: "DeepSeek" },
]

export const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const
export type Effort = typeof EFFORT_LEVELS[number]

export function findModel(id: string): ModelOption | undefined {
  return MODELS.find(m => m.id === id)
}
