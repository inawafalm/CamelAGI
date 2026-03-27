// Claude Code bridge: Telegram ↔ claude CLI subprocess
//
// /cc → menu (start, stop, new, sessions)
// Messages → spawn claude -p ... → stream response back to Telegram

import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import os from "node:os";

// ─── Types ─────────────────────────────────────────────────────────────

interface TerminalSession {
  sessionId?: string;   // Claude Code session ID for --resume
  workDir: string;      // Working directory for subprocess
  model?: string;       // --model (e.g. "sonnet", "opus")
  effort?: string;      // --effort (low, medium, high, max)
  systemPrompt?: string; // --system-prompt
  allowedTools?: string[];  // --allowedTools
  disallowedTools?: string[]; // --disallowedTools
  worktree?: boolean;   // --worktree
  maxBudgetUsd?: number; // --max-budget-usd
  addDirs?: string[];   // --add-dir
  busy: boolean;        // True while a claude process is running
}

export interface TerminalEvent {
  type: "text_delta" | "thinking_start" | "thinking_end" | "tool_use" | "result" | "error";
  text?: string;
  toolName?: string;
  sessionId?: string;
}

// ─── State ─────────────────────────────────────────────────────────────

const sessions = new Map<number, TerminalSession>();

// ─── Detection ─────────────────────────────────────────────────────────

export function detectClaudeCode(): { found: boolean; path?: string; version?: string } {
  try {
    const p = execSync("which claude", { stdio: "pipe", encoding: "utf-8" }).trim();
    const v = execSync("claude --version", { stdio: "pipe", encoding: "utf-8" }).trim();
    return { found: true, path: p, version: v };
  } catch {
    return { found: false };
  }
}

// ─── Session lifecycle ─────────────────────────────────────────────────

export function startTerminal(chatId: number, workDir: string, resumeSessionId?: string): void {
  sessions.set(chatId, { workDir, busy: false, sessionId: resumeSessionId });
}

export function endTerminal(chatId: number): void {
  sessions.delete(chatId);
}

export function hasTerminal(chatId: number): boolean {
  return sessions.has(chatId);
}

export function isTerminalBusy(chatId: number): boolean {
  return sessions.get(chatId)?.busy ?? false;
}

export function getTerminalSessionId(chatId: number): string | undefined {
  return sessions.get(chatId)?.sessionId;
}

export function getTerminalWorkDir(chatId: number): string | undefined {
  return sessions.get(chatId)?.workDir;
}

// ─── Helpers ───────────────────────────────────────────────────────────

export function getTerminalModel(chatId: number): string | undefined {
  return sessions.get(chatId)?.model;
}

export function setTerminalModel(chatId: number, model: string | undefined): void {
  const session = sessions.get(chatId);
  if (session) session.model = model;
}

export function getTerminalSetting<K extends keyof TerminalSession>(chatId: number, key: K): TerminalSession[K] | undefined {
  return sessions.get(chatId)?.[key];
}

export function setTerminalSetting<K extends keyof TerminalSession>(chatId: number, key: K, value: TerminalSession[K]): void {
  const session = sessions.get(chatId);
  if (session) (session as any)[key] = value;
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace("~", os.homedir()) : p;
}

export function updateWorkDir(chatId: number, workDir: string): void {
  const session = sessions.get(chatId);
  if (session) {
    session.workDir = expandHome(workDir);
    session.sessionId = undefined;
  }
}

// ─── List Claude Code sessions ─────────────────────────────────────────

export interface ClaudeSession {
  id: string;
  name?: string;
  cwd?: string;
  updatedAt?: string;
}

export function listClaudeSessions(): ClaudeSession[] {
  try {
    const output = execSync("claude sessions list --output-format json", {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 10_000,
    });
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return parsed.slice(0, 10).map((s: any) => ({
        id: s.id ?? s.session_id ?? "",
        name: s.name ?? s.display_name ?? undefined,
        cwd: s.cwd ?? s.working_directory ?? undefined,
        updatedAt: s.updated_at ?? s.updatedAt ?? undefined,
      }));
    }
    return [];
  } catch {
    return [];
  }
}

// ─── Core handler ──────────────────────────────────────────────────────

export async function handleTerminalMessage(
  chatId: number,
  text: string,
  onEvent: (event: TerminalEvent) => void,
): Promise<{ response: string; sessionId?: string }> {
  const session = sessions.get(chatId);
  if (!session) throw new Error("No terminal session");

  session.busy = true;

  try {
    const args = [
      "-p", text,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
    ];
    if (session.sessionId) {
      args.push("-r", session.sessionId);
    }
    if (session.model) {
      args.push("--model", session.model);
    }
    if (session.effort) {
      args.push("--effort", session.effort);
    }
    if (session.systemPrompt) {
      args.push("--system-prompt", session.systemPrompt);
    }
    if (session.allowedTools?.length) {
      args.push("--allowedTools", ...session.allowedTools);
    }
    if (session.disallowedTools?.length) {
      args.push("--disallowedTools", ...session.disallowedTools);
    }
    if (session.worktree) {
      args.push("--worktree");
    }
    if (session.maxBudgetUsd) {
      args.push("--max-budget-usd", String(session.maxBudgetUsd));
    }
    if (session.addDirs?.length) {
      for (const dir of session.addDirs) {
        args.push("--add-dir", expandHome(dir));
      }
    }

    const child = spawn("claude", args, {
      cwd: session.workDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let result = "";
    let resultSessionId: string | undefined;

    const rl = createInterface({ input: child.stdout! });

    for await (const line of rl) {
      if (!line.trim()) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const type = parsed.type;

      if (type === "system" && parsed.subtype === "init" && parsed.session_id) {
        resultSessionId = parsed.session_id;
      } else if (type === "stream_event") {
        const event = parsed.event;
        if (!event) continue;

        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          onEvent({ type: "text_delta", text: event.delta.text });
        } else if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
          onEvent({ type: "thinking_start" });
        } else if (event.type === "content_block_stop") {
          onEvent({ type: "thinking_end" });
        } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          onEvent({ type: "tool_use", toolName: event.content_block.name });
        }
      } else if (type === "result") {
        result = parsed.result ?? "";
        resultSessionId = parsed.session_id ?? resultSessionId;
        onEvent({ type: "result", text: result, sessionId: resultSessionId });
      }
    }

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code !== 0 && !result) {
          reject(new Error(`claude exited with code ${code}`));
        } else {
          resolve();
        }
      });
      child.on("error", reject);
    });

    if (resultSessionId) {
      session.sessionId = resultSessionId;
    }

    return { response: result, sessionId: resultSessionId };
  } finally {
    session.busy = false;
  }
}
