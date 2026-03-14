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
