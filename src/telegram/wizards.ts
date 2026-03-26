// Wizard definitions: setup, new agent, validation, presets

import { InlineKeyboard } from "grammy";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../core/config.js";
import { loadConfig, saveConfig } from "../core/config.js";
import { seedAgentWorkspace, agentMemoryDir, cloneAgentWorkspace } from "../workspace.js";
import { requestBotApproval } from "./bot-approval.js";
import { resolvePreset } from "../core/models.js";
import type { WizardDef, WizardStep } from "./wizard.js";

// ─── Presets ─────────────────────────────────────────────────────────

export const PRESETS: Record<string, { provider: string; baseUrl?: string; models: string[] }> = {
  anthropic: {
    provider: "anthropic",
    models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-20250506"],
  },
  openai: {
    provider: "openai",
    models: ["gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
  },
  openrouter: {
    provider: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      "anthropic/claude-sonnet-4-20250514",
      "anthropic/claude-opus-4-20250514",
      "openai/gpt-4o",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-r1",
      "deepseek/deepseek-chat",
    ],
  },
  ollama: {
    provider: "openai",
    baseUrl: "http://localhost:11434/v1",
    models: ["llama3.3", "qwen3", "deepseek-r1", "gemma3"],
  },
};

// ─── SOUL Templates ─────────────────────────────────────────────────

export const SOUL_TEMPLATES: Record<string, { label: string; soul: string; model?: string }> = {
  coding: {
    label: "💻 Coding Assistant",
    model: "claude-sonnet-4-20250514",
    soul: `# Coding Assistant

You're a senior software engineer. Write clean, efficient code. Explain decisions briefly. Test before shipping.

## Approach
- Read the codebase before changing it
- Prefer simple solutions over clever ones
- Fix root causes, not symptoms
- When debugging, form a hypothesis first

## Style
- Direct and technical. Skip pleasantries.
- Show code, not descriptions of code
- Suggest alternatives when the requested approach has trade-offs
`,
  },
  research: {
    label: "🔍 Research",
    model: "gpt-4o",
    soul: `# Research Assistant

You're a meticulous researcher. Find information, verify claims, synthesize insights.

## Approach
- Search multiple sources before concluding
- Distinguish between facts and opinions
- Cite where you found information
- Flag when information might be outdated

## Style
- Thorough but organized. Use headers and bullet points.
- Start with the bottom line, then supporting details
- Be honest about confidence levels
`,
  },
  writing: {
    label: "✍️ Writing",
    soul: `# Writing Assistant

You're a skilled writer and editor. Help draft, revise, and polish text.

## Approach
- Match the user's voice and tone
- Focus on clarity and impact
- Cut unnecessary words ruthlessly
- Suggest structure improvements

## Style
- Warm but concise
- Show, don't tell
- Give specific feedback, not vague praise
`,
  },
  general: {
    label: "🤖 General",
    soul: "",
  },
  custom: {
    label: "✏️ Custom",
    soul: "",
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────

/** Extract a bot token from text (handles forwarded BotFather messages or raw token) */
function extractBotToken(input: string): string | null {
  const match = input.match(/\d{8,}:[A-Za-z0-9_-]{30,}/);
  return match ? match[0] : null;
}

/** Validate a Telegram bot token by calling getMe */
export async function validateBotToken(token: string): Promise<{ ok: boolean; username?: string; name?: string; error?: string }> {
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

/** Generate a unique slug ID from a display name */
export function nameToId(name: string, existingIds: string[]): string {
  let base = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!base) base = "agent";
  let id = base;
  let counter = 1;
  while (existingIds.includes(id)) {
    counter++;
    id = `${base}${counter}`;
  }
  return id;
}

// ─── Wizard Definitions ─────────────────────────────────────────────

export function createSetupWizard(getConfig: () => Config): WizardDef {
  return {
    id: "setup",
    steps: [
      {
        id: "service",
        prompt: "Which AI provider?",
        options: [
          { label: "Anthropic", value: "anthropic" },
          { label: "OpenAI", value: "openai" },
          { label: "OpenRouter", value: "openrouter" },
          { label: "Ollama", value: "ollama" },
          { label: "Custom", value: "custom" },
        ],
      },
      {
        id: "apiKey",
        prompt: "Enter your API key:",
        skip: (data) => data.service === "ollama",
      },
      {
        id: "baseUrl",
        prompt: "Enter the base URL (e.g. http://localhost:8080/v1):",
        skip: (data) => data.service !== "custom",
      },
      {
        id: "model",
        prompt: "Which model? (type a name or pick below)",
      },
    ],
    onComplete: async (data) => {
      const preset = PRESETS[data.service];
      const values: Record<string, unknown> = {
        provider: preset?.provider ?? "openai",
        model: data.model,
      };
      if (data.apiKey) values.apiKey = data.apiKey;
      if (data.service === "custom" && data.baseUrl) {
        values.baseUrl = data.baseUrl;
      } else if (preset?.baseUrl) {
        values.baseUrl = preset.baseUrl;
      }

      saveConfig(values);

      const maskedKey = data.apiKey ? `***${data.apiKey.slice(-4)}` : "not set";
      return [
        "Setup complete!\n",
        `Provider: ${values.provider}`,
        `Model: ${data.model}`,
        values.baseUrl ? `Base URL: ${values.baseUrl}` : null,
        `API Key: ${maskedKey}`,
        "",
        "Create your first agent with /newagent",
      ].filter(Boolean).join("\n");
    },
  };
}

/** Build model selection steps — adapts to provider (simple list vs provider→model 2-step) */
function buildModelSteps(getConfig: () => Config): WizardStep[] {
  const config = getConfig();
  const preset = resolvePreset(config.provider, config.baseUrl);

  // Group models by provider prefix
  const groups = new Map<string, string[]>();
  for (const m of preset.models) {
    const slash = m.indexOf("/");
    const provider = slash > 0 ? m.slice(0, slash) : "__direct__";
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider)!.push(m);
  }

  const hasProviders = groups.size > 1 || (groups.size === 1 && !groups.has("__direct__"));

  if (!hasProviders) {
    // Simple provider (Anthropic, OpenAI, Ollama) — show models directly
    return [{
      id: "model",
      prompt: `Model (current: ${config.model}):`,
      columns: 1,
      skip: (data) => data.mode === "claude-code" || data.useRecommended === "__recommended__",
      options: [
        { label: `✓ ${config.model} (default)`, value: "__default__" },
        ...preset.models
          .filter(m => m !== config.model)
          .map(m => ({ label: m, value: m })),
      ],
    }];
  }

  // Multi-provider (OpenRouter) — 2-step: pick provider, then model
  const providerNames = [...groups.keys()];
  const providerLabels: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    deepseek: "DeepSeek",
    "meta-llama": "Meta",
    qwen: "Qwen",
    mistralai: "Mistral",
    "x-ai": "xAI",
    cohere: "Cohere",
    amazon: "Amazon",
  };

  return [
    {
      id: "modelProvider",
      prompt: `Model (current: ${config.model}):\n\nPick a provider or type a custom model name:`,
      columns: 2,
      skip: (data) => data.mode === "claude-code" || data.useRecommended === "__recommended__",
      options: [
        { label: `✓ ${config.model} (default)`, value: "__default__" },
        ...providerNames.map(p => ({
          label: `${providerLabels[p] ?? p} (${groups.get(p)!.length})`,
          value: p,
        })),
      ],
    },
    {
      id: "model",
      prompt: (data) => {
        const p = providerLabels[data.modelProvider] ?? data.modelProvider;
        return `${p} models:`;
      },
      columns: 1,
      skip: (data) => data.mode === "claude-code" || data.modelProvider === "__default__" || data.useRecommended === "__recommended__",
      options: (data) => {
        const selected = data.modelProvider;
        const models = groups.get(selected) ?? [];
        return models
          .filter(m => m !== config.model)
          .map(m => {
            const slash = m.indexOf("/");
            const shortName = slash > 0 ? m.slice(slash + 1) : m;
            return { label: shortName, value: m };
          });
      },
    },
  ];
}

export function createNewAgentWizard(getConfig: () => Config, getSystemPrompt: () => string): WizardDef {
  return {
    id: "newagent",
    steps: [
      {
        id: "name",
        prompt: "Agent name (e.g. \"Personal Finance\", \"Coder\", \"Journal\"):",
        validate: (value) => value ? null : "Name cannot be empty.",
      },
      {
        id: "mode",
        prompt: "How should this agent work?",
        columns: 1,
        options: [
          { label: "LLM (API-based)", value: "llm" },
          { label: "Claude Code (local CLI)", value: "claude-code" },
        ],
      },
      {
        id: "template",
        prompt: "Agent personality template:",
        skip: (data) => data.mode === "claude-code",
        columns: 1,
        options: Object.entries(SOUL_TEMPLATES).map(([key, t]) => ({
          label: t.label,
          value: key,
        })),
      },
      {
        id: "descriptionCustom",
        prompt: "What does this agent do? (one line, goes into SOUL.md):",
        skip: (data) => data.mode === "claude-code" || data.template !== "custom",
      },
      {
        id: "useRecommended",
        prompt: (data) => {
          const t = SOUL_TEMPLATES[data.template];
          return `Recommended model: ${t?.model}\n\nUse this model?`;
        },
        skip: (data) => data.mode === "claude-code" || !SOUL_TEMPLATES[data.template]?.model,
        options: [
          { label: "✓ Use recommended", value: "__recommended__" },
          { label: "Choose different", value: "__choose__" },
        ],
      },
      ...buildModelSteps(getConfig),
      {
        id: "token",
        prompt: "Connect a Telegram bot?\n\nPaste a token or forward the BotFather message, or skip:",
        transform: (input) => extractBotToken(input) ?? input,
        validate: (input) => {
          if (input === "__skip__") return null;
          return /^\d{8,}:[A-Za-z0-9_-]{30,}$/.test(input) ? null : "No valid bot token found. Paste the token or forward the full BotFather message.";
        },
        options: [
          { label: "Skip — no Telegram bot", value: "__skip__" },
        ],
      },
    ],
    onComplete: async (data, chatId, bot) => {
      const config = getConfig();

      const existingIds = Object.keys(config.agents);
      const id = nameToId(data.name, existingIds);
      let model: string | undefined;
      if (data.useRecommended === "__recommended__") {
        model = SOUL_TEMPLATES[data.template]?.model;
      } else {
        model = (data.modelProvider === "__default__" || data.model === "__default__") ? undefined : data.model;
      }

      let tokenInfo = "";
      if (data.token && data.token !== "__skip__") {
        const result = await validateBotToken(data.token);
        if (!result.ok) {
          return `Token validation failed: ${result.error}\n\nRun /newagent again.`;
        }
        tokenInfo = `\nTelegram: @${result.username}`;
      }

      const description = data.template === "custom" ? data.descriptionCustom : undefined;
      seedAgentWorkspace(id, data.name, description);

      // Apply SOUL template if selected
      const tmpl = SOUL_TEMPLATES[data.template];
      if (tmpl?.soul) {
        const soulPath = path.join(agentMemoryDir(id), "SOUL.md");
        fs.writeFileSync(soulPath, tmpl.soul);
      }

      const agentConfig: Record<string, unknown> = { name: data.name };
      if (data.mode === "claude-code") agentConfig.mode = "claude-code";
      if (model) agentConfig.model = model;
      if (data.token && data.token !== "__skip__") {
        agentConfig.telegram = {
          botToken: data.token,
          allowedUsers: config.agents.admin?.telegram?.allowedUsers ?? [],
        };
      }

      const agents = { ...config.agents, [id]: agentConfig };
      saveConfig({ agents });

      if (data.token && data.token !== "__skip__") {
        const validationResult = await validateBotToken(data.token);
        const botUsername = validationResult.ok ? validationResult.username : undefined;
        requestBotApproval({
          agentId: id,
          agentName: data.name,
          botToken: data.token,
          botUsername,
          model: model ?? config.model,
          requestedAt: Date.now(),
        });
        if (botUsername) tokenInfo += `\nTelegram: @${botUsername}`;
      }

      // Send creation summary first
      const dir = agentMemoryDir(id);
      const modeLabel = data.mode === "claude-code" ? "Claude Code (local CLI)" : `LLM — ${model ?? config.model}`;
      const summary = [
        `Agent created!\n`,
        `Name: ${data.name}`,
        `ID: ${id}`,
        `Mode: ${modeLabel}`,
        tokenInfo,
        `\n${dir}`,
      ].filter(Boolean).join("\n");

      try {
        await bot.api.sendMessage(chatId, summary);
      } catch { /* best effort */ }

      // Then send approval buttons as the last message
      if (data.token && data.token !== "__skip__") {
        const keyboard = new InlineKeyboard()
          .text("Approve", `botapproval:approve:${id}`)
          .text("Deny", `botapproval:deny:${id}`);

        try {
          await bot.api.sendMessage(chatId, `Start @${data.name} bot?`, { reply_markup: keyboard });
        } catch { /* best effort */ }
      }

      return null as unknown as string;
    },
  };
}

// ─── MCP Add Wizard ──────────────────────────────────────────────────

/** Derive a short server name from a URL */
function mcpNameFromUrl(url: string, existing: string[]): string {
  try {
    const host = new URL(url).hostname;
    let base = host
      .replace(/^(www|api|mcp)\./, "")
      .replace(/\.(com|io|ai|dev|org|net)$/, "")
      .replace(/\./g, "-");
    if (!base) base = "server";
    let name = base;
    let i = 2;
    while (existing.includes(name)) { name = `${base}${i++}`; }
    return name;
  } catch {
    return `server${existing.length + 1}`;
  }
}

/** Derive a short server name from a stdio command */
function mcpNameFromCommand(command: string, existing: string[]): string {
  const match = command.match(/(?:@[\w-]+\/)?([\w-]+)\s*$/);
  let base = match?.[1] ?? "server";
  base = base
    .replace(/^(mcp-server-|server-|mcp-)/, "")
    .replace(/(-mcp|-server)$/, "");
  if (!base) base = "server";
  let name = base;
  let i = 2;
  while (existing.includes(name)) { name = `${base}${i++}`; }
  return name;
}

export function createMcpAddWizard(getConfig: () => Config, agentId?: string): WizardDef {
  return {
    id: "mcp-add",
    steps: [
      {
        id: "transport",
        prompt: [
          "Server type:\n",
          "🌐 HTTP — Remote server via URL",
          "  e.g. https://code.claude.com/docs/mcp\n",
          "📡 SSE — Streaming server via URL",
          "  e.g. https://api.example.com/mcp/sse\n",
          "⚙️ Command — Local tool on your machine",
          "  e.g. npx -y @modelcontextprotocol/server-github",
        ].join("\n"),
        options: [
          { label: "🌐 HTTP", value: "http" },
          { label: "📡 SSE", value: "sse" },
          { label: "⚙️ Command", value: "stdio" },
        ],
      },
      {
        id: "url",
        prompt: [
          "Send the MCP server URL:\n",
          "Examples:",
          "  https://code.claude.com/docs/mcp",
          "  https://mcp.example.com/api",
        ].join("\n"),
        skip: (data) => data.transport === "stdio",
        validate: (input) => {
          try { new URL(input); return null; }
          catch { return "Not a valid URL. Try again:"; }
        },
      },
      {
        id: "command",
        prompt: [
          "Send the full command:\n",
          "Examples:",
          "  npx -y @modelcontextprotocol/server-github",
          "  npx -y @modelcontextprotocol/server-filesystem ~/Documents",
          "  npx -y @anthropic-ai/mcp-server-brave-search",
        ].join("\n"),
        skip: (data) => data.transport !== "stdio",
        validate: (input) => input.trim() ? null : "Command cannot be empty.",
      },
      {
        id: "auth",
        prompt: "Auth token? (sent as Bearer header)\n\nPaste your API key or token, or skip.",
        skip: (data) => data.transport === "stdio",
        options: [{ label: "Skip — no auth", value: "__skip__" }],
      },
      {
        id: "env",
        prompt: "Environment variable?\n\nExample: GITHUB_TOKEN=ghp_xxxx",
        skip: (data) => data.transport !== "stdio",
        options: [{ label: "Skip — no env", value: "__skip__" }],
      },
    ],
    onComplete: async (data) => {
      const config = getConfig();
      const currentServers = agentId && config.agents[agentId]
        ? config.agents[agentId]?.mcp?.servers ?? {}
        : config.mcp.servers;
      const existing = Object.keys(currentServers);

      let name: string;
      let serverConfig: Record<string, unknown>;

      if (data.transport === "stdio") {
        const parts = data.command.trim().split(/\s+/);
        name = mcpNameFromCommand(data.command, existing);
        serverConfig = {
          type: "stdio",
          command: parts[0],
          args: parts.slice(1),
        };
        if (data.env && data.env !== "__skip__") {
          const eqIdx = data.env.indexOf("=");
          if (eqIdx > 0) {
            serverConfig.env = { [data.env.slice(0, eqIdx)]: data.env.slice(eqIdx + 1) };
          }
        }
      } else {
        name = mcpNameFromUrl(data.url, existing);
        serverConfig = {
          type: data.transport,
          url: data.url,
        };
        if (data.auth && data.auth !== "__skip__") {
          serverConfig.headers = { Authorization: `Bearer ${data.auth}` };
        }
      }

      const updated = { ...currentServers, [name]: serverConfig };
      if (agentId && config.agents[agentId]) {
        const agents = { ...config.agents };
        agents[agentId] = { ...agents[agentId], mcp: { servers: updated } } as typeof agents[string];
        saveConfig({ agents });
      } else {
        saveConfig({ mcp: { servers: updated } });
      }

      const scope = agentId && config.agents[agentId] ? config.agents[agentId].name : "global";
      const detail = data.url ?? data.command;
      return `MCP server added! (${scope})\n\nName: ${name}\nType: ${data.transport}\n${detail}`;
    },
  };
}

// ─── Clone Agent Wizard ─────────────────────────────────────────────

export function createCloneWizard(
  sourceId: string,
  getConfig: () => Config,
  getSystemPrompt: () => string,
): WizardDef {
  return {
    id: "clone-agent",
    steps: [
      {
        id: "name",
        prompt: `Clone "${sourceId}" — new agent name:`,
        validate: (value) => value ? null : "Name cannot be empty.",
      },
      {
        id: "token",
        prompt: "Connect a Telegram bot?\n\nPaste a token or forward the BotFather message, or skip:",
        transform: (input) => extractBotToken(input) ?? input,
        validate: (input) => {
          if (input === "__skip__") return null;
          return /^\d{8,}:[A-Za-z0-9_-]{30,}$/.test(input) ? null : "No valid bot token found. Paste the token or forward the full BotFather message.";
        },
        options: [
          { label: "Skip — no Telegram bot", value: "__skip__" },
        ],
      },
    ],
    onComplete: async (data, chatId, bot) => {
      const config = getConfig();
      const existingIds = Object.keys(config.agents);
      const newId = nameToId(data.name, existingIds);

      // Clone workspace files
      cloneAgentWorkspace(sourceId, newId, data.name);

      // Clone config (model, thinking, effort, maxTurns, MCP)
      const source = config.agents[sourceId];
      const agentConfig: Record<string, unknown> = { name: data.name };
      if (source?.model) agentConfig.model = source.model;
      if (source?.thinking) agentConfig.thinking = source.thinking;
      if (source?.effort) agentConfig.effort = source.effort;
      if (source?.maxTurns) agentConfig.maxTurns = source.maxTurns;
      if (source?.mcp?.servers && Object.keys(source.mcp.servers).length > 0) {
        agentConfig.mcp = { servers: { ...source.mcp.servers } };
      }

      let tokenInfo = "";
      if (data.token && data.token !== "__skip__") {
        const result = await validateBotToken(data.token);
        if (!result.ok) {
          return `Token validation failed: ${result.error}\n\nTry again.`;
        }
        agentConfig.telegram = {
          botToken: data.token,
          allowedUsers: config.agents.admin?.telegram?.allowedUsers ?? [],
        };
        tokenInfo = `\nTelegram: @${result.username}`;

        requestBotApproval({
          agentId: newId,
          agentName: data.name,
          botToken: data.token,
          botUsername: result.username,
          model: (source?.model ?? config.model),
          requestedAt: Date.now(),
        });

        const keyboard = new InlineKeyboard()
          .text("Approve", `botapproval:approve:${newId}`)
          .text("Deny", `botapproval:deny:${newId}`);

        try {
          await bot.api.sendMessage(chatId, [
            `Cloned agent wants to connect\n`,
            `Name: ${data.name}`,
            `ID: ${newId}`,
            result.username ? `Bot: @${result.username}` : null,
          ].filter(Boolean).join("\n"), { reply_markup: keyboard });
        } catch { /* best effort */ }

        tokenInfo += "\nBot pending approval.";
      }

      const agents = { ...config.agents, [newId]: agentConfig };
      saveConfig({ agents });

      return [
        `Agent cloned!\n`,
        `Source: ${sourceId}`,
        `Name: ${data.name}`,
        `ID: ${newId}`,
        `Model: ${source?.model ?? config.model}`,
        tokenInfo,
        `\nWorkspace files copied.`,
      ].filter(Boolean).join("\n");
    },
  };
}
