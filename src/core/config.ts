// Config: env vars + optional YAML file at ~/.camelagi/config.yaml

import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import "dotenv/config";

const configDir = path.join(os.homedir(), ".camelagi");
const configFile = path.join(configDir, "config.yaml");
const sessionsDir = path.join(configDir, "sessions");

export const paths = { configDir, configFile, sessionsDir };

const schema = z.object({
  provider: z.enum(["anthropic", "openai"]).default("anthropic"),
  model: z.string().default("claude-sonnet-4-20250514"),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  systemPrompt: z.string().default(
    "You are CamelAGI, a helpful AI assistant. You have access to tools for running shell commands, reading/writing files, and fetching URLs. Use them when needed to help the user.",
  ),
  thinking: z.enum(["off", "low", "medium", "high"]).default("off"),
  effort: z.enum(["low", "medium", "high", "max"]).default("high"),
  maxBudgetUsd: z.number().optional(),
  maxTurns: z.number().default(25),
  timeoutSeconds: z.number().default(300),
  serve: z.object({
    port: z.number().default(18305),
    host: z.string().default("127.0.0.1"),
    token: z.string().optional(),
    rateLimit: z.object({
      windowMs: z.number().default(60_000),
      max: z.number().default(60),
    }).default(() => ({ windowMs: 60_000, max: 60 })),
    tailscale: z.enum(["off", "serve", "funnel"]).default("off"),
  }).default(() => ({ port: 18305, host: "127.0.0.1", rateLimit: { windowMs: 60_000, max: 60 }, tailscale: "off" as const })),
  telegram: z.object({
    botToken: z.string().optional(),
    allowedUsers: z.array(z.number()).default([]),
    groups: z.object({
      mentionOnly: z.boolean().default(true),
    }).default(() => ({ mentionOnly: true })),
    chats: z.record(z.string(), z.object({
      name: z.string().optional(),
      model: z.string().optional(),
      systemPrompt: z.string().optional(),
      maxTurns: z.number().optional(),
      thinking: z.enum(["off", "low", "medium", "high"]).optional(),
      effort: z.enum(["low", "medium", "high", "max"]).optional(),
    })).default(() => ({})),
  }).default(() => ({ allowedUsers: [], groups: { mentionOnly: true }, chats: {} })),
  compaction: z.object({
    enabled: z.boolean().default(true),
    maxTokens: z.number().default(80_000),
    keepTurns: z.number().default(6),
  }).default(() => ({ enabled: true, maxTokens: 80_000, keepTurns: 6 })),
  tools: z.object({
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  }).default(() => ({ allow: [], deny: [] })),
  skills: z.object({
    enabled: z.boolean().default(true),
    deny: z.array(z.string()).default([]),
  }).default(() => ({ enabled: true, deny: [] })),
  mcp: z.object({
    servers: z.record(z.string(), z.preprocess(
      // Default type to "stdio" for backward compat (existing configs omit it)
      (val) => {
        if (val && typeof val === "object" && !("type" in (val as Record<string, unknown>))) {
          return { ...(val as Record<string, unknown>), type: "stdio" };
        }
        return val;
      },
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("stdio"),
          command: z.string(),
          args: z.array(z.string()).default([]),
          env: z.record(z.string(), z.string()).default({}),
        }),
        z.object({
          type: z.literal("http"),
          url: z.string(),
          headers: z.record(z.string(), z.string()).default({}),
        }),
        z.object({
          type: z.literal("sse"),
          url: z.string(),
          headers: z.record(z.string(), z.string()).default({}),
        }),
      ]),
    )).default({}),
  }).default(() => ({ servers: {} })),
  hooks: z.object({
    enabled: z.boolean().default(false),
  }).default(() => ({ enabled: false })),
  approvals: z.object({
    mode: z.enum(["off", "smart", "always"]).default("off"),
    allowlist: z.array(z.string()).default([]),
    timeoutSeconds: z.number().default(120),
    fallback: z.enum(["deny", "allow"]).default("deny"),
    /** Telegram chat ID to forward approval requests to when running headless */
    forwardTo: z.number().optional(),
  }).default(() => ({ mode: "off" as const, allowlist: [] as string[], timeoutSeconds: 120, fallback: "deny" as const })),
  retry: z.object({
    maxRetries: z.number().default(3),
    backoffMs: z.number().default(1000),
  }).default(() => ({ maxRetries: 3, backoffMs: 1000 })),
  voice: z.object({
    enabled: z.boolean().default(false),
    provider: z.enum(["groq", "openai", "deepgram"]).default("groq"),
    apiKey: z.string().optional(),
    model: z.string().optional(),
    language: z.string().optional(),
  }).default(() => ({ enabled: false, provider: "groq" as const })),
  lanes: z.object({
    main: z.number().default(3),
    cron: z.number().default(1),
    subagent: z.number().default(5),
  }).default(() => ({ main: 3, cron: 1, subagent: 5 })),
  agents: z.record(z.string(), z.object({
    name: z.string(),
    admin: z.boolean().default(false),
    mode: z.enum(["llm", "claude-code"]).default("llm").optional(),
    workDir: z.string().optional(),
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    thinking: z.enum(["off", "low", "medium", "high"]).optional(),
    effort: z.enum(["low", "medium", "high", "max"]).optional(),
    maxTurns: z.number().optional(),
    mcp: z.object({
      servers: z.record(z.string(), z.preprocess(
        (val) => {
          if (val && typeof val === "object" && !("type" in (val as Record<string, unknown>))) {
            return { ...(val as Record<string, unknown>), type: "stdio" };
          }
          return val;
        },
        z.discriminatedUnion("type", [
          z.object({
            type: z.literal("stdio"),
            command: z.string(),
            args: z.array(z.string()).default([]),
            env: z.record(z.string(), z.string()).default({}),
          }),
          z.object({
            type: z.literal("http"),
            url: z.string(),
            headers: z.record(z.string(), z.string()).default({}),
          }),
          z.object({
            type: z.literal("sse"),
            url: z.string(),
            headers: z.record(z.string(), z.string()).default({}),
          }),
        ]),
      )).default({}),
    }).optional(),
    telegram: z.object({
      botToken: z.string(),
      allowedUsers: z.array(z.number()).default([]),
      briefMode: z.boolean().default(true),
      groups: z.object({
        mentionOnly: z.boolean().default(true),
      }).default(() => ({ mentionOnly: true })),
    }).optional(),
    discord: z.object({
      botToken: z.string(),
      allowedChannels: z.array(z.string()).default([]),
      allowedRoles: z.array(z.string()).default([]),
      mentionOnly: z.boolean().default(true),
    }).optional(),
  })).default(() => ({})),
  boot: z.boolean().default(true),
  heartbeat: z.object({
    enabled: z.boolean().default(false),
    interval: z.string().default("30m"),
    prompt: z.string().default(
      "Read HEARTBEAT.md in your workspace. Follow any tasks listed. If nothing needs attention, reply HEARTBEAT_OK.",
    ),
  }).default(() => ({ enabled: false, interval: "30m", prompt: "Read HEARTBEAT.md in your workspace. Follow any tasks listed. If nothing needs attention, reply HEARTBEAT_OK." })),
  cron: z.array(z.object({
    id: z.string(),
    name: z.string().default(""),
    schedule: z.string(),
    prompt: z.string(),
    session: z.string().optional(),
    enabled: z.boolean().default(true),
  })).default([]),
});

export type Config = z.infer<typeof schema>;

// ─── Save callback: lets serve.ts update state.config immediately ────
let _onConfigSaved: ((config: Config) => void) | null = null;

/** Register a callback that fires synchronously after every saveConfig */
export function onConfigSaved(cb: (config: Config) => void): void {
  _onConfigSaved = cb;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  let fileConfig: Record<string, unknown> = {};

  if (fs.existsSync(configFile)) {
    const raw = fs.readFileSync(configFile, "utf-8");
    fileConfig = parseYaml(raw) ?? {};
  }

  // env vars override file config
  const merged = {
    ...fileConfig,
    ...(process.env.CAMELAGI_PROVIDER && { provider: process.env.CAMELAGI_PROVIDER }),
    ...(process.env.CAMELAGI_MODEL && { model: process.env.CAMELAGI_MODEL }),
    ...(process.env.ANTHROPIC_API_KEY && { apiKey: process.env.ANTHROPIC_API_KEY }),
    ...(process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY && { apiKey: process.env.OPENAI_API_KEY }),
    ...(process.env.CAMELAGI_BASE_URL && { baseUrl: process.env.CAMELAGI_BASE_URL }),
    ...overrides,
  };

  // env vars for serve/telegram sections
  const m = merged as Record<string, unknown>;
  if (process.env.CAMELAGI_TOKEN) {
    const existing = (m.serve ?? {}) as Record<string, unknown>;
    m.serve = { ...existing, token: process.env.CAMELAGI_TOKEN };
  }
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const existing = (m.telegram ?? {}) as Record<string, unknown>;
    m.telegram = { ...existing, botToken: process.env.TELEGRAM_BOT_TOKEN };
  }

  return schema.parse(merged);
}

/** Deep merge two plain objects (arrays are replaced, not merged) */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv && tv && typeof sv === "object" && typeof tv === "object" && !Array.isArray(sv) && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

export function saveConfig(values: Record<string, unknown>): void {
  fs.mkdirSync(configDir, { recursive: true });
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configFile)) {
    existing = parseYaml(fs.readFileSync(configFile, "utf-8")) ?? {};
  }
  const merged = deepMerge(existing, values);
  try {
    fs.writeFileSync(configFile, stringifyYaml(merged));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to save config to ${configFile}: ${msg}`);
  }

  // Immediately update in-memory state (don't wait for file watcher debounce)
  // Use loadConfig() so env var overrides are included (schema.parse(merged) would miss them)
  if (_onConfigSaved) {
    try {
      const fresh = loadConfig();
      _onConfigSaved(fresh);
    } catch {
      // Config reload failed — stale state will be caught on next save
    }
  }
}

export function ensureDirs(): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(path.join(configDir, "workspace"), { recursive: true });
  fs.mkdirSync(path.join(configDir, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(configDir, "skills"), { recursive: true });
  fs.mkdirSync(path.join(configDir, "usage"), { recursive: true });
  fs.mkdirSync(path.join(configDir, "cron"), { recursive: true });
  fs.mkdirSync(path.join(configDir, "logs"), { recursive: true });
}
