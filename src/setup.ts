// Interactive setup wizard

import * as p from "@clack/prompts";
import { loadConfig, saveConfig, ensureDirs, paths } from "./core/config.js";
import { seedWorkspace } from "./workspace.js";
import { PROVIDER_PRESETS, fetchOpenRouterModels } from "./core/models.js";

function check<T>(value: T | symbol): T {
  if (p.isCancel(value)) { p.cancel("Setup cancelled."); process.exit(0); }
  return value as T;
}

export async function runSetup() {
  ensureDirs();

  p.intro("\x1b[36mCamelAGI\x1b[0m setup");

  // Show current config if exists
  try {
    const current = loadConfig();
    p.log.info(`Current: ${current.provider} / ${current.model} (key: ${current.apiKey ? "set" : "not set"})`);
  } catch { /* no config yet */ }

  // 1. Provider
  const provider = check(await p.select({
    message: "Provider",
    options: [
      { value: "anthropic",  label: "Anthropic",  hint: "Claude (direct)" },
      { value: "openai",     label: "OpenAI",     hint: "GPT (direct)" },
      { value: "openrouter", label: "OpenRouter",  hint: "Any model via OpenRouter" },
      { value: "ollama",     label: "Ollama",     hint: "Local models" },
      { value: "custom",     label: "Custom",     hint: "Custom OpenAI-compatible endpoint" },
    ],
  }));

  const preset = PROVIDER_PRESETS[provider] ?? PROVIDER_PRESETS.custom;

  // 2. API key
  let apiKey: string | undefined;
  if (provider !== "ollama") {
    const label = provider === "anthropic" ? "Anthropic" : provider === "openai" ? "OpenAI" : provider === "openrouter" ? "OpenRouter" : "API";
    apiKey = check(await p.password({ message: `${label} API key` })) || undefined;
    if (!apiKey) p.log.warn("No key \u2014 set it later in config.yaml or via env var.");
  }

  // 3. Base URL (custom only)
  let baseUrl = preset.baseUrl;
  if (provider === "custom") {
    baseUrl = check(await p.text({ message: "Base URL", placeholder: "http://localhost:8080/v1" })) || undefined;
  }

  // 4. Model
  let models = [...preset.models];
  if (provider === "openrouter" && apiKey) {
    const s = p.spinner();
    s.start("Fetching models from OpenRouter...");
    const live = await fetchOpenRouterModels(apiKey);
    if (live.length > 0) { models = live.map((m) => m.id); s.stop(`${models.length} models available`); }
    else s.stop("Could not fetch \u2014 using defaults");
  }

  let model: string;
  if (models.length > 0) {
    model = check(await p.autocomplete({
      message: "Model",
      options: models.map((m) => ({ value: m, label: m })),
      maxItems: 8,
    }));
  } else {
    model = check(await p.text({ message: "Model name" }));
  }

  // 5. Telegram (optional)
  const setupTelegram = check(await p.confirm({ message: "Set up Telegram bot?" }));
  let telegramConfig: { botToken: string; allowedUsers: number[] } | undefined;

  if (setupTelegram) {
    const botToken = check(await p.password({ message: "Bot token (from @BotFather)" }));
    const userId = check(await p.text({ message: "Your Telegram user ID (from @userinfobot)", placeholder: "optional" }));
    if (botToken.trim()) {
      telegramConfig = {
        botToken: botToken.trim(),
        allowedUsers: userId.trim() ? [parseInt(userId.trim(), 10)] : [],
      };
    }
  }

  // Save
  const values: Record<string, unknown> = {
    provider: preset.provider,
    model: model.trim(),
  };
  if (apiKey) values.apiKey = apiKey.trim();
  if (baseUrl) values.baseUrl = baseUrl.trim();
  if (!baseUrl && provider !== "custom") values.baseUrl = undefined;
  if (telegramConfig) values.telegram = telegramConfig;

  saveConfig(values);
  seedWorkspace();

  const lines = [
    `Provider  ${values.provider}`,
    `Model     ${values.model}`,
    `API Key   ${apiKey ? "\u2022\u2022\u2022\u2022" + apiKey.slice(-4) : "not set"}`,
  ];
  if (telegramConfig) lines.push("Telegram  configured");
  lines.push(`Config    ${paths.configFile}`);

  p.note(lines.join("\n"), "Saved");
  p.outro("Run \x1b[36mcamelagi chat\x1b[0m to start chatting.");
}
