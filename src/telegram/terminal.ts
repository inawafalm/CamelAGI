// Claude Code bridge: Telegram ↔ claude CLI subprocess
//
// /cc → menu (start, stop, new, sessions)
// Messages → spawn claude -p ... → stream response back to Telegram

import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../core/config.js";
import { agentMemoryDir } from "../workspace.js";

// ─── Types ─────────────────────────────────────────────────────────────

interface TerminalSession {
  sessionId?: string;   // Claude Code session ID for --resume
  agentId?: string;     // CamelAGI agent ID for context injection
  workDir: string;      // Working directory for subprocess
  model?: string;       // --model (e.g. "sonnet", "opus")
  effort?: string;      // --effort (low, medium, high, max)
  systemPrompt?: string; // --system-prompt
  allowedTools?: string[];  // --allowedTools
  disallowedTools?: string[]; // --disallowedTools
  worktree?: boolean;   // --worktree
  maxBudgetUsd?: number; // --max-budget-usd
  permissionMode?: "skip" | "acceptEdits"; // --dangerously-skip-permissions vs --permission-mode acceptEdits
  pinnedMessageId?: number; // Telegram pinned status message
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

export function startTerminal(chatId: number, workDir: string, resumeSessionId?: string, agentId?: string): void {
  sessions.set(chatId, { workDir, busy: false, sessionId: resumeSessionId, agentId });
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

export function setPinnedMessageId(chatId: number, messageId: number | undefined): void {
  const session = sessions.get(chatId);
  if (session) session.pinnedMessageId = messageId;
}

export function getPinnedMessageId(chatId: number): number | undefined {
  return sessions.get(chatId)?.pinnedMessageId;
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

export function listClaudeSessions(workDir?: string): ClaudeSession[] {
  try {
    const claudeDir = path.join(os.homedir(), ".claude", "projects");
    if (!fs.existsSync(claudeDir)) return [];

    // Scan all project dirs, or just the one matching workDir
    let projectDirs: string[];
    if (workDir) {
      // Claude Code encodes paths: /Users/foo/Desktop → -Users-foo-Desktop
      const encoded = workDir.replace(/^\//, "").replace(/\//g, "-");
      const projectDir = path.join(claudeDir, `-${encoded}`);
      // Also try without leading dash for root paths
      const altDir = path.join(claudeDir, encoded);
      projectDirs = [projectDir, altDir].filter(d => fs.existsSync(d));
    } else {
      // Scan all project dirs
      projectDirs = fs.readdirSync(claudeDir)
        .map(d => path.join(claudeDir, d))
        .filter(d => fs.statSync(d).isDirectory());
    }

    const sessions: { id: string; name?: string; cwd?: string; updatedAt: string; mtime: number }[] = [];

    for (const dir of projectDirs) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
      for (const file of files) {
        const fullPath = path.join(dir, file);
        try {
          const stat = fs.statSync(fullPath);
          const sessionId = file.replace(".jsonl", "");
          // Read first user message line to get cwd and name
          const content = fs.readFileSync(fullPath, "utf-8");
          const firstUserLine = content.split("\n").find(l => l.includes('"type":"user"'));
          let cwd: string | undefined;
          if (firstUserLine) {
            try {
              const parsed = JSON.parse(firstUserLine);
              cwd = parsed.cwd;
            } catch {}
          }
          sessions.push({
            id: sessionId,
            cwd,
            updatedAt: new Date(stat.mtimeMs).toISOString(),
            mtime: stat.mtimeMs,
          });
        } catch { /* skip unreadable files */ }
      }
    }

    return sessions
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10)
      .map(({ mtime: _, ...rest }) => rest);
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
    ];
    if (session.permissionMode === "acceptEdits") {
      args.push("--permission-mode", "acceptEdits");
    } else {
      args.push("--dangerously-skip-permissions");
    }
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

    // ─── CamelAGI context injection (hybrid mode) ─────────────────
    if (session.agentId) {
      const agentDir = agentMemoryDir(session.agentId);

      // Inject SOUL.md, MEMORY.md, recent memory notes
      const parts: string[] = [];
      const soulPath = path.join(agentDir, "SOUL.md");
      if (fs.existsSync(soulPath)) parts.push(fs.readFileSync(soulPath, "utf-8"));

      const memoryPath = path.join(agentDir, "MEMORY.md");
      if (fs.existsSync(memoryPath)) parts.push(fs.readFileSync(memoryPath, "utf-8"));

      // Last 3 daily memory notes
      const memDir = path.join(agentDir, "memory");
      if (fs.existsSync(memDir)) {
        const notes = fs.readdirSync(memDir).filter(f => f.endsWith(".md")).sort().reverse().slice(0, 3);
        for (const note of notes) {
          parts.push(`## Memory: ${note}\n${fs.readFileSync(path.join(memDir, note), "utf-8")}`);
        }
      }

      // Skills
      const skillsDir = path.join(os.homedir(), ".camelagi", "skills");
      if (fs.existsSync(skillsDir)) {
        for (const d of fs.readdirSync(skillsDir)) {
          const skillFile = path.join(skillsDir, d, "SKILL.md");
          if (fs.existsSync(skillFile)) {
            parts.push(`## Skill: ${d}\n${fs.readFileSync(skillFile, "utf-8")}`);
          }
        }
      }

      // CamelAGI API tools — Claude Code can use these via curl
      const config = loadConfig();
      const port = config.serve?.port ?? 18305;
      const token = config.serve?.token;
      const authHeader = token ? ` -H "Authorization: Bearer ${token}"` : "";
      parts.push(`## CamelAGI Gateway API (localhost:${port})
You have access to CamelAGI's gateway API. Use curl to interact with it:

### Cron Jobs
- List: curl -s${authHeader} http://127.0.0.1:${port}/health | jq
- The full API is at http://127.0.0.1:${port}

### Sessions
- List: curl -s${authHeader} http://127.0.0.1:${port}/sessions
- Read: curl -s${authHeader} http://127.0.0.1:${port}/sessions/{id}/messages

### Agents
- List: curl -s${authHeader} http://127.0.0.1:${port}/agents

### Config
- Read: curl -s${authHeader} http://127.0.0.1:${port}/config
- Update: curl -s -X PATCH${authHeader} -H "Content-Type: application/json" http://127.0.0.1:${port}/config -d '{"key":"value"}'

### Memory
- Agent memory is at: ${agentDir}
- Read MEMORY.md and memory/*.md files directly for context
- Write to MEMORY.md to persist important facts`);

      if (parts.length > 0) {
        args.push("--append-system-prompt", parts.join("\n\n"));
      }

      // Agent workspace access
      args.push("--add-dir", agentDir);

      // MCP servers (user-configured, not built-in)
      const mcpGlobal = config.mcp?.servers ?? {};
      const mcpAgent = config.agents[session.agentId]?.mcp?.servers ?? {};
      const mcpMerged = { ...mcpGlobal, ...mcpAgent };
      if (Object.keys(mcpMerged).length > 0) {
        const tmpPath = path.join(os.tmpdir(), `camelagi-mcp-${chatId}.json`);
        fs.writeFileSync(tmpPath, JSON.stringify({ mcpServers: mcpMerged }));
        args.push("--mcp-config", tmpPath);
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
