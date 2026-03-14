// Context compaction: summarize old messages when context gets too large

import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "../core/types.js";
import { chatDirect } from "../model.js";
import fs from "node:fs";
import path from "node:path";
import { agentMemoryDir } from "../workspace.js";
import { CHARS_PER_TOKEN, COMPACTION_TRIGGER_RATIO, MEMORY_FLUSH_MAX_CHARS } from "../core/constants.js";

export interface CompactionOpts {
  maxTokens: number;
  keepTurns: number;
  enabled: boolean;
  agentId?: string;
}

function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += msg.content.length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function splitHistory(
  messages: Message[],
  keepTurns: number,
): { old: Message[]; recent: Message[] } {
  if (keepTurns <= 0) return { old: messages, recent: [] };

  const turnStarts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      turnStarts.push(i);
    }
  }

  if (turnStarts.length <= keepTurns) {
    return { old: [], recent: messages };
  }

  const cutoff = turnStarts[turnStarts.length - keepTurns];
  return {
    old: messages.slice(0, cutoff),
    recent: messages.slice(cutoff),
  };
}

const COMPACT_PROMPT = `Summarize the following conversation history concisely. Preserve:
- Key facts, decisions, and context established
- Important file paths, names, and technical details mentioned
- Current state of any ongoing tasks
- User preferences or instructions given

Be concise but don't lose critical context. Output only the summary, no preamble.`;

export async function compactHistory(
  client: Anthropic,
  model: string,
  history: Message[],
  opts: CompactionOpts,
): Promise<Message[] | null> {
  if (!opts.enabled) return null;

  const tokens = estimateTokens(history);
  if (tokens < opts.maxTokens * COMPACTION_TRIGGER_RATIO) return null;

  const { old, recent } = splitHistory(history, opts.keepTurns);
  if (old.length === 0) return null;

  await memoryFlush(client, model, old, opts.agentId);

  const oldText = old.map((m) => {
    return `[${m.role}]: ${m.content}`;
  }).join("\n\n");

  const summaryResult = await chatDirect(client, model, COMPACT_PROMPT, oldText);

  const summaryMessage: Message = {
    role: "user",
    content: `[Previous conversation summary]\n${summaryResult.content}\n[End of summary — conversation continues below]`,
  };

  const compacted = [summaryMessage, ...recent];

  // Validate: compaction must actually reduce size
  const compactedTokens = estimateTokens(compacted);
  if (compactedTokens >= tokens) {
    process.stderr.write(`\x1b[33m⚠ Compaction skipped: result (${compactedTokens} tokens) >= original (${tokens} tokens)\x1b[0m\n`);
    return null;
  }

  return compacted;
}

// --- Memory flush ---

const FLUSH_PROMPT = `You are about to lose the following conversation history due to context compaction.
Extract any durable facts worth remembering: decisions made, user preferences discovered,
project details, file paths, names, dates, or anything the user would expect you to know later.

Format as concise bullet points. If nothing is worth saving, reply with "NOTHING".`;

async function memoryFlush(client: Anthropic, model: string, oldMessages: Message[], agentId?: string): Promise<void> {
  if (oldMessages.length === 0) return;

  try {
    const oldText = oldMessages.map((m) => {
      return `[${m.role}]: ${m.content}`;
    }).join("\n\n");

    if (oldText.length < 200) return;

    const response = await chatDirect(client, model, FLUSH_PROMPT, oldText.slice(0, MEMORY_FLUSH_MAX_CHARS));

    const extracted = response.content;

    if (extracted.trim() === "NOTHING" || extracted.trim().length < 10) return;

    const rootDir = agentMemoryDir(agentId);
    const memoryDir = path.join(rootDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });

    const today = new Date().toISOString().split("T")[0];
    const dailyFile = path.join(memoryDir, `${today}.md`);

    const header = fs.existsSync(dailyFile) ? "" : `# ${today}\n\n`;
    const timestamp = new Date().toTimeString().split(" ")[0];
    const entry = `${header}## ${timestamp} (auto-flush)\n\n${extracted}\n\n`;

    fs.appendFileSync(dailyFile, entry);
  } catch {
    // Memory flush is best-effort
  }
}
