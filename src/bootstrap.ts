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

// ─── ANSI helpers ────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
  bgCyan: "\x1b[46m",
  bgGray: "\x1b[100m",
};

// ─── UI components ───────────────────────────────────────────────────

function banner() {
  console.log("");
  console.log(`  ${C.cyan}╭─────────────────────────────────────╮${C.reset}`);
  console.log(`  ${C.cyan}│${C.reset}                                     ${C.cyan}│${C.reset}`);
  console.log(`  ${C.cyan}│${C.reset}     ${C.bold}${C.cyan}C a m e l A G I${C.reset}               ${C.cyan}│${C.reset}`);
  console.log(`  ${C.cyan}│${C.reset}                                     ${C.cyan}│${C.reset}`);
  console.log(`  ${C.cyan}│${C.reset}  ${C.gray}Your AI, managed from Telegram${C.reset}    ${C.cyan}│${C.reset}`);
  console.log(`  ${C.cyan}│${C.reset}                                     ${C.cyan}│${C.reset}`);
  console.log(`  ${C.cyan}╰─────────────────────────────────────╯${C.reset}`);
  console.log("");
}

function stepHeader(step: number, total: number, label: string) {
  const filled = Math.round((step / total) * 30);
  const empty = 30 - filled;
  const bar = `${C.cyan}${"━".repeat(filled)}${C.gray}${"░".repeat(empty)}${C.reset}`;
  console.log(`\n  ${C.bold}Step ${step} of ${total}${C.reset} ${bar}  ${C.bold}${label}${C.reset}`);
  console.log(`  ${C.gray}${"─".repeat(50)}${C.reset}`);
}

function box(lines: string[]) {
  const maxLen = lines.reduce((max, l) => Math.max(max, stripAnsi(l).length), 0);
  const width = maxLen + 4;
  console.log(`  ${C.cyan}╭${"─".repeat(width)}╮${C.reset}`);
  for (const line of lines) {
    const pad = width - stripAnsi(line).length - 2;
    console.log(`  ${C.cyan}│${C.reset} ${line}${" ".repeat(Math.max(0, pad))} ${C.cyan}│${C.reset}`);
  }
  console.log(`  ${C.cyan}╰${"─".repeat(width)}╯${C.reset}`);
}

function summaryCard(entries: [string, string][]) {
  const labelWidth = entries.reduce((max, [k]) => Math.max(max, k.length), 0);
  const lines = entries.map(([k, v]) => `${C.gray}${k.padEnd(labelWidth)}${C.reset}  ${v}`);
  box(lines);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── Input helpers ───────────────────────────────────────────────────

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function askSecret(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    rl.pause();

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();

    let value = "";
    const onData = (buf: Buffer) => {
      const ch = buf.toString();
      if (ch === "\r" || ch === "\n") {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        rl.resume();
        process.stdout.write("\n");
        resolve(value);
      } else if (ch === "\x03") {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        process.exit(0);
      } else if (ch === "\x7f" || ch === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (ch >= " ") {
        value += ch;
        process.stdout.write(value.length <= 4 ? ch : "\u2022");
      }
    };
    stdin.on("data", onData);
  });
}

// ─── Suppress background server logs ─────────────────────────────────

let _logMuted = false;
const _origLog = console.log;
const _origError = console.error;
const _origWarn = console.warn;
function muteLogs() {
  if (_logMuted) return;
  _logMuted = true;
  console.log = (...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
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

// ─── Pick (simple + live-filter) ─────────────────────────────────────

function pick(rl: readline.Interface, label: string, options: string[], compact = false): Promise<string> {
  if (!compact) {
    return new Promise((resolve) => {
      console.log(`\n  ${C.bold}${label}${C.reset}\n`);
      for (let i = 0; i < options.length; i++) {
        console.log(`    ${C.cyan}${i + 1})${C.reset} ${options[i]}`);
      }
      rl.question(`\n  ${C.cyan}>${C.reset} `, (answer) => {
        const idx = parseInt(answer.trim(), 10) - 1;
        resolve(options[idx] ?? options[0]);
      });
    });
  }

  // Live-filter mode
  return new Promise((resolve) => {
    console.log(`\n  ${C.bold}${label}${C.reset}`);
    console.log(`  ${C.gray}${options.length} options — type to filter, arrows to navigate, enter to select${C.reset}\n`);

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
      const visible = getVisible();
      const startIdx = matches.indexOf(visible[0]);

      process.stdout.write(`\x1b[2K\r`);

      const lines: string[] = [];
      lines.push(`  ${C.cyan}>${C.reset} ${query}${C.gray}_${C.reset}`);
      lines.push("");

      if (matches.length === 0) {
        lines.push(`    ${C.yellow}No matches${C.reset}`);
      } else {
        if (startIdx > 0) lines.push(`    ${C.gray}  ↑ ${startIdx} more${C.reset}`);
        for (let i = 0; i < visible.length; i++) {
          const m = visible[i];
          const globalIdx = startIdx + i;
          if (globalIdx === cursor) {
            lines.push(`    ${C.cyan}▸ ${m.option}${C.reset}`);
          } else {
            lines.push(`    ${C.gray}  ${m.option}${C.reset}`);
          }
        }
        const remaining = matches.length - (startIdx + visible.length);
        if (remaining > 0) lines.push(`    ${C.gray}  ↓ ${remaining} more${C.reset}`);
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
          console.log(`  ${C.green}→ ${matches[cursor].option}${C.reset}\n`);
          resolve(matches[cursor].option);
        } else if (query.trim()) {
          console.log(`  ${C.green}→ ${query.trim()}${C.reset}\n`);
          resolve(query.trim());
        } else {
          console.log(`  ${C.green}→ ${options[0]}${C.reset}\n`);
          resolve(options[0]);
        }
        return;
      }

      if (key === "\x03") { stdin.removeListener("data", onData); stdin.setRawMode(false); process.exit(0); }
      if (key === "\x1b[A") { if (cursor > 0) cursor--; render(); return; }
      if (key === "\x1b[B") { if (cursor < matches.length - 1) cursor++; render(); return; }
      if (key === "\x7f" || key === "\b") { if (query.length > 0) { query = query.slice(0, -1); updateMatches(); render(); } return; }
      if (key.length === 1 && key >= " ") { query += key; updateMatches(); render(); }
    };

    stdin.on("data", onData);
  });
}

// ─── Token validation ────────────────────────────────────────────────

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

// ─── Main bootstrap ─────────────────────────────────────────────────

export async function runBootstrap(tokenArg?: string) {
  ensureDirs();
  seedWorkspace();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  banner();

  // ─── Resume detection ──────────────────────────────────────────────

  let existingConfig;
  try { existingConfig = loadConfig(); } catch { existingConfig = null; }

  const hasAdminBot = !!existingConfig?.agents?.admin?.telegram?.botToken;
  const hasVerifiedUser = (existingConfig?.agents?.admin?.telegram?.allowedUsers?.length ?? 0) > 0;
  const hasApiKey = !!existingConfig?.apiKey;

  if (hasAdminBot && hasVerifiedUser && hasApiKey) {
    console.log(`  ${C.green}Already fully configured.${C.reset}\n`);
    summaryCard([
      ["Admin Bot", "configured"],
      ["Identity", "verified"],
      ["Provider", `${existingConfig!.provider}`],
      ["Model", `${existingConfig!.model}`],
    ]);
    const resetAnswer = (await ask(rl, `\n  ${C.cyan}Reset and start over? (y/N):${C.reset} `)).trim().toLowerCase();
    if (resetAnswer !== "y") {
      console.log(`  ${C.gray}Nothing to do. Use /setup in Telegram to reconfigure.${C.reset}\n`);
      rl.close();
      return;
    }
  } else if (hasAdminBot && hasVerifiedUser && !hasApiKey) {
    console.log(`  ${C.green}Admin bot configured, identity verified.${C.reset}`);
    console.log(`  ${C.yellow}API not configured — resuming from Step 3.${C.reset}\n`);

    const serverSpinner = ora({ text: "Starting server...", indent: 2 }).start();
    const { startServer } = await import("./serve.js");
    startServer({ cron: true, boot: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    serverSpinner.succeed("Server running");
    muteLogs();

    stepHeader(3, 3, "AI Provider");
    await runApiSetup(rl);

    showComplete(rl, existingConfig);
    return;
  }

  // ─── Step 1: Telegram Admin Bot ───────────────────────────────────

  let botToken = tokenArg ?? "";

  if (!botToken) {
    stepHeader(1, 3, "Telegram Bot");
    console.log(`\n  ${C.gray}This bot lets you manage CamelAGI from Telegram.${C.reset}\n`);
    box([
      `1. Open Telegram → ${C.bold}@BotFather${C.reset} → ${C.bold}/newbot${C.reset}`,
      `2. Copy the bot token`,
    ]);
    console.log("");
    botToken = (await askSecret(rl, `  ${C.cyan}Bot token:${C.reset} `)).trim();
  }

  if (!botToken) {
    rl.close();
    console.error(`\n  ${C.red}Bot token is required.${C.reset}\n`);
    process.exit(1);
  }

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
    validateSpinner.succeed(`Bot valid: ${C.bold}@${result.username}${C.reset} (${result.name})`);
  }

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

  // ─── Step 2: Verify identity ───────────────────────────────────────

  const serverSpinner = ora({ text: "Starting server...", indent: 2 }).start();
  const { startServer } = await import("./serve.js");
  startServer({ cron: true, boot: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  serverSpinner.succeed("Server running");
  muteLogs();

  const botName = result.ok ? `@${result.username}` : "your admin bot";
  stepHeader(2, 3, "Identity");
  console.log("");
  box([
    `Open Telegram and send any message to`,
    `${C.bold}${C.cyan}${botName}${C.reset}`,
  ]);
  console.log("");

  const pairingSpinner = ora({ text: "Waiting for your Telegram message...", indent: 2 }).start();

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
    unmuteLogs();
    console.log(`  ${C.gray}Server is running. Press Ctrl+C to stop.${C.reset}\n`);
    await new Promise(() => {});
    return;
  }

  const userLabel = pairingRequest.username ? `@${pairingRequest.username}` : pairingRequest.firstName ?? String(pairingRequest.userId);
  pairingSpinner.succeed(`Pairing request from ${C.bold}${userLabel}${C.reset}`);
  console.log("");
  summaryCard([
    ["User", userLabel],
    ["ID", String(pairingRequest.userId)],
  ]);

  const approveAnswer = (await ask(rl, `\n  ${C.cyan}Approve ${userLabel}? (Y/n):${C.reset} `)).trim().toLowerCase();
  if (approveAnswer === "n") {
    console.log(`  ${C.gray}Denied. Pair later via /pairing.${C.reset}`);
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

  ora({ indent: 2 }).succeed(`${userLabel} approved!`);

  // ─── Step 3: API Setup ─────────────────────────────────────────────

  stepHeader(3, 3, "AI Provider");

  const setupNow = (await ask(rl, `\n  ${C.cyan}Configure AI provider now? (Y/n):${C.reset} `)).trim().toLowerCase();

  let finalProvider = "";
  let finalModel = "";
  let finalBaseUrl = "";
  let finalApiKey = "";

  if (setupNow !== "n") {
    const apiResult = await runApiSetup(rl);
    finalProvider = apiResult.provider;
    finalModel = apiResult.model;
    finalBaseUrl = apiResult.baseUrl ?? "";
    finalApiKey = apiResult.apiKey ?? "";
  } else {
    console.log(`  ${C.gray}Skipped — configure later via /setup in Telegram.${C.reset}`);
  }

  rl.close();

  // ─── Done ──────────────────────────────────────────────────────────

  unmuteLogs();

  console.log(`\n  ${C.green}${C.bold}Bootstrap complete!${C.reset}\n`);

  const summaryEntries: [string, string][] = [
    ["Admin Bot", botName],
  ];
  if (finalProvider) summaryEntries.push(["Provider", finalProvider]);
  if (finalModel) summaryEntries.push(["Model", finalModel.length > 30 ? finalModel.slice(0, 27) + "..." : finalModel]);
  if (finalBaseUrl) summaryEntries.push(["Base URL", finalBaseUrl]);
  if (finalApiKey) summaryEntries.push(["API Key", "\u2022\u2022\u2022\u2022" + finalApiKey.slice(-4)]);
  summaryEntries.push(["Admin", userLabel ?? "pending"]);
  summaryEntries.push(["Config", paths.configFile]);
  summaryCard(summaryEntries);

  console.log(`\n  ${C.gray}Next: Use ${C.cyan}/newagent${C.gray} in ${botName} to create${C.reset}`);
  console.log(`  ${C.gray}      your first AI agent.${C.reset}`);
  console.log(`\n  ${C.gray}Server is running. Press Ctrl+C to stop.${C.reset}\n`);

  await new Promise(() => {});
}

// ─── Completion helper (for resume path) ─────────────────────────────

async function showComplete(rl: readline.Interface, config: any) {
  rl.close();
  unmuteLogs();
  const freshConfig = loadConfig();
  console.log(`\n  ${C.green}${C.bold}Bootstrap complete!${C.reset}\n`);
  summaryCard([
    ["Provider", freshConfig.provider],
    ["Model", freshConfig.model],
    ["API Key", freshConfig.apiKey ? "\u2022\u2022\u2022\u2022" + freshConfig.apiKey.slice(-4) : "not set"],
    ["Config", paths.configFile],
  ]);
  console.log(`\n  ${C.gray}Server is running. Press Ctrl+C to stop.${C.reset}\n`);
  await new Promise(() => {});
}

// ─── API setup ───────────────────────────────────────────────────────

async function runApiSetup(rl: readline.Interface): Promise<{ provider: string; model: string; baseUrl?: string; apiKey?: string }> {
  const service = await pick(rl, "Which provider?", [
    "anthropic   Claude (direct)",
    "openai      GPT (direct)",
    "openrouter  Any model via OpenRouter",
    "ollama      Local models",
    "custom      Custom endpoint",
  ]);
  const serviceKey = service.split(/\s/)[0];
  const preset = PROVIDER_PRESETS[serviceKey] ?? PROVIDER_PRESETS.custom;

  let apiKey: string | undefined;
  if (serviceKey !== "ollama") {
    const keyLabel = serviceKey === "anthropic" ? "Anthropic" : serviceKey === "openai" ? "OpenAI" : serviceKey === "openrouter" ? "OpenRouter" : "API";
    apiKey = (await askSecret(rl, `  ${C.cyan}${keyLabel} API key:${C.reset} `)).trim() || undefined;
    if (!apiKey) console.log(`  ${C.yellow}No key — set it later via /setup in Telegram.${C.reset}`);
  }

  let baseUrl = preset.baseUrl;
  if (serviceKey === "custom") {
    baseUrl = (await ask(rl, `\n  ${C.cyan}Base URL:${C.reset} `)).trim() || undefined;
  }

  // Fetch live models for OpenRouter
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
    model = choice === customOption ? (await ask(rl, `\n  ${C.cyan}Model name:${C.reset} `)).trim() : choice;
  } else {
    model = (await ask(rl, `\n  ${C.cyan}Model name:${C.reset} `)).trim();
  }

  const update: Record<string, unknown> = { provider: preset.provider, model };
  if (apiKey) update.apiKey = apiKey;
  if (baseUrl) update.baseUrl = baseUrl;
  saveConfig(update);

  ora({ indent: 2 }).succeed("API configured");

  return { provider: preset.provider, model, baseUrl, apiKey };
}
