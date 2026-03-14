// Approval system: gate dangerous tool calls behind user confirmation
//
// Modes:
//   off    — bypass all (current default, zero friction)
//   smart  — auto-approve reads, ask for writes/exec
//   always — ask for every tool call
//
// Flow:
//   PreToolUse hook → checkApproval() → auto or ask
//   If ask: emit approval_request event → waitForDecision() → user responds → submitDecision()

import { randomUUID } from "node:crypto";
import { loadConfig, saveConfig } from "../core/config.js";

export type ApprovalMode = "off" | "smart" | "always";
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export interface ApprovalRequest {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  preview: string;
}

// Tools that "smart" mode auto-approves (read-only, no side effects)
const READ_ONLY_TOOLS = new Set([
  "Read", "Glob", "Grep",
  "WebSearch", "WebFetch",
  "memory_search", "memory_get",
]);

// --- Pending approvals ---

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

export interface ApprovalManager {
  checkApproval: (toolName: string, args: Record<string, unknown>, mode: ApprovalMode, allowlist: string[]) => ApprovalRequest | null;
  waitForDecision: (id: string, timeoutMs: number, fallback: "deny" | "allow") => Promise<ApprovalDecision>;
  submitDecision: (id: string, decision: ApprovalDecision) => boolean;
  addToAllowlist: (toolName: string, args: Record<string, unknown>) => void;
  pendingCount: () => number;
  reset: () => void;
}

// --- Allowlist matching ---

function matchesAllowlist(toolName: string, args: Record<string, unknown>, allowlist: string[]): boolean {
  for (const entry of allowlist) {
    const colonIdx = entry.indexOf(":");
    if (colonIdx === -1) {
      // Bare tool name: "Read", "Glob" — matches all calls to that tool
      if (toolName === entry) return true;
      continue;
    }
    const entryTool = entry.slice(0, colonIdx);
    const entryPattern = entry.slice(colonIdx + 1);
    if (entryTool !== toolName) continue;

    // For Bash, match against the command string
    if (toolName === "Bash") {
      const cmd = String(args.command ?? "");
      if (globMatch(entryPattern, cmd)) return true;
    }
    // For Write/Edit, match file path
    else if (toolName === "Write" || toolName === "Edit") {
      const filePath = String(args.file_path ?? "");
      if (globMatch(entryPattern, filePath)) return true;
    }
    // For apply_patch, match if the pattern is "*" (blanket allow)
    else if (toolName === "apply_patch") {
      if (entryPattern === "*") return true;
    }
  }
  return false;
}

/** Simple glob matching — supports * as wildcard */
function globMatch(pattern: string, text: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$").test(text);
}

// --- Preview builder ---

function buildPreview(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "Bash") return String(args.command ?? "").slice(0, 200);
  if (toolName === "Write") return `write → ${args.file_path ?? "?"}`;
  if (toolName === "Edit") return `edit → ${args.file_path ?? "?"}`;
  if (toolName === "Agent") return `spawn agent: ${String(args.prompt ?? "").slice(0, 100)}`;
  if (toolName === "apply_patch") return `patch (${String(args.patch ?? "").split("\n").length} lines)`;
  return `${toolName}(${JSON.stringify(args).slice(0, 120)})`;
}

// --- Factory ---

export function createApprovalManager(): ApprovalManager {
  const pending = new Map<string, PendingApproval>();

  function checkApproval(
    toolName: string,
    args: Record<string, unknown>,
    mode: ApprovalMode,
    allowlist: string[],
  ): ApprovalRequest | null {
    if (mode === "off") return null;
    if (matchesAllowlist(toolName, args, allowlist)) return null;
    if (mode === "smart" && READ_ONLY_TOOLS.has(toolName)) return null;

    return {
      id: randomUUID(),
      toolName,
      args,
      preview: buildPreview(toolName, args),
    };
  }

  function waitForDecision(
    id: string,
    timeoutMs: number,
    fallback: "deny" | "allow",
  ): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(fallback === "allow" ? "allow-once" : "deny");
      }, timeoutMs);

      pending.set(id, { resolve, timer });
    });
  }

  function submitDecision(id: string, decision: ApprovalDecision): boolean {
    const p = pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve(decision);
    return true;
  }

  function addToAllowlist(toolName: string, args: Record<string, unknown>): void {
    const config = loadConfig();
    const current = [...(config.approvals.allowlist ?? [])];

    let entry: string;
    if (toolName === "Bash") {
      const cmd = String(args.command ?? "").trim();
      const baseCmd = cmd.split(/[\s|;&]/)[0]; // first word before space/pipe/chain
      entry = baseCmd ? `Bash:${baseCmd} *` : "Bash";
    } else if (toolName === "Write" || toolName === "Edit") {
      const filePath = String(args.file_path ?? "");
      entry = filePath ? `${toolName}:${filePath}` : toolName;
    } else {
      entry = toolName;
    }

    if (!current.includes(entry)) {
      current.push(entry);
      saveConfig({
        approvals: { ...config.approvals, allowlist: current },
      });
    }
  }

  function pendingCount(): number {
    return pending.size;
  }

  function reset(): void {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
    }
    pending.clear();
  }

  return { checkApproval, waitForDecision, submitDecision, addToAllowlist, pendingCount, reset };
}

// Backward-compat singleton
const defaultManager = createApprovalManager();
export const { checkApproval, waitForDecision, submitDecision, addToAllowlist, pendingCount } = defaultManager;
