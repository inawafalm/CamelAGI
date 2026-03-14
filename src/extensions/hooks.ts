// Lifecycle hooks: shell scripts or JS handlers from ~/.camelagi/hooks/

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { paths } from "../core/config.js";
import { HOOK_TIMEOUT_MS, MAX_STDERR_CHARS } from "../core/constants.js";

export type HookPoint =
  | "before_prompt"
  | "after_response"
  | "before_tool"
  | "after_tool";

export interface HookContext {
  sessionId?: string;
  message?: string;
  response?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
}

interface HookEntry {
  name: string;
  point: HookPoint;
  script: string;
}

const hooksDir = path.join(paths.configDir, "hooks");

/**
 * Load all hook scripts from ~/.camelagi/hooks/
 * Naming convention: {point}.{name}.sh or {point}.{name}.js
 * Examples: before_tool.log.sh, after_response.notify.sh
 */
export function loadHooks(): HookEntry[] {
  if (!fs.existsSync(hooksDir)) return [];

  const entries: HookEntry[] = [];
  const files = fs.readdirSync(hooksDir);

  for (const file of files) {
    if (!file.endsWith(".sh") && !file.endsWith(".js")) continue;

    const parts = file.split(".");
    if (parts.length < 3) continue;

    const point = parts[0] as HookPoint;
    if (!["before_prompt", "after_response", "before_tool", "after_tool"].includes(point)) continue;

    const name = parts.slice(1, -1).join(".");
    entries.push({
      name,
      point,
      script: path.join(hooksDir, file),
    });
  }

  return entries;
}

/**
 * Run all hooks for a given point.
 * Context is passed via environment variables (CAMELAGI_HOOK_*).
 */
export async function runHooks(
  point: HookPoint,
  context: HookContext,
  hooks?: HookEntry[],
): Promise<void> {
  const all = hooks ?? loadHooks();
  const matching = all.filter((h) => h.point === point);
  if (matching.length === 0) return;

  const env: Record<string, string> = {
    ...process.env,
    CAMELAGI_HOOK_POINT: point,
    ...(context.sessionId && { CAMELAGI_HOOK_SESSION: context.sessionId }),
    ...(context.message && { CAMELAGI_HOOK_MESSAGE: context.message }),
    ...(context.response && { CAMELAGI_HOOK_RESPONSE: context.response.slice(0, MAX_STDERR_CHARS) }),
    ...(context.toolName && { CAMELAGI_HOOK_TOOL: context.toolName }),
    ...(context.toolArgs && { CAMELAGI_HOOK_TOOL_ARGS: JSON.stringify(context.toolArgs) }),
    ...(context.toolResult && { CAMELAGI_HOOK_TOOL_RESULT: context.toolResult.slice(0, MAX_STDERR_CHARS) }),
  };

  for (const hook of matching) {
    try {
      execSync(hook.script, {
        env,
        timeout: HOOK_TIMEOUT_MS,
        stdio: "pipe",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Hook ${hook.name} failed: ${msg}\n`);
    }
  }
}

export function ensureHooksDir(): void {
  fs.mkdirSync(hooksDir, { recursive: true });
}
