// Token usage tracking per session

import fs from "node:fs";
import path from "node:path";
import { paths } from "./core/config.js";

// Re-export TokenUsage from types
export type { TokenUsage } from "./core/types.js";

export interface SessionUsage {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  calls: number;
  lastUpdated: number;
}

const sessionUsage = new Map<string, SessionUsage>();

function usageDir(): string {
  return path.join(paths.configDir, "usage");
}

function usageFile(sessionId: string): string {
  return path.join(usageDir(), `${encodeURIComponent(sessionId)}.json`);
}

/** Record token usage for a session */
export function recordUsage(sessionId: string, usage: import("./core/types.js").TokenUsage): void {
  const existing = getSessionUsage(sessionId);
  const updated: SessionUsage = {
    totalInput: existing.totalInput + usage.inputTokens,
    totalOutput: existing.totalOutput + usage.outputTokens,
    totalCacheRead: existing.totalCacheRead + usage.cacheReadTokens,
    totalCacheWrite: existing.totalCacheWrite + usage.cacheWriteTokens,
    calls: existing.calls + 1,
    lastUpdated: Date.now(),
  };
  sessionUsage.set(sessionId, updated);
  persistUsage(sessionId, updated);
}

/** Get accumulated usage for a session */
export function getSessionUsage(sessionId: string): SessionUsage {
  const cached = sessionUsage.get(sessionId);
  if (cached) return cached;

  const file = usageFile(sessionId);
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf-8")) as SessionUsage;
      sessionUsage.set(sessionId, data);
      return data;
    } catch { /* fall through */ }
  }

  return {
    totalInput: 0, totalOutput: 0,
    totalCacheRead: 0, totalCacheWrite: 0,
    calls: 0, lastUpdated: 0,
  };
}

/** Format token count: 1234 → "1.2k", 1234567 → "1.2m" */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Format a usage summary for display */
export function formatUsageSummary(usage: SessionUsage): string {
  const total = usage.totalInput + usage.totalOutput;
  const parts = [
    `${formatTokens(total)} total`,
    `${formatTokens(usage.totalInput)} in`,
    `${formatTokens(usage.totalOutput)} out`,
  ];
  if (usage.totalCacheRead > 0) {
    parts.push(`${formatTokens(usage.totalCacheRead)} cached`);
  }
  return parts.join(" | ");
}

function persistUsage(sessionId: string, usage: SessionUsage): void {
  try {
    const dir = usageDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(usageFile(sessionId), JSON.stringify(usage));
  } catch { /* best effort */ }
}

/** Delete usage data for a session */
export function deleteUsage(sessionId: string): void {
  sessionUsage.delete(sessionId);
  const file = usageFile(sessionId);
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

// ─── Model Pricing & Cost Estimation ─────────────────────────────────

/** Model pricing: cost per million tokens [input, output] in USD */
const MODEL_PRICING: Record<string, [number, number]> = {
  // Anthropic
  "claude-sonnet-4-20250514": [3, 15],
  "claude-opus-4-20250514": [15, 75],
  "claude-haiku-4-20250506": [0.80, 4],
  // OpenAI
  "gpt-4o": [2.50, 10],
  "gpt-4o-mini": [0.15, 0.60],
  "gpt-4.1": [2, 8],
  "gpt-4.1-mini": [0.40, 1.60],
  "gpt-4.1-nano": [0.10, 0.40],
  "o3": [2, 8],
  "o4-mini": [1.10, 4.40],
  // Google
  "gemini-2.5-pro": [1.25, 10],
  "gemini-2.5-flash": [0.15, 0.60],
  "gemini-2.0-flash": [0.10, 0.40],
  // DeepSeek
  "deepseek-r1": [0.55, 2.19],
  "deepseek-r1-0528": [0.55, 2.19],
  "deepseek-chat-v3-0324": [0.27, 1.10],
  "deepseek-chat": [0.27, 1.10],
  // xAI
  "grok-3": [3, 15],
  "grok-3-mini": [0.30, 0.50],
  // Meta
  "llama-4-maverick": [0.50, 0.77],
  "llama-4-scout": [0.18, 0.35],
  "llama-3.3-70b-instruct": [0.10, 0.25],
  // Mistral
  "mistral-large-2411": [2, 6],
  "mistral-medium-3": [0.40, 2],
  "codestral-2501": [0.30, 0.90],
};

/** Look up pricing for a model (handles provider/ prefixed names) */
function getModelPricing(model: string): [number, number] | undefined {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  const slash = model.indexOf("/");
  if (slash > 0) {
    const short = model.slice(slash + 1);
    if (MODEL_PRICING[short]) return MODEL_PRICING[short];
  }
  return undefined;
}

/** Estimate cost in USD from token counts and model */
export function estimateCost(inputTokens: number, outputTokens: number, model: string): number | undefined {
  const pricing = getModelPricing(model);
  if (!pricing) return undefined;
  const [inputRate, outputRate] = pricing;
  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}

/** Format cost as USD string */
export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export interface AgentUsageSummary {
  agentId: string;
  agentName: string;
  totalInput: number;
  totalOutput: number;
  calls: number;
  estimatedCost?: number;
  model: string;
}

/** Aggregate usage across all sessions for a given agent */
export function aggregateAgentUsage(agentId: string, agentName: string, model: string): AgentUsageSummary {
  const dir = usageDir();
  if (!fs.existsSync(dir)) {
    return { agentId, agentName, totalInput: 0, totalOutput: 0, calls: 0, model };
  }

  const prefix = agentId === "telegram" ? "telegram-" : `${agentId}-`;
  const files = fs.readdirSync(dir).filter(f => {
    const decoded = decodeURIComponent(f.replace(/\.json$/, ""));
    return decoded.startsWith(prefix);
  });

  let totalInput = 0, totalOutput = 0, calls = 0;
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as SessionUsage;
      totalInput += data.totalInput;
      totalOutput += data.totalOutput;
      calls += data.calls;
    } catch { /* skip corrupt files */ }
  }

  const estimatedCost = estimateCost(totalInput, totalOutput, model);
  return { agentId, agentName, totalInput, totalOutput, calls, estimatedCost, model };
}

/** Aggregate total tokens across all sessions updated today */
export function aggregateTodayTokens(): number {
  const dir = usageDir();
  if (!fs.existsSync(dir)) return 0;

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const cutoff = dayStart.getTime();

  let tokens = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as SessionUsage;
      if (data.lastUpdated >= cutoff) {
        tokens += data.totalInput + data.totalOutput;
      }
    } catch { /* skip */ }
  }
  return tokens;
}
