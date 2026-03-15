// Full first-time bootstrap — admin bot + pairing + optional API setup
// After this, everything is controlled from Telegram.
//
// Usage:
//   camelagi bootstrap                    (interactive)
//   camelagi bootstrap <token>            (skip bot token prompt)

import readline from "node:readline";
import ora from "ora";
import { saveConfig, loadConfig, ensureDirs, paths } from "./core/config.js";
import { seedWorkspace, seedAgentWorkspace } from "./workspace.js";
import { PROVIDER_PRESETS, fetchOpenRouterModels } from "./core/models.js";
import { listPendingRequests, approveRequest } from "./telegram/pairing.js";

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

// Suppress background server logs during interactive prompts
let _logMuted = false;
const _origLog = console.log;
const _origError = console.error;
const _origWarn = console.warn;
function muteLogs() {
  if (_logMuted) return;
  _logMuted = true;
  console.log = (...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    // Allow bootstrap's own output (indented or colored)
    if (first.startsWith("\x1b[") || first.startsWith("  ")) _origLog(...args);
  };
  console.error = () => {};
  console.warn = () => {};
}
function unmuteLogs() {
  if (!_logMuted) return;
  _logMuted = false;
  console.log = _origLog;
  console.error = _origError;
  console.warn = _origWarn;
}

function pick(rl: readline.Interface, label: string, options: string[], compact = false): Promise<string> {
  function showList(items: string[], indices: number[]) {
    for (let i = 0; i < indices.length; i++) {
      console.log(`    \x1b[33m${indices[i] + 1}\x1b[0m) ${items[i]}`);
    }
  }

  if (!compact) {
    // Simple numbered list for small option sets
    return new Promise((resolve) => {
      console.log(`\n\x1b[36m  ${label}\x1b[0m`);
      showList(options, options.map((_, i) => i));
      rl.question(`\n  Pick [1-${options.length}]: `, (answer) => {
        const idx = parseInt(answer.trim(), 10) - 1;
        resolve(options[idx] ?? options[0]);
      });
    });
  }

  // Live-filter mode for large lists
  return new Promise((resolve) => {
    console.log(`\n\x1b[36m  ${label}\x1b[0m`);
    console.log(`\x1b[90m    ${options.length} options — start typing to filter, arrows to navigate, enter to select\x1b[0m\n`);

    // Pause readline so we can use raw stdin
    rl.pause();

    let query = "";
    let cursor = 0;
    let matches = options.map((o, i) => ({ option: o, index: i }));
    const MAX_VISIBLE = 8;

    function getVisible() {
      if (matches.length <= MAX_VISIBLE) return matches;
      // Keep cursor in view
      let start = Math.max(0, cursor - Math.floor(MAX_VISIBLE / 2));
      if (start + MAX_VISIBLE > matches.length) start = Math.max(0, matches.length - MAX_VISIBLE);
      return matches.slice(start, start + MAX_VISIBLE);
    }

    function render() {
      const visible = getVisible();
      const startIdx = matches.indexOf(visible[0]);

      // Clear: move up to header + erase everything below
      process.stdout.write(`\x1b[2K\r`); // clear current line

      // Build output
      const lines: string[] = [];
      lines.push(`  \x1b[36m>\x1b[0m ${query}\x1b[90m_\x1b[0m`);
      lines.push("");

      if (matches.length === 0) {
        lines.push(`    \x1b[33mNo matches\x1b[0m`);
      } else {
        if (startIdx > 0) lines.push(`    \x1b[90m  ↑ ${startIdx} more\x1b[0m`);
        for (let i = 0; i < visible.length; i++) {
          const m = visible[i];
          const globalIdx = startIdx + i;
          const selected = globalIdx === cursor;
          if (selected) {
            lines.push(`    \x1b[36m▸ ${m.index + 1}) ${m.option}\x1b[0m`);
          } else {
            lines.push(`      \x1b[33m${m.index + 1}\x1b[0m) ${m.option}`);
          }
        }
        const remaining = matches.length - (startIdx + visible.length);
        if (remaining > 0) lines.push(`    \x1b[90m  ↓ ${remaining} more\x1b[0m`);
      }

      // Move cursor up to overwrite previous render, then write
      if ((render as any)._prevLines) {
        process.stdout.write(`\x1b[${(render as any)._prevLines}A`);
      }
      for (const line of lines) {
        process.stdout.write(`\x1b[2K${line}\n`);
      }
      // Clear any leftover lines from previous longer render
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
        // Enter: select current
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        rl.resume();

        // Clear the picker output
        const prevLines = (render as any)._prevLines ?? 0;
        process.stdout.write(`\x1b[${prevLines}A`);
        for (let i = 0; i < prevLines; i++) process.stdout.write(`\x1b[2K\n`);
        process.stdout.write(`\x1b[${prevLines}A`);

        if (matches.length > 0) {
          const selected = matches[cursor];
          console.log(`    \x1b[32m→ ${selected.option}\x1b[0m\n`);
          resolve(selected.option);
        } else {
          // No matches but query could be a custom model name
          if (query.trim()) {
            console.log(`    \x1b[32m→ ${query.trim()}\x1b[0m\n`);
            resolve(query.trim());
          } else {
            console.log(`    \x1b[32m→ ${options[0]}\x1b[0m\n`);
            resolve(options[0]);
          }
        }
        return;
      }

      if (key === "\x03") {
        // Ctrl+C
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        process.exit(0);
      }

      if (key === "\x1b[A") {
        // Up arrow
        if (cursor > 0) cursor--;
        render();
        return;
      }

      if (key === "\x1b[B") {
        // Down arrow
        if (cursor < matches.length - 1) cursor++;
        render();
        return;
      }

      if (key === "\x7f" || key === "\b") {
        // Backspace
        if (query.length > 0) {
          query = query.slice(0, -1);
          updateMatches();
          render();
        }
        return;
      }

      // Regular character
      if (key.length === 1 && key >= " ") {
        query += key;
        updateMatches();
        render();
      }
    };

    stdin.on("data", onData);
  });
}

async function validateBotToken(token: string): Promise<{ ok: boolean; username?: string; name?: string; error?: string }> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await resp.json() as { ok: boolean; result?: { username?: string; first_name?: string }; description?: string };
    if (data.ok && data.result) {
      return { ok: true, username: data.result.username, name: data.result.first_name };
    }
    return { ok: false, error: data.description ?? "Invalid token" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runBootstrap(tokenArg?: string) {
  ensureDirs();
  seedWorkspace();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n\x1b[36m  CamelAGI Bootstrap\x1b[0m`);
  console.log(`\x1b[90m  Sets up your admin bot, verifies your identity, then configures AI.\x1b[0m`);
  console.log(`\x1b[90m  After this, manage everything from Telegram.\x1b[0m`);

  // ─── Resume detection ──────────────────────────────────────────────

  let existingConfig;
  try { existingConfig = loadConfig(); } catch { existingConfig = null; }

  const hasAdminBot = !!existingConfig?.agents?.admin?.telegram?.botToken;
  const hasVerifiedUser = (existingConfig?.agents?.admin?.telegram?.allowedUsers?.length ?? 0) > 0;
  const hasApiKey = !!existingConfig?.apiKey;

  if (hasAdminBot && hasVerifiedUser && hasApiKey) {
    console.log(`\n\x1b[32m  ✔ Already fully configured.\x1b[0m`);
    console.log(`\x1b[90m    Admin bot: configured\x1b[0m`);
    console.log(`\x1b[90m    Identity: verified\x1b[0m`);
    console.log(`\x1b[90m    API: ${existingConfig!.provider} / ${existingConfig!.model}\x1b[0m`);
    const resetAnswer = (await ask(rl, `\n\x1b[36m  Reset and start over? (y/N):\x1b[0m `)).trim().toLowerCase();
    if (resetAnswer !== "y") {
      console.log(`\x1b[90m  Nothing to do. Use /setup in Telegram to reconfigure.\x1b[0m\n`);
      rl.close();
      return;
    }
  } else if (hasAdminBot && hasVerifiedUser && !hasApiKey) {
    console.log(`\n\x1b[32m  ✔ Admin bot configured, identity verified.\x1b[0m`);
    console.log(`\x1b[33m  ⚠ API not configured — resuming from Step 3.\x1b[0m`);

    // Start server for background operation
    const serverSpinner = ora({ text: "Starting server...", indent: 2 }).start();
    const { startServer } = await import("./serve.js");
    startServer({ cron: true, boot: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    serverSpinner.succeed("Server running");

    // Jump straight to step 3
    await runApiSetup(rl);
    rl.close();

    console.log(`\n\x1b[36m  ✅ Bootstrap complete!\x1b[0m`);
    console.log(`\x1b[90m  Use /newagent in Telegram to create your first AI agent.\x1b[0m`);
    console.log(`\x1b[90m  Server is running. Press Ctrl+C to stop.\x1b[0m\n`);
    await new Promise(() => {});
    return;
  }

  // ─── Step 1: Telegram Admin Bot ───────────────────────────────────

  let botToken = tokenArg ?? "";

  if (!botToken) {
    console.log(`\n\x1b[36m  Step 1: Telegram Admin Bot\x1b[0m`);
    console.log(`\x1b[90m  This bot lets you manage CamelAGI from Telegram.\x1b[0m\n`);
    console.log(`  \x1b[36m┌──────────────────────────────────────────┐\x1b[0m`);
    console.log(`  \x1b[36m│\x1b[0m  1. Open Telegram → \x1b[1m@BotFather\x1b[0m → \x1b[1m/newbot\x1b[0m \x1b[36m│\x1b[0m`);
    console.log(`  \x1b[36m│\x1b[0m  2. Copy the bot token                  \x1b[36m│\x1b[0m`);
    console.log(`  \x1b[36m└──────────────────────────────────────────┘\x1b[0m\n`);
    botToken = (await ask(rl, `\x1b[36m  Bot token:\x1b[0m `)).trim();
  }

  if (!botToken) {
    rl.close();
    console.error("\n\x1b[31m  Bot token is required.\x1b[0m\n");
    process.exit(1);
  }

  // Validate the token
  const validateSpinner = ora({ text: "Validating bot token...", indent: 2 }).start();
  const result = await validateBotToken(botToken);
  if (!result.ok) {
    if (result.error?.includes("fetch failed") || result.error?.includes("ENOTFOUND")) {
      validateSpinner.warn("Could not reach Telegram API — skipping validation");
    } else {
      validateSpinner.fail(`Invalid token: ${result.error}`);
      rl.close();
      process.exit(1);
    }
  } else {
    validateSpinner.succeed(`Bot valid: @${result.username} (${result.name})`);
  }

  // Save admin bot config (no API yet)
  saveConfig({
    agents: {
      admin: {
        name: "Admin",
        admin: true,
        telegram: { botToken, allowedUsers: [] },
      },
    },
  });
  seedAgentWorkspace("admin", "Admin", "CamelAGI admin bot — manages your AI agents from Telegram");

  ora({ indent: 2 }).succeed("Admin bot configured");

  // ─── Step 2: Start server + pairing ───────────────────────────────

  const serverSpinner = ora({ text: "Starting server...", indent: 2 }).start();
  const { startServer } = await import("./serve.js");
  startServer({ cron: true, boot: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  serverSpinner.succeed("Server running");
  muteLogs();

  const botName = result.ok ? `@${result.username}` : "your admin bot";
  console.log(`\n\x1b[36m  Step 2: Verify Your Identity\x1b[0m\n`);
  console.log(`  \x1b[36m┌──────────────────────────────────────────┐\x1b[0m`);
  console.log(`  \x1b[36m│\x1b[0m  Open Telegram and send any message to  \x1b[36m│\x1b[0m`);
  console.log(`  \x1b[36m│\x1b[0m  \x1b[1m\x1b[36m${botName.padEnd(38)}\x1b[0m\x1b[36m│\x1b[0m`);
  console.log(`  \x1b[36m└──────────────────────────────────────────┘\x1b[0m\n`);

  const pairingSpinner = ora({ text: "Waiting for your Telegram message...", indent: 2 }).start();

  // Poll for pairing request
  let pairingRequest: Awaited<ReturnType<typeof listPendingRequests>>[number] | undefined;
  for (let i = 0; i < 120; i++) {
    const pending = listPendingRequests().filter((r) => r.agentId === "admin" && r.status === "pending");
    if (pending.length > 0) {
      pairingRequest = pending[0];
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!pairingRequest) {
    pairingSpinner.fail("Timeout — no message received. Pair later via /pairing.");
    rl.close();
    console.log(`\x1b[90m  Server is running. Press Ctrl+C to stop.\x1b[0m\n`);
    await new Promise(() => {});
    return;
  }

  const userLabel = pairingRequest.username ? `@${pairingRequest.username}` : pairingRequest.firstName ?? String(pairingRequest.userId);
  pairingSpinner.succeed(`Pairing request from ${userLabel}`);
  console.log(`\n  \x1b[36m┌──────────────────────┐\x1b[0m`);
  console.log(`  \x1b[36m│\x1b[0m  Code: \x1b[1m\x1b[33m${pairingRequest.code}\x1b[0m          \x1b[36m│\x1b[0m`);
  console.log(`  \x1b[36m│\x1b[0m  User: \x1b[1m${userLabel.padEnd(14)}\x1b[0m\x1b[36m│\x1b[0m`);
  console.log(`  \x1b[36m│\x1b[0m  ID:   ${String(pairingRequest.userId).padEnd(14)}\x1b[36m│\x1b[0m`);
  console.log(`  \x1b[36m└──────────────────────┘\x1b[0m\n`);

  // Ask admin to approve in CLI
  const approveAnswer = (await ask(rl, `\x1b[36m  Approve ${userLabel}? (Y/n):\x1b[0m `)).trim().toLowerCase();
  if (approveAnswer === "n") {
    console.log(`\x1b[90m  Denied. Pair later via /pairing.\x1b[0m`);
    rl.close();
    await new Promise(() => {});
    return;
  }

  const approved = approveRequest(pairingRequest.code);
  if (!approved) {
    ora({ indent: 2 }).fail("Failed to approve. Pair manually via /pairing.");
    rl.close();
    await new Promise(() => {});
    return;
  }

  // Notify user in Telegram
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: pairingRequest.chatId,
        text: "Access approved! You are now the admin.",
      }),
    });
  } catch { /* best effort */ }

  ora({ indent: 2 }).succeed(`${userLabel} approved! You are now the admin.`);

  // ─── Step 3: API Setup (optional) ─────────────────────────────────

  const setupNow = (await ask(rl, `\n\x1b[36m  Step 3: Configure AI provider now? (Y/n):\x1b[0m `)).trim().toLowerCase();

  if (setupNow !== "n") {
    await runApiSetup(rl);
  } else {
    console.log(`\x1b[90m  Skipped — configure later via /setup in Telegram.\x1b[0m`);
  }

  rl.close();

  // ─── Done ─────────────────────────────────────────────────────────

  unmuteLogs();
  console.log(`\n\x1b[36m  ✅ Bootstrap complete!\x1b[0m`);
  console.log(`\x1b[90m  Use /newagent in Telegram to create your first AI agent.\x1b[0m`);
  console.log(`\x1b[90m  Server is running. Press Ctrl+C to stop.\x1b[0m\n`);

  await new Promise(() => {});
}

// ─── Extracted API setup ──────────────────────────────────────────────

async function runApiSetup(rl: readline.Interface): Promise<void> {
  const service = await pick(rl, "Which provider?", [
    "anthropic  — Claude (direct)",
    "openai     — GPT (direct)",
    "openrouter — Any model via OpenRouter",
    "ollama     — Local models",
    "custom     — Custom OpenAI-compatible endpoint",
  ]);
  const serviceKey = service.split(/\s/)[0];
  const preset = PROVIDER_PRESETS[serviceKey] ?? PROVIDER_PRESETS.custom;

  let apiKey: string | undefined;
  if (serviceKey !== "ollama") {
    const keyLabel = serviceKey === "anthropic" ? "Anthropic" : serviceKey === "openai" ? "OpenAI" : serviceKey === "openrouter" ? "OpenRouter" : "API";
    apiKey = (await ask(rl, `\n\x1b[36m  ${keyLabel} API key:\x1b[0m `)).trim() || undefined;
    if (!apiKey) console.log("\x1b[33m  No key — set it later via /setup in Telegram.\x1b[0m");
  }

  let baseUrl = preset.baseUrl;
  if (serviceKey === "custom") {
    baseUrl = (await ask(rl, `\n\x1b[36m  Base URL:\x1b[0m `)).trim() || undefined;
  }

  // Fetch live models for OpenRouter, fall back to static presets
  let models = [...preset.models];
  if (serviceKey === "openrouter" && apiKey) {
    const spinner = ora({ text: "Fetching models from OpenRouter...", indent: 2 }).start();
    const live = await fetchOpenRouterModels(apiKey);
    if (live.length > 0) {
      models = live.map((m) => m.id);
      spinner.succeed(`${models.length} models available`);
    } else {
      spinner.warn("Could not fetch live models — using defaults");
    }
  }

  let model: string;
  if (models.length > 0) {
    const customOption = "(type a custom model name)";
    const choice = await pick(rl, "Which model?", [...models, customOption], true);
    model = choice === customOption ? (await ask(rl, `\n\x1b[36m  Model name:\x1b[0m `)).trim() : choice;
  } else {
    model = (await ask(rl, `\n\x1b[36m  Model name:\x1b[0m `)).trim();
  }

  const update: Record<string, unknown> = { provider: preset.provider, model };
  if (apiKey) update.apiKey = apiKey;
  if (baseUrl) update.baseUrl = baseUrl;
  saveConfig(update);

  ora({ indent: 2 }).succeed("API configured");
  console.log(`\x1b[90m    provider: ${preset.provider}\x1b[0m`);
  console.log(`\x1b[90m    model:    ${model}\x1b[0m`);
  if (baseUrl) console.log(`\x1b[90m    baseUrl:  ${baseUrl}\x1b[0m`);
  console.log(`\x1b[90m    apiKey:   ${apiKey ? "***" + apiKey.slice(-4) : "not set"}\x1b[0m`);
}
