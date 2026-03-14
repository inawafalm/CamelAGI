// Model catalog: presets per provider + OpenRouter live fetch
//
// Used by setup wizard and TUI model selector.

export interface ProviderPreset {
  provider: string;
  baseUrl?: string;
  models: string[];
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  anthropic: {
    provider: "anthropic",
    models: [
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
      "claude-haiku-4-20250506",
    ],
  },
  openai: {
    provider: "openai",
    models: [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "o3",
      "o4-mini",
    ],
  },
  openrouter: {
    provider: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      // Anthropic
      "anthropic/claude-sonnet-4-20250514",
      "anthropic/claude-opus-4-20250514",
      "anthropic/claude-haiku-4-20250506",
      // OpenAI
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "openai/gpt-4.1",
      "openai/gpt-4.1-mini",
      "openai/gpt-4.1-nano",
      "openai/o3",
      "openai/o4-mini",
      // Google
      "google/gemini-2.5-pro",
      "google/gemini-2.5-flash",
      "google/gemini-2.0-flash",
      // DeepSeek
      "deepseek/deepseek-r1",
      "deepseek/deepseek-chat-v3-0324",
      "deepseek/deepseek-r1-0528",
      // Meta
      "meta-llama/llama-4-maverick",
      "meta-llama/llama-4-scout",
      "meta-llama/llama-3.3-70b-instruct",
      // Qwen
      "qwen/qwen3-235b-a22b",
      "qwen/qwen3-32b",
      "qwen/qwen3-30b-a3b",
      // Mistral
      "mistralai/mistral-large-2411",
      "mistralai/mistral-medium-3",
      "mistralai/mistral-small-3.2-24b-instruct",
      "mistralai/codestral-2501",
      // xAI
      "x-ai/grok-3",
      "x-ai/grok-3-mini",
      // Cohere
      "cohere/command-a",
      "cohere/command-r-plus-08-2024",
      // Amazon
      "amazon/nova-pro-v1",
      "amazon/nova-lite-v1",
    ],
  },
  ollama: {
    provider: "openai",
    baseUrl: "http://localhost:11434/v1",
    models: [
      "llama3.3",
      "qwen3",
      "deepseek-r1",
      "gemma3",
      "mistral",
      "codellama",
      "phi4",
    ],
  },
  custom: {
    provider: "openai",
    models: [],
  },
};

/** Resolve which preset to use based on provider and baseUrl */
export function resolvePreset(provider: string, baseUrl?: string): ProviderPreset {
  if (baseUrl?.includes("openrouter")) return PROVIDER_PRESETS.openrouter;
  if (baseUrl?.includes("localhost") || baseUrl?.includes("127.0.0.1")) return PROVIDER_PRESETS.ollama;
  return PROVIDER_PRESETS[provider] ?? PROVIDER_PRESETS.custom;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length?: number;
  pricing?: { prompt: string; completion: string };
}

/**
 * Fetch live model list from OpenRouter API.
 * Returns empty array on failure (caller should fall back to static presets).
 */
export async function fetchOpenRouterModels(apiKey?: string): Promise<OpenRouterModel[]> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch("https://openrouter.ai/api/v1/models", { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];

    const data = await res.json() as { data?: OpenRouterModel[] };
    if (!Array.isArray(data.data)) return [];

    // Sort by popularity (free models last, then alphabetical by provider)
    return data.data
      .filter((m) => m.id && !m.id.includes(":free"))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}
