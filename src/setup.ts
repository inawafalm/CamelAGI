// Unified setup wizard — configures API + optional Telegram
// Replaces both `camel setup` and `camel bootstrap`.

import * as p from "@clack/prompts";
import { loadConfig, saveConfig, ensureDirs, paths } from "./core/config.js";
import { seedWorkspace, seedAgentWorkspace } from "./workspace.js";
import { PROVIDER_PRESETS, fetchOpenRouterModels } from "./core/models.js";
import { listPendingRequests, approveRequest } from "./telegram/pairing.js";

function check<T>(value: T | symbol): T {
  if (p.isCancel(value)) { p.cancel("Setup cancelled."); process.exit(0); }
  return value as T;
}

export async function runSetup() {
  ensureDirs();
  seedWorkspace();

  p.intro("\x1b[36mCamelAGI\x1b[0m setup");

  // Resume detection
  let existing;
  try { existing = loadConfig(); } catch { existing = null; }

  const hasApiKey = !!existing?.apiKey;
  const hasAdmin = !!existing?.agents?.admin?.telegram?.botToken;
  const hasVerifiedUser = (existing?.agents?.admin?.telegram?.allowedUsers?.length ?? 0) > 0;

  // Show current status
  if (hasApiKey) p.log.success(`API: ${existing!.provider} / ${existing!.model}`);
  else p.log.step("API: not configured");
  if (hasAdmin && hasVerifiedUser) p.log.success("Telegram: connected");
  else if (hasAdmin) p.log.warn("Telegram: bot set, user not verified");
  else p.log.step("Telegram: not configured");

  if (hasApiKey && hasAdmin && hasVerifiedUser) {
    const redo = check(await p.confirm({ message: "Everything is set up. Reconfigure?" }));
    if (!redo) {
      p.outro("Nothing changed.");
      return;
    }
  }

  // ── Mode selection ──────────────────────────────────────────────

  const mode = check(await p.select({
    message: "How do you want to use CamelAGI?",
    options: [
      { value: "tui",      label: "Terminal (TUI)",       hint: "Just need an API key" },
      { value: "telegram",  label: "Telegram",             hint: "Admin bot + agents from Telegram" },
      { value: "both",      label: "Both",                 hint: "Terminal + Telegram" },
    ],
  }));

  const wantsTelegram = mode === "telegram" || mode === "both";

  // ── 1. API Provider ─────────────────────────────────────────────

  if (!hasApiKey) {
    await runApiSetup();
  } else if (check(await p.confirm({ message: "Reconfigure API provider?", initialValue: false }))) {
    await runApiSetup();
  }

  // ── 2. Telegram (optional) ──────────────────────────────────────

  if (wantsTelegram && (!hasAdmin || !hasVerifiedUser)) {
    await runTelegramSetup();
  } else if (wantsTelegram && hasAdmin && hasVerifiedUser) {
    p.log.success("Telegram already configured.");
  }

  // ── Done ────────────────────────────────────────────────────────

  const config = loadConfig();
  const lines = [
    `Provider  ${config.provider}`,
    `Model     ${config.model}`,
    `API Key   ${config.apiKey ? "\u2022\u2022\u2022\u2022" + config.apiKey.slice(-4) : "not set"}`,
  ];
  if (config.agents?.admin?.telegram?.botToken) {
    lines.push("Telegram  configured");
  }
  lines.push(`Config    ${paths.configFile}`);

  p.note(lines.join("\n"), "Setup complete");

  if (wantsTelegram) {
    p.outro("Run \x1b[36mcamel serve\x1b[0m to start the server.");
  } else {
    p.outro("Run \x1b[36mcamel chat\x1b[0m to start chatting.");
  }
}

// ─── API setup ────────────────────────────────────────────────────────

async function runApiSetup(): Promise<void> {
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

  let apiKey: string | undefined;
  if (provider !== "ollama") {
    const label = provider === "anthropic" ? "Anthropic" : provider === "openai" ? "OpenAI" : provider === "openrouter" ? "OpenRouter" : "API";
    apiKey = check(await p.password({ message: `${label} API key` })) || undefined;
    if (!apiKey) p.log.warn("No key \u2014 set it later in config.yaml or via env var.");
  }

  let baseUrl = preset.baseUrl;
  if (provider === "custom") {
    baseUrl = check(await p.text({ message: "Base URL", placeholder: "http://localhost:8080/v1" })) || undefined;
  }

  // Model
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

  const values: Record<string, unknown> = { provider: preset.provider, model: model.trim() };
  if (apiKey) values.apiKey = apiKey.trim();
  if (baseUrl) values.baseUrl = baseUrl.trim();
  if (!baseUrl && provider !== "custom") values.baseUrl = undefined;
  saveConfig(values);

  p.log.success(`${preset.provider} / ${model}`);
}

// ─── Telegram setup ───────────────────────────────────────────────────

async function runTelegramSetup(): Promise<void> {
  p.log.step("Telegram Admin Bot");
  p.log.info("Create a bot in Telegram via @BotFather \u2192 /newbot, then paste the token.");

  let botToken: string | undefined;
  let result: { ok: boolean; username?: string; name?: string; error?: string };

  // Retry loop for token validation
  for (;;) {
    const raw = check(await p.password({ message: "Bot token" }));
    botToken = typeof raw === "string" ? raw.trim() : "";
    if (!botToken) {
      p.log.warn("Skipped \u2014 add Telegram later with camel setup.");
      return;
    }

    const s = p.spinner();
    s.start("Validating...");
    result = await validateBotToken(botToken);
    if (result.ok) {
      s.stop(`Bot valid: @${result.username}`);
      break;
    }
    s.stop(`Invalid token: ${result.error}`);
    const retry = check(await p.confirm({ message: "Try again?" }));
    if (!retry) {
      p.log.warn("Skipped \u2014 add Telegram later with camel setup.");
      return;
    }
  }

  // Save admin bot config
  saveConfig({
    agents: {
      admin: {
        name: "Admin",
        admin: true,
        telegram: { botToken: botToken.trim(), allowedUsers: [] },
      },
    },
  });
  seedAgentWorkspace("admin", "Admin", "CamelAGI admin bot \u2014 manages your AI agents from Telegram");

  // Start just the admin bot for pairing (no full server needed)
  const s2 = p.spinner();
  s2.start("Starting admin bot...");
  try {
    const { setupAdminBot } = await import("./telegram/admin-bot.js");
    const { startPolling } = await import("./telegram/helpers.js");
    const config = loadConfig();
    const adminBot = await setupAdminBot("admin", botToken!, () => config, () => "", new Map());
    startPolling(adminBot, "admin");
    await new Promise((r) => setTimeout(r, 1500));
    s2.stop("Admin bot running");
  } catch (err) {
    s2.stop("Could not start admin bot");
    p.log.warn(`Pair later: run camel serve, then send a message to @${result.username} in Telegram.`);
    return;
  }

  // Mute background logs
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => { const f = typeof args[0] === "string" ? args[0] : ""; if (f.startsWith("\x1b[")) origLog(...args); };
  console.error = () => {};
  console.warn = () => {};

  // Wait for pairing
  const botName = `@${result.username}`;
  p.log.info(`Send any message to \x1b[36m${botName}\x1b[0m in Telegram.`);

  const s3 = p.spinner();
  s3.start("Waiting for message...");

  let pairingRequest: Awaited<ReturnType<typeof listPendingRequests>>[number] | undefined;
  for (let i = 0; i < 120; i++) {
    const pending = listPendingRequests().filter((r) => r.agentId === "admin" && r.status === "pending");
    if (pending.length > 0) { pairingRequest = pending[0]; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!pairingRequest) {
    s3.stop("Timeout");
    p.log.warn("No message received. Pair later via /pairing in Telegram.");
    console.log = origLog; console.error = origErr; console.warn = origWarn;
    return;
  }

  const userLabel = pairingRequest.username ? `@${pairingRequest.username}` : pairingRequest.firstName ?? String(pairingRequest.userId);
  s3.stop(`Request from ${userLabel}`);

  const approve = check(await p.confirm({ message: `Approve ${userLabel}?` }));
  if (!approve) {
    p.log.warn("Denied.");
    console.log = origLog; console.error = origErr; console.warn = origWarn;
    return;
  }

  const approved = approveRequest(pairingRequest.code);
  if (!approved) {
    p.log.error("Approval failed.");
    console.log = origLog; console.error = origErr; console.warn = origWarn;
    return;
  }

  // Notify user
  try {
    await fetch(`https://api.telegram.org/bot${botToken.trim()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: pairingRequest.chatId, text: "Access approved! You are now the admin." }),
    });
  } catch {}

  p.log.success(`${userLabel} approved!`);

  // Restore logs
  console.log = origLog; console.error = origErr; console.warn = origWarn;
}

// ─── Helpers ──────────────────────────────────────────────────────────

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
