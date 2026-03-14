// Interactive setup wizard

import readline from "node:readline";
import { loadConfig, saveConfig, ensureDirs, paths } from "./core/config.js";
import { seedWorkspace } from "./workspace.js";
import { PROVIDER_PRESETS } from "./core/models.js";

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function pick(rl: readline.Interface, label: string, options: string[]): Promise<string> {
  return new Promise((resolve) => {
    console.log(`\n\x1b[36m${label}\x1b[0m`);
    for (let i = 0; i < options.length; i++) {
      console.log(`  \x1b[33m${i + 1}\x1b[0m) ${options[i]}`);
    }
    rl.question(`\nPick [1-${options.length}]: `, (answer) => {
      const idx = parseInt(answer, 10) - 1;
      resolve(options[idx] ?? options[0]);
    });
  });
}

export async function runSetup() {
  ensureDirs();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`\n\x1b[36m  CamelAGI Setup\x1b[0m`);
  console.log(`\x1b[90m  Config: ${paths.configFile}\x1b[0m\n`);

  // Show current config if exists
  try {
    const current = loadConfig();
    console.log(`\x1b[90m  Current: provider=${current.provider}, model=${current.model}${current.baseUrl ? `, baseUrl=${current.baseUrl}` : ""}, key=${current.apiKey ? "***" + current.apiKey.slice(-4) : "not set"}\x1b[0m`);
  } catch { /* no config yet */ }

  // 1. Pick service
  const service = await pick(rl, "Which service?", [
    "anthropic  — Claude (direct)",
    "openai     — GPT (direct)",
    "openrouter — Any model via OpenRouter",
    "ollama     — Local models",
    "custom     — Custom OpenAI-compatible endpoint",
  ]);
  const serviceKey = service.split(/\s/)[0];
  const preset = PROVIDER_PRESETS[serviceKey] ?? PROVIDER_PRESETS.custom;

  // 2. API key
  let apiKey: string | undefined;
  if (serviceKey !== "ollama") {
    const keyLabel = serviceKey === "anthropic" ? "Anthropic" : serviceKey === "openai" ? "OpenAI" : serviceKey === "openrouter" ? "OpenRouter" : "API";
    apiKey = await ask(rl, `\n\x1b[36m${keyLabel} API key:\x1b[0m `);
    if (!apiKey.trim()) {
      console.log("\x1b[33m  No key entered — you can set it later in config.yaml or via env var.\x1b[0m");
      apiKey = undefined;
    }
  }

  // 3. Base URL (custom only)
  let baseUrl = preset.baseUrl;
  if (serviceKey === "custom") {
    baseUrl = await ask(rl, `\n\x1b[36mBase URL:\x1b[0m `) || undefined;
  }

  // 4. Model
  let model: string;
  if (preset.models.length > 0) {
    const customOption = "(type a custom model name)";
    const choice = await pick(rl, "Which model?", [...preset.models, customOption]);
    if (choice === customOption) {
      model = await ask(rl, `\n\x1b[36mModel name:\x1b[0m `);
    } else {
      model = choice;
    }
  } else {
    model = await ask(rl, `\n\x1b[36mModel name:\x1b[0m `);
  }

  // 5. Telegram (optional)
  const setupTelegram = await ask(rl, `\n\x1b[36mSet up Telegram bot? (y/N)\x1b[0m `);
  let telegramConfig: { botToken: string; allowedUsers: number[] } | undefined;

  if (setupTelegram.trim().toLowerCase() === "y") {
    const botToken = await ask(rl, `\x1b[36mBot token (from @BotFather):\x1b[0m `);
    const userId = await ask(rl, `\x1b[36mYour Telegram user ID (from @userinfobot):\x1b[0m `);
    if (botToken.trim()) {
      telegramConfig = {
        botToken: botToken.trim(),
        allowedUsers: userId.trim() ? [parseInt(userId.trim(), 10)] : [],
      };
    }
  }

  rl.close();

  // Save
  const values: Record<string, unknown> = {
    provider: preset.provider,
    model: model.trim(),
  };
  if (apiKey) values.apiKey = apiKey.trim();
  if (baseUrl) values.baseUrl = baseUrl.trim();
  if (!baseUrl && serviceKey !== "custom") {
    // Clear baseUrl if switching away from a custom endpoint
    values.baseUrl = undefined;
  }
  if (telegramConfig) {
    values.telegram = telegramConfig;
  }

  saveConfig(values);
  seedWorkspace();

  console.log(`\n\x1b[32m  Saved to ${paths.configFile}\x1b[0m`);
  console.log(`\x1b[90m  provider: ${values.provider}`);
  console.log(`  model:    ${values.model}`);
  if (baseUrl) console.log(`  baseUrl:  ${baseUrl}`);
  console.log(`  apiKey:   ${apiKey ? "***" + apiKey.slice(-4) : "not set"}`);
  if (telegramConfig) console.log(`  telegram: bot token configured`);
  console.log(`\x1b[0m`);
  console.log(`\n  Run \x1b[36mcamelagi chat\x1b[0m to start chatting.\n`);
}
