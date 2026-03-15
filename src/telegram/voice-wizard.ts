// Wizard definitions for voice transcription setup

import type { Config } from "../core/config.js";
import { saveConfig } from "../core/config.js";
import type { WizardDef } from "./wizard.js";
import { testVoiceConnection, getDefaultModel, type VoiceProvider } from "./transcribe.js";

export function createVoiceWizard(getConfig: () => Config): WizardDef {
  return {
    id: "voice",
    steps: [
      {
        id: "provider",
        prompt: "Which transcription provider?",
        options: [
          { label: "Groq (free)", value: "groq" },
          { label: "OpenAI", value: "openai" },
          { label: "Deepgram", value: "deepgram" },
        ],
      },
      {
        id: "apiKey",
        prompt: "Enter the API key for your voice provider:",
        validate: (value) => value ? null : "API key cannot be empty.",
      },
      {
        id: "model",
        prompt: "Transcription model:",
        options: [
          { label: "Use default", value: "__default__" },
          { label: "Custom", value: "__custom__" },
        ],
      },
      {
        id: "modelCustom",
        prompt: "Enter model name:",
        skip: (data) => data.model !== "__custom__",
      },
    ],
    onComplete: async (data) => {
      const provider = data.provider as VoiceProvider;
      const model = data.model === "__custom__" ? data.modelCustom : getDefaultModel(provider);

      const voiceConfig = {
        enabled: true,
        provider,
        apiKey: data.apiKey,
        model,
      };

      const test = await testVoiceConnection(voiceConfig);
      if (!test.ok) {
        return `Connection test failed: ${test.error}\n\nRun /voice to try again.`;
      }

      saveConfig({ voice: voiceConfig });

      const masked = `***${data.apiKey.slice(-4)}`;
      return [
        "Voice transcription configured!\n",
        `Provider: ${provider}`,
        `Model: ${model}`,
        `API Key: ${masked}`,
        "",
        "Send a voice message in any agent chat to try it out.",
      ].join("\n");
    },
  };
}

export function createVoiceResetWizard(): WizardDef {
  return {
    id: "voice-reset",
    steps: [
      {
        id: "confirm",
        prompt: "Reset voice configuration? This will disable voice transcription.",
        options: [
          { label: "Yes, reset", value: "yes" },
          { label: "Cancel", value: "no" },
        ],
      },
    ],
    onComplete: async (data) => {
      if (data.confirm === "yes") {
        saveConfig({ voice: { enabled: false } });
        return "Voice transcription disabled.";
      }
      return "Cancelled.";
    },
  };
}
