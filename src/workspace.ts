// Workspace: bootstrap files, templates, and file operations

import fs from "node:fs";
import path from "node:path";
import { paths } from "./core/config.js";
import { MAX_BOOTSTRAP_FILE_CHARS, MAX_BOOTSTRAP_TOTAL_CHARS } from "./core/constants.js";

const workspaceDir = path.join(paths.configDir, "workspace");
const agentsDir = path.join(paths.configDir, "agents");

export const workspacePaths = { workspaceDir };

/** Get the memory root for an agent (or global workspace if no agentId) */
export function agentMemoryDir(agentId?: string): string {
  if (!agentId) return workspaceDir;
  return path.join(agentsDir, agentId);
}

/** Ensure an agent's directories exist */
export function ensureAgentDirs(agentId: string): void {
  const dir = agentMemoryDir(agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
}

/** Seed an agent's workspace with bootstrap files */
export function seedAgentWorkspace(agentId: string, name: string, description?: string): void {
  ensureAgentDirs(agentId);
  const dir = agentMemoryDir(agentId);

  // SOUL.md — the agent's identity
  const soulPath = path.join(dir, "SOUL.md");
  if (!fs.existsSync(soulPath)) {
    const desc = description ? `\n${description}\n` : "";
    fs.writeFileSync(soulPath, `# ${name}
${desc}
_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" and "I'd be happy to help!" — just help. Actions speak louder than filler words.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring. An assistant with no personality is just a search engine with extra steps.

**Be resourceful before asking.** Try to figure it out. Read the file. Check the context. Search for it. _Then_ ask if you're stuck. The goal is to come back with answers, not questions.

**Earn trust through competence.** Your human gave you access to their stuff. Don't make them regret it. Be careful with external actions (emails, tweets, anything public). Be bold with internal ones (reading, organizing, learning).

**Remember you're a guest.** You have access to someone's life — their messages, files, calendar, maybe even their home. That's intimacy. Treat it with respect.

## Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies to messaging surfaces.
- You're not the user's voice — be careful in group chats.

## Vibe

Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just... good.

## Continuity

Each session, you wake up fresh. These files _are_ your memory. Read them. Update them. They're how you persist.

If you change this file, tell the user — it's your soul, and they should know.

---

_This file is yours to evolve. As you learn who you are, update it._
`);
  }

  // TOOLS.md — agent-specific setup notes
  const toolsPath = path.join(dir, "TOOLS.md");
  if (!fs.existsSync(toolsPath)) {
    fs.writeFileSync(toolsPath, `# ${name} — Tool Notes

<!-- Agent-specific setup notes go here -->
<!-- Examples: -->
<!-- - Preferred languages, frameworks -->
<!-- - Project paths, SSH hosts -->
<!-- - Any environment-specific context -->
`);
  }

  // MEMORY.md — starts empty
  const memoryPath = path.join(dir, "MEMORY.md");
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, `# ${name} Memory

<!-- Curated long-term memory. The agent reads and updates this file. -->
`);
  }
}

// Bootstrap file definitions (injected into system prompt)
const BOOTSTRAP_FILES = [
  { name: "AGENTS.md", required: true },
  { name: "SOUL.md", required: false },
  { name: "IDENTITY.md", required: false },
  { name: "USER.md", required: false },
  { name: "TOOLS.md", required: false },
  { name: "MEMORY.md", required: false },
] as const;

const HEAD_RATIO = 0.7;
const TAIL_RATIO = 0.2;

// --- Default templates ---

const TEMPLATES: Record<string, string> = {
  "AGENTS.md": `# Agent Instructions

You are CamelAGI, a personal AI assistant.

## Guidelines
- Be direct and helpful
- Use tools when needed to accomplish tasks
- Read files before modifying them
- Prefer small, targeted changes over large rewrites
- Use \`apply_patch\` for multi-file changes or when you know the exact diff
- If unsure, ask for clarification

## Session Memory
- Each conversation is a session with persistent history
- Reference previous messages in the session when relevant
- Use \`memory_search\` to find past decisions and context
- Use the workspace directory for any files you create

## Memory Workflow
- Use \`memory_search\` before answering questions about prior work
- Store durable facts in MEMORY.md (curated, long-term)
- Store daily notes in memory/YYYY-MM-DD.md (append-only)
- When writing to daily files that already exist, APPEND only
`,

  "SOUL.md": `# Soul

## Personality
- Genuine, direct, and resourceful
- Have opinions when asked — don't hedge everything
- Be concise but thorough when it matters
- Adapt tone to context (casual chat vs technical work)

## Boundaries
- Respect user privacy
- Be honest about limitations
- Don't pretend to know things you don't
`,

  "IDENTITY.md": `# Identity

<!-- Agent's name, vibe, and emoji -->
<!-- name: CamelAGI -->
<!-- emoji: 🐪 -->
`,

  "USER.md": `# User Profile

<!-- Fill this in to help the agent know you better -->
<!-- name: -->
<!-- timezone: -->
<!-- projects: -->
<!-- preferences: -->
`,

  "TOOLS.md": `# Tool Notes

<!-- Add environment-specific notes for the agent here -->
<!-- Examples: -->
<!-- - SSH hosts: myserver (192.168.1.10) -->
<!-- - Project conventions: use pnpm, not npm -->
<!-- - Preferred languages: TypeScript, Python -->
`,
};

// --- File operations ---

export function ensureWorkspace(): void {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
}

export function seedWorkspace(): void {
  ensureWorkspace();
  for (const [name, content] of Object.entries(TEMPLATES)) {
    const filePath = path.join(workspaceDir, name);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content);
    }
  }

  // Seed example skill template
  const exampleSkillDir = path.join(paths.configDir, "skills", "_example");
  const exampleSkillFile = path.join(exampleSkillDir, "SKILL.md");
  if (!fs.existsSync(exampleSkillFile)) {
    fs.mkdirSync(exampleSkillDir, { recursive: true });
    fs.writeFileSync(exampleSkillFile, EXAMPLE_SKILL_TEMPLATE);
  }
}

const EXAMPLE_SKILL_TEMPLATE = `---
name: example-skill
description: Example skill template. Rename this directory and edit SKILL.md.
---

# Example Skill

Instructions here. Keep concise — every token competes with conversation context.
`;

export interface BootstrapFile {
  name: string;
  path: string;
  content: string;
  rawChars: number;
  injectedChars: number;
  missing: boolean;
  truncated: boolean;
}

export function truncateFile(content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) return { text: content, truncated: false };
  const headChars = Math.floor(maxChars * HEAD_RATIO);
  const tailChars = Math.floor(maxChars * TAIL_RATIO);
  const head = content.slice(0, headChars);
  const tail = content.slice(-tailChars);
  return {
    text: `${head}\n\n[...truncated, read file for full content...]\n\n${tail}`,
    truncated: true,
  };
}

/**
 * Load bootstrap files. For agents, checks agent dir first then falls back to global.
 * USER.md always comes from global (same user across agents).
 */
export function loadBootstrapFiles(agentId?: string): BootstrapFile[] {
  const files: BootstrapFile[] = [];
  const agentDir = agentId ? agentMemoryDir(agentId) : null;

  for (const def of BOOTSTRAP_FILES) {
    // Determine where to load from: agent dir first (except USER.md), then global
    let filePath: string | null = null;

    if (agentDir && def.name !== "USER.md") {
      const agentPath = path.join(agentDir, def.name);
      if (fs.existsSync(agentPath)) {
        filePath = agentPath;
      }
    }

    // Fall back to global workspace
    if (!filePath) {
      filePath = path.join(workspaceDir, def.name);
    }

    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8").trim();
      if (raw) {
        files.push({
          name: def.name,
          path: filePath,
          content: raw,
          rawChars: raw.length,
          injectedChars: 0,
          missing: false,
          truncated: false,
        });
      } else {
        files.push({ name: def.name, path: filePath, content: "", rawChars: 0, injectedChars: 0, missing: true, truncated: false });
      }
    } else {
      files.push({ name: def.name, path: filePath, content: "", rawChars: 0, injectedChars: 0, missing: true, truncated: false });
    }
  }

  return files;
}
