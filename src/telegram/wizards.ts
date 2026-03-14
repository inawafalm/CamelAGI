// Wizard definitions: setup, new agent, validation, presets

import { InlineKeyboard } from "grammy";
import type { Config } from "../core/config.js";
import { loadConfig, saveConfig } from "../core/config.js";
import { seedAgentWorkspace, agentMemoryDir } from "../workspace.js";
import { requestBotApproval } from "./bot-approval.js";
import type { WizardDef } from "./wizard.js";

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

// ─── Helpers ─────────────────────────────────────────────────────────

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
        id: "description",
        prompt: "What does this agent do? (one line, goes into SOUL.md):",
      },
      {
        id: "model",
        prompt: "Model:",
        options: [
          { label: "Use default", value: "__default__" },
          { label: "Change", value: "__custom__" },
        ],
      },
      {
        id: "modelCustom",
        prompt: "Enter model name:",
        skip: (data) => data.model !== "__custom__",
      },
      {
        id: "token",
        prompt: "Telegram bot token (create one in @BotFather):",
        options: [
          { label: "Skip Telegram", value: "__skip__" },
        ],
      },
    ],
    onComplete: async (data, chatId, bot) => {
      const config = getConfig();

      const existingIds = Object.keys(config.agents);
      const id = nameToId(data.name, existingIds);
      const model = data.model === "__custom__" ? data.modelCustom : undefined;

      let tokenInfo = "";
      if (data.token && data.token !== "__skip__") {
        const result = await validateBotToken(data.token);
        if (!result.ok) {
          return `Token validation failed: ${result.error}\n\nRun /newagent again.`;
        }
        tokenInfo = `\nTelegram: @${result.username}`;
      }

      seedAgentWorkspace(id, data.name, data.description);

      const agentConfig: Record<string, unknown> = { name: data.name };
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
        // Request admin approval before starting the bot
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

        // Send approval message with inline buttons
        const approvalText = [
          `New agent wants to connect\n`,
          `Name: ${data.name}`,
          `ID: ${id}`,
          botUsername ? `Bot: @${botUsername}` : null,
          `Model: ${model ?? config.model}`,
        ].filter(Boolean).join("\n");

        const keyboard = new InlineKeyboard()
          .text("Approve", `botapproval:approve:${id}`)
          .text("Deny", `botapproval:deny:${id}`);

        try {
          await bot.api.sendMessage(chatId, approvalText, { reply_markup: keyboard });
        } catch { /* best effort */ }

        tokenInfo += "\nBot pending approval. Approve to start polling.";
      }

      const dir = agentMemoryDir(id);
      return [
        `Agent created!\n`,
        `Name: ${data.name}`,
        `ID: ${id}`,
        `Model: ${model ?? config.model} (default)`,
        tokenInfo,
        `\n${dir}`,
      ].filter(Boolean).join("\n");
    },
  };
}
