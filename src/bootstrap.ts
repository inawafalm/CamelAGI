// Full first-time bootstrap — admin bot + pairing + optional API setup
// After this, everything is controlled from Telegram.
//
// Usage:
//   camelagi bootstrap                    (interactive)
//   camelagi bootstrap <token>            (skip bot token prompt)

import readline from "node:readline";
import ora from "ora";
import { saveConfig, ensureDirs, paths } from "./core/config.js";
import { seedWorkspace, seedAgentWorkspace } from "./workspace.js";
import { PROVIDER_PRESETS } from "./core/models.js";
import { listPendingRequests, approveRequest } from "./telegram/pairing.js";

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function pick(rl: readline.Interface, label: string, options: string[]): Promise<string> {
  return new Promise((resolve) => {
    console.log(`\n\x1b[36m  ${label}\x1b[0m`);
    for (let i = 0; i < options.length; i++) {
      console.log(`    \x1b[33m${i + 1}\x1b[0m) ${options[i]}`);
    }
    rl.question(`\n  Pick [1-${options.length}]: `, (answer) => {
      const idx = parseInt(answer, 10) - 1;
      resolve(options[idx] ?? options[0]);
    });
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
        text: "✅ Approved!\n\nEnter the 5-digit verification code to complete setup.",
      }),
    });
  } catch { /* best effort */ }

  ora({ indent: 2 }).succeed("Approved!");
  console.log(`\n  \x1b[36m┌──────────────────────────────────────────┐\x1b[0m`);
  console.log(`  \x1b[36m│\x1b[0m                                          \x1b[36m│\x1b[0m`);
  console.log(`  \x1b[36m│\x1b[0m   Your verification code:  \x1b[1m\x1b[33m${approved.otp}\x1b[0m          \x1b[36m│\x1b[0m`);
  console.log(`  \x1b[36m│\x1b[0m                                          \x1b[36m│\x1b[0m`);
  console.log(`  \x1b[36m│\x1b[0m   Enter this code in the Telegram chat.  \x1b[36m│\x1b[0m`);
  console.log(`  \x1b[36m│\x1b[0m                                          \x1b[36m│\x1b[0m`);
  console.log(`  \x1b[36m└──────────────────────────────────────────┘\x1b[0m\n`);

  const otpSpinner = ora({ text: "Waiting for OTP verification...", indent: 2 }).start();

  // Poll for OTP completion
  let verified = false;
  for (let i = 0; i < 300; i++) {
    const still = listPendingRequests().find(
      (r) => r.userId === pairingRequest!.userId && r.agentId === "admin",
    );
    if (!still) {
      verified = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (verified) {
    otpSpinner.succeed(`${userLabel} verified! You are now the admin.`);
  } else {
    otpSpinner.fail("OTP timed out. Retry in Telegram later.");
  }

  // ─── Step 3: API Setup (optional) ─────────────────────────────────

  const setupNow = (await ask(rl, `\n\x1b[36m  Step 3: Configure AI provider now? (Y/n):\x1b[0m `)).trim().toLowerCase();

  if (setupNow !== "n") {
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

    let model: string;
    if (preset.models.length > 0) {
      const customOption = "(type a custom model name)";
      const choice = await pick(rl, "Which model?", [...preset.models, customOption]);
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
  } else {
    console.log(`\x1b[90m  Skipped — configure later via /setup in Telegram.\x1b[0m`);
  }

  rl.close();

  // ─── Done ─────────────────────────────────────────────────────────

  console.log(`\n\x1b[36m  ✅ Bootstrap complete!\x1b[0m`);
  console.log(`\x1b[90m  Use /newagent in Telegram to create your first AI agent.\x1b[0m`);
  console.log(`\x1b[90m  Server is running. Press Ctrl+C to stop.\x1b[0m\n`);

  await new Promise(() => {});
}
