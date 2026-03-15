// Interactive setup wizard

import readline from "node:readline";
import { loadConfig, saveConfig, ensureDirs, paths } from "./core/config.js";
import { seedWorkspace } from "./workspace.js";
import { PROVIDER_PRESETS } from "./core/models.js";

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function pick(rl: readline.Interface, label: string, options: string[], compact = false): Promise<string> {
  function showList(items: string[], indices: number[]) {
    for (let i = 0; i < indices.length; i++) {
      console.log(`  \x1b[33m${indices[i] + 1}\x1b[0m) ${items[i]}`);
    }
  }

  if (!compact) {
    return new Promise((resolve) => {
      console.log(`\n\x1b[36m${label}\x1b[0m`);
      showList(options, options.map((_, i) => i));
      rl.question(`\nPick [1-${options.length}]: `, (answer) => {
        const idx = parseInt(answer.trim(), 10) - 1;
        resolve(options[idx] ?? options[0]);
      });
    });
  }

  // Live-filter mode for large lists
  return new Promise((resolve) => {
    console.log(`\n\x1b[36m${label}\x1b[0m`);
    console.log(`\x1b[90m  ${options.length} options — start typing to filter, arrows to navigate, enter to select\x1b[0m\n`);

    rl.pause();

    let query = "";
    let cursor = 0;
    let matches = options.map((o, i) => ({ option: o, index: i }));
    const MAX_VISIBLE = 8;

    function getVisible() {
      if (matches.length <= MAX_VISIBLE) return matches;
      let start = Math.max(0, cursor - Math.floor(MAX_VISIBLE / 2));
      if (start + MAX_VISIBLE > matches.length) start = Math.max(0, matches.length - MAX_VISIBLE);
      return matches.slice(start, start + MAX_VISIBLE);
    }

    function render() {
      process.stdout.write(`\x1b[2K\r`);

      const lines: string[] = [];
      lines.push(`\x1b[36m>\x1b[0m ${query}\x1b[90m_\x1b[0m`);
      lines.push("");

      if (matches.length === 0) {
        lines.push(`  \x1b[33mNo matches\x1b[0m`);
      } else {
        const visible = getVisible();
        const startIdx = matches.indexOf(visible[0]);
        if (startIdx > 0) lines.push(`  \x1b[90m  ↑ ${startIdx} more\x1b[0m`);
        for (let i = 0; i < visible.length; i++) {
          const m = visible[i];
          const globalIdx = startIdx + i;
          const selected = globalIdx === cursor;
          if (selected) {
            lines.push(`  \x1b[36m▸ ${m.index + 1}) ${m.option}\x1b[0m`);
          } else {
            lines.push(`    \x1b[33m${m.index + 1}\x1b[0m) ${m.option}`);
          }
        }
        const remaining = matches.length - (startIdx + visible.length);
        if (remaining > 0) lines.push(`  \x1b[90m  ↓ ${remaining} more\x1b[0m`);
      }

      if ((render as any)._prevLines) {
        process.stdout.write(`\x1b[${(render as any)._prevLines}A`);
      }
      for (const line of lines) {
        process.stdout.write(`\x1b[2K${line}\n`);
      }
      const prevCount = (render as any)._prevLines ?? 0;
      for (let i = lines.length; i < prevCount; i++) {
        process.stdout.write(`\x1b[2K\n`);
      }
      if (prevCount > lines.length) {
        process.stdout.write(`\x1b[${prevCount - lines.length}A`);
      }
      (render as any)._prevLines = lines.length;
    }

    function updateMatches() {
      const q = query.toLowerCase();
      matches = q
        ? options.map((o, i) => ({ option: o, index: i })).filter((m) => m.option.toLowerCase().includes(q))
        : options.map((o, i) => ({ option: o, index: i }));
      cursor = 0;
    }

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();

    render();

    const onData = (buf: Buffer) => {
      const key = buf.toString();

      if (key === "\r" || key === "\n") {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        rl.resume();

        const prevLines = (render as any)._prevLines ?? 0;
        process.stdout.write(`\x1b[${prevLines}A`);
        for (let i = 0; i < prevLines; i++) process.stdout.write(`\x1b[2K\n`);
        process.stdout.write(`\x1b[${prevLines}A`);

        if (matches.length > 0) {
          const selected = matches[cursor];
          console.log(`  \x1b[32m→ ${selected.option}\x1b[0m\n`);
          resolve(selected.option);
        } else if (query.trim()) {
          console.log(`  \x1b[32m→ ${query.trim()}\x1b[0m\n`);
          resolve(query.trim());
        } else {
          console.log(`  \x1b[32m→ ${options[0]}\x1b[0m\n`);
          resolve(options[0]);
        }
        return;
      }

      if (key === "\x03") {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        process.exit(0);
      }

      if (key === "\x1b[A") { if (cursor > 0) cursor--; render(); return; }
      if (key === "\x1b[B") { if (cursor < matches.length - 1) cursor++; render(); return; }

      if (key === "\x7f" || key === "\b") {
        if (query.length > 0) { query = query.slice(0, -1); updateMatches(); render(); }
        return;
      }

      if (key.length === 1 && key >= " ") {
        query += key;
        updateMatches();
        render();
      }
    };

    stdin.on("data", onData);
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
    const choice = await pick(rl, "Which model?", [...preset.models, customOption], true);
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
