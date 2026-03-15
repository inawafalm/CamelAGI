// Voice transcription: Groq (free), OpenAI, Deepgram

import OpenAI from "openai";

export type VoiceProvider = "groq" | "openai" | "deepgram";

export interface VoiceConfig {
  enabled: boolean;
  provider: VoiceProvider;
  apiKey: string;
  model?: string;
  language?: string;
}

export interface TranscribeResult {
  text: string;
}

const BASE_URLS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1",
  openai: "https://api.openai.com/v1",
};

const DEFAULT_MODELS: Record<VoiceProvider, string> = {
  groq: "whisper-large-v3",
  openai: "whisper-1",
  deepgram: "nova-3",
};

export function getDefaultModel(provider: VoiceProvider): string {
  return DEFAULT_MODELS[provider];
}

export async function transcribe(buffer: Buffer, config: VoiceConfig): Promise<TranscribeResult> {
  const model = config.model ?? getDefaultModel(config.provider);

  if (config.provider === "deepgram") {
    return transcribeDeepgram(buffer, config.apiKey, model, config.language);
  }

  // Groq and OpenAI share the OpenAI-compatible API
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: BASE_URLS[config.provider],
  });

  const file = new File([buffer], "voice.ogg", { type: "audio/ogg" });

  const result = await client.audio.transcriptions.create({
    model,
    file,
    ...(config.language && { language: config.language }),
  });

  return { text: result.text };
}

async function transcribeDeepgram(
  buffer: Buffer,
  apiKey: string,
  model: string,
  language?: string,
): Promise<TranscribeResult> {
  const params = new URLSearchParams({ model });
  if (language) params.set("language", language);

  const resp = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "audio/ogg",
    },
    body: buffer,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Deepgram error ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as {
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  };

  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  return { text: transcript };
}

// ─── Connection test (used by wizard) ────────────────────────────────

export async function testVoiceConnection(
  config: VoiceConfig,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (config.provider === "deepgram") {
      const resp = await fetch("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${config.apiKey}` },
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      return { ok: true };
    }

    // Groq / OpenAI: hit /models endpoint
    const baseUrl = BASE_URLS[config.provider];
    const resp = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
