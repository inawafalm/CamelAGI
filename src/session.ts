// Simple JSONL session persistence

import fs from "node:fs";
import path from "node:path";
import { paths } from "./core/config.js";
import { deleteUsage } from "./usage.js";
import type { Message } from "./core/types.js";

export interface SessionMeta {
  id: string;
  createdAt: number;
  model: string;
  label?: string;
}

interface SerializedMessage {
  type: "human" | "ai" | "system" | "tool" | "user" | "assistant";
  content: string;
}

function sessionPath(id: string): string {
  return path.join(paths.sessionsDir, `${encodeURIComponent(id)}.jsonl`);
}

export function listSessions(): SessionMeta[] {
  if (!fs.existsSync(paths.sessionsDir)) return [];
  return fs
    .readdirSync(paths.sessionsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const raw = fs.readFileSync(path.join(paths.sessionsDir, f), "utf-8");
      const firstLine = raw.split("\n")[0];
      try {
        return JSON.parse(firstLine) as SessionMeta;
      } catch {
        return null;
      }
    })
    .filter((m): m is SessionMeta => m !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

// Map old LangChain type names to new roles for backward compat
function typeToRole(type: string): Message["role"] {
  switch (type) {
    case "human":
    case "user":
      return "user";
    case "ai":
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
      return "tool";
    default:
      return "user";
  }
}

export function loadMessages(sessionId: string): Message[] {
  const file = sessionPath(sessionId);
  if (!fs.existsSync(file)) return [];

  const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  return lines.slice(1).map((line) => {
    const msg = JSON.parse(line) as SerializedMessage;
    return { role: typeToRole(msg.type), content: msg.content };
  });
}

export function saveMessage(sessionId: string, message: Message, model: string, label?: string): void {
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const file = sessionPath(sessionId);

  if (!fs.existsSync(file)) {
    const meta: SessionMeta = { id: sessionId, createdAt: Date.now(), model, ...(label && { label }) };
    fs.writeFileSync(file, JSON.stringify(meta) + "\n");
  }

  // Save with new role names
  const serialized: SerializedMessage = {
    type: message.role as SerializedMessage["type"],
    content: message.content,
  };
  fs.appendFileSync(file, JSON.stringify(serialized) + "\n");
}

export function deleteSession(sessionId: string): void {
  const file = sessionPath(sessionId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  deleteUsage(sessionId);
}
