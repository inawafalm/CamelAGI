// Full first-time bootstrap — admin bot + pairing + optional API setup
// After this, everything is controlled from Telegram.

import * as p from "@clack/prompts";
import { saveConfig, loadConfig, ensureDirs, paths } from "./core/config.js";
import { seedWorkspace, seedAgentWorkspace } from "./workspace.js";
import { PROVIDER_PRESETS, fetchOpenRouterModels } from "./core/models.js";
import { listPendingRequests, approveRequest } from "./extensions/pairing.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function bail(msg?: string): never {
  p.cancel(msg ?? "Setup cancelled.");
  process.exit(0);
}

function check<T>(value: T | symbol): T {
  if (p.isCancel(value)) bail();
  return value as T;
}

async function validateBotToken(token: string): Promise<{ ok: boolean; username?: string; name?: string; error?: string }> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await resp.json() as { ok: boolean; result?: { username?: string; first_name?: string }; description?: string };
    if (data.ok && data.result) return { ok: true, username: data.result.username, name: data.result.first_name };
    return { ok: false, error: data.description ?? "Invalid token" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Suppress background server logs during interactive prompts
let _logMuted = false;
const _origLog = console.log;
const _origError = console.error;
const _origWarn = console.warn;
function muteLogs() {
  if (_logMuted) return;
  _logMuted = true;
  console.log = () => {};
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

// ─── Bootstrap ───────────────────────────────────────────────────────

export async function runBootstrap(tokenArg?: string) {
  ensureDirs();
  seedWorkspace();

  p.intro("\x1b[36mCamelAGI\x1b[0m");

  // Resume detection
  let existingConfig;
  try { existingConfig = loadConfig(); } catch { existingConfig = null; }

  const hasAdminBot = !!existingConfig?.agents?.admin?.telegram?.botToken;
  const hasVerifiedUser = (existingConfig?.agents?.admin?.telegram?.allowedUsers?.length ?? 0) > 0;
  const hasApiKey = !!existingConfig?.apiKey;

  if (hasAdminBot && hasVerifiedUser && hasApiKey) {
    p.log.success(`Already configured: ${existingConfig!.provider} / ${existingConfig!.model}`);
    const reset = check(await p.confirm({ message: "Reset and start over?" }));
    if (!reset) {
      p.outro("Use /setup in Telegram to reconfigure.");
      return;
    }
  } else if (hasAdminBot && hasVerifiedUser && !hasApiKey) {
    p.log.success("Admin bot + identity configured");
    p.log.warn("API not set \u2014 resuming from step 3");

    const s = p.spinner();
    s.start("Starting server...");
    const { startServer } = await import("./serve.js");
    startServer({ cron: true, boot: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    s.stop("Server running");
    muteLogs();

    await runApiSetup();
    unmuteLogs();
    showDone(loadConfig());
    await new Promise(() => {});
    return;
  }

  // ── 1. Telegram Bot ────────────────────────────────────────────────

  p.log.step("\x1b[1m1. Telegram Bot\x1b[0m");
  p.log.info("Create a bot in @BotFather \u2192 /newbot, then paste the token.");

  let botToken = tokenArg ?? "";
  let result: Awaited<ReturnType<typeof validateBotToken>> = { ok: false };

  while (true) {
    if (!botToken) {
      botToken = check(await p.password({ message: "Bot token" }));
    }
    if (!botToken.trim()) {
      p.log.warn("Empty \u2014 try again.");
      botToken = "";
      continue;
    }
    botToken = botToken.trim();

    const s = p.spinner();
    s.start("Validating...");
    result = await validateBotToken(botToken);

    if (result.ok) {
      s.stop(`@${result.username} (${result.name})`);
      break;
    }
    if (result.error?.includes("fetch failed") || result.error?.includes("ENOTFOUND")) {
      s.stop("Could not reach Telegram \u2014 skipping validation");
      break;
    }
    s.stop(`Invalid: ${result.error}`);
    p.log.warn("Try again.");
    botToken = "";
  }

  saveConfig({
    agents: {
      admin: { name: "Admin", admin: true, telegram: { botToken, allowedUsers: [] } },
    },
  });
  seedAgentWorkspace("admin", "Admin", "CamelAGI admin bot");
  p.log.success("Admin bot configured");

  // ── 2. Identity ────────────────────────────────────────────────────

  const s2 = p.spinner();
  s2.start("Starting server...");
  const { startServer } = await import("./serve.js");
  startServer({ cron: true, boot: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  s2.stop("Server running");
  muteLogs();

  const botName = result.ok ? `@${result.username}` : "your admin bot";
  p.log.step("\x1b[1m2. Verify Identity\x1b[0m");
  p.log.info(`Send any message to \x1b[36m${botName}\x1b[0m in Telegram.`);

  const s3 = p.spinner();
  s3.start("Waiting for message...");

  let pairingRequest: Awaited<ReturnType<typeof listPendingRequests>>[number] | undefined;
  for (let i = 0; i < 120; i++) {
    const pending = listPendingRequests().filter((req) => req.agentId === "admin" && req.status === "pending");
    if (pending.length > 0) { pairingRequest = pending[0]; break; }
    await new Promise((res) => setTimeout(res, 1000));
  }

  if (!pairingRequest) {
    s3.stop("Timeout \u2014 no message received");
    p.log.warn("Pair later via /pairing in Telegram.");
    p.outro("Server running. Ctrl+C to stop.");
    unmuteLogs();
    await new Promise(() => {});
    return;
  }

  const userLabel = pairingRequest.username ? `@${pairingRequest.username}` : pairingRequest.firstName ?? String(pairingRequest.userId);
  s3.stop(`Request from \x1b[1m${userLabel}\x1b[0m (${pairingRequest.userId})`);

  const approve = check(await p.confirm({ message: `Approve ${userLabel}?` }));
  if (!approve) {
    p.log.warn("Denied. Pair later via /pairing.");
    unmuteLogs();
    await new Promise(() => {});
    return;
  }

  const approved = approveRequest(pairingRequest.code);
  if (!approved) {
    p.log.error("Approval failed.");
    unmuteLogs();
    await new Promise(() => {});
    return;
  }

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: pairingRequest.chatId, text: "Access approved! You are now the admin." }),
    });
  } catch { /* best effort */ }

  p.log.success(`${userLabel} approved`);

  // ── 3. AI Provider ─────────────────────────────────────────────────

  p.log.step("\x1b[1m3. AI Provider\x1b[0m");

  const setupNow = check(await p.confirm({ message: "Configure now?" }));

  if (setupNow) {
    await runApiSetup();
  } else {
    p.log.info("Skipped \u2014 use /setup in Telegram later.");
  }

  unmuteLogs();
  showDone(loadConfig(), botName, userLabel);
  await new Promise(() => {});
}

// ─── Done ────────────────────────────────────────────────────────────

function showDone(config: any, botName?: string, admin?: string) {
  const lines = [
    `Provider  ${config.provider}`,
    `Model     ${config.model}`,
    `API Key   ${config.apiKey ? "\u2022\u2022\u2022\u2022" + config.apiKey.slice(-4) : "not set"}`,
  ];
  if (botName) lines.push(`Bot       ${botName}`);
  if (admin) lines.push(`Admin     ${admin}`);
  lines.push(`Config    ${paths.configFile}`);

  p.note(lines.join("\n"), "Setup complete");
  p.log.info("Next: /newagent in Telegram to create your first agent.");
  p.outro("Server running. Ctrl+C to stop.");
}

// ─── API setup ───────────────────────────────────────────────────────

async function runApiSetup(): Promise<void> {
  const provider = check(await p.select({
    message: "Provider",
    options: [
      { value: "anthropic",  label: "Anthropic",  hint: "Claude (direct)" },
      { value: "openai",     label: "OpenAI",     hint: "GPT (direct)" },
      { value: "openrouter", label: "OpenRouter",  hint: "Any model" },
      { value: "ollama",     label: "Ollama",     hint: "Local models" },
      { value: "custom",     label: "Custom",     hint: "Custom endpoint" },
    ],
  }));

  const preset = PROVIDER_PRESETS[provider] ?? PROVIDER_PRESETS.custom;

  let apiKey: string | undefined;
  if (provider !== "ollama") {
    const label = provider === "anthropic" ? "Anthropic" : provider === "openai" ? "OpenAI" : provider === "openrouter" ? "OpenRouter" : "API";
    apiKey = check(await p.password({ message: `${label} API key` })) || undefined;
    if (!apiKey) p.log.warn("No key \u2014 set later via /setup in Telegram.");
  }

  let baseUrl = preset.baseUrl;
  if (provider === "custom") {
    baseUrl = check(await p.text({ message: "Base URL", placeholder: "http://localhost:8080/v1" })) || undefined;
  }

  // Fetch live models for OpenRouter
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

  const update: Record<string, unknown> = { provider: preset.provider, model };
  if (apiKey) update.apiKey = apiKey;
  if (baseUrl) update.baseUrl = baseUrl;
  saveConfig(update);

  p.log.success(`${preset.provider} / ${model}`);
}
