// System prompt builder — assembles the full system prompt from bootstrap files, skills, and runtime context

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadSkills, formatSkillsForPrompt } from "./extensions/skills.js";
import { CHARS_PER_TOKEN, MAX_BOOTSTRAP_FILE_CHARS, MAX_BOOTSTRAP_TOTAL_CHARS } from "./core/constants.js";
import { loadBootstrapFiles, filterBootstrapFiles, agentMemoryDir, workspacePaths, truncateFile, type SessionType } from "./workspace.js";

const { workspaceDir } = workspacePaths;

export function buildSystemPrompt(basePrompt: string, skillsConfig?: { enabled: boolean; deny: string[] }, agentId?: string, sessionType?: SessionType): string {
  const allFiles = loadBootstrapFiles(agentId);
  const files = filterBootstrapFiles(allFiles, sessionType);
  const memRoot = agentMemoryDir(agentId);
  const isMinimalSession = sessionType === "cron" || sessionType === "subagent";
  const sections: string[] = [];

  // Base identity
  sections.push(basePrompt);

  // Safety section
  sections.push(`
## Safety
- Do not attempt to gain unauthorized access to systems or data
- Do not bypass safety controls or oversight mechanisms
- Ask for confirmation before destructive operations (deleting files, dropping data)
- Respect file permissions and user boundaries`);

  // Tooling section
  sections.push(`
## Available Tools
- **exec**: Run shell commands (bash, 30s timeout)
- **read**: Read file contents with line numbers
- **write**: Create or overwrite files
- **edit**: Make targeted string replacements in files
- **apply_patch**: Apply multi-file patches (add, update, delete files in one call)
- **fetch**: HTTP requests (GET, POST, PUT, DELETE)
- **web_search**: Search the web for information (returns titles, URLs, snippets)
- **memory_search**: Search past decisions, facts, and notes across MEMORY.md and memory/*.md
- **memory_get**: Read a specific memory file by path
- **subagent**: Spawn a child agent for subtasks in an isolated session
- **subagent_list**: List all spawned subagents and their status`);

  // Current Date & Time
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  sections.push(`
## Current Date & Time
- date: ${now.toISOString().split("T")[0]}
- time: ${now.toTimeString().split(" ")[0]}
- timezone: ${tz}`);

  // Runtime metadata
  sections.push(`
## Runtime
- host: ${os.hostname()}
- os: ${os.platform()} ${os.arch()}
- node: ${process.version}
- cwd: ${process.cwd()}
- workspace: ${workspaceDir}`);

  // Inject bootstrap files
  let totalChars = 0;
  const validFiles = files.filter((f) => !f.missing && f.content);
  let anyTruncated = false;

  if (validFiles.length > 0) {
    sections.push("\n# Project Context\n");
    sections.push("The following workspace files have been loaded:");

    const hasSoul = validFiles.some((f) => f.name === "SOUL.md");
    if (hasSoul) {
      sections.push(
        "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies.",
      );
    }

    for (const file of validFiles) {
      const budget = Math.min(MAX_BOOTSTRAP_FILE_CHARS, MAX_BOOTSTRAP_TOTAL_CHARS - totalChars);
      if (budget < 64) break;

      const { text, truncated } = truncateFile(file.content, budget);
      file.injectedChars = text.length;
      file.truncated = truncated;
      if (truncated) anyTruncated = true;
      totalChars += text.length;
      sections.push(`\n## ${file.name}\n\n${text}`);
    }

    if (anyTruncated) {
      sections.push(
        "\n> Note: Some workspace files were truncated. Use the read tool to access full contents.",
      );
    }
  }

  // Memory note — scoped to agent dir when applicable (skip for cron/subagent)
  if (!isMinimalSession) {
    const memoryNoteDir = path.join(memRoot, "memory");
    if (fs.existsSync(memoryNoteDir)) {
      const dailyFiles = fs.readdirSync(memoryNoteDir).filter((f) => f.endsWith(".md"));
      const memLines = [];
      if (dailyFiles.length > 0) {
        memLines.push(`${dailyFiles.length} daily memory file(s) available. Use memory_search to find past context.`);
      }
      if (agentId) {
        memLines.push(`Memory directory: ${memRoot}`);
        memLines.push(`Write MEMORY.md and memory/*.md files here to persist notes across sessions.`);
      }
      if (memLines.length > 0) {
        sections.push(`\n## Memory\n${memLines.join("\n")}`);
      }
    } else if (agentId) {
      sections.push(`\n## Memory\nMemory directory: ${memRoot}\nWrite MEMORY.md and memory/*.md files here to persist notes across sessions.`);
    }
  }

  // Inject skills (optional — skip for cron/subagent sessions)
  if (skillsConfig?.enabled !== false && !isMinimalSession) {
    try {
      let skills = loadSkills();
      const denySet = new Set(skillsConfig?.deny ?? []);
      if (denySet.size > 0) {
        skills = skills.filter((s) => !denySet.has(s.name));
      }
      if (skills.length > 0) {
        const skillsPrompt = formatSkillsForPrompt(skills);
        if (skillsPrompt) {
          sections.push("\n" + skillsPrompt);
        }
      }
    } catch {
      // Skills are optional — continue without them
    }
  }

  return sections.join("\n");
}

// --- Context inspection ---

export interface ContextReport {
  workspace: string;
  bootstrapMaxPerFile: number;
  bootstrapMaxTotal: number;
  systemPromptChars: number;
  systemPromptTokens: number;
  files: {
    name: string;
    status: "OK" | "TRUNCATED" | "MISSING";
    rawChars: number;
    rawTokens: number;
    injectedChars: number;
    injectedTokens: number;
  }[];
  skillCount: number;
  toolCount: number;
}

export function getContextReport(systemPrompt: string): ContextReport {
  const files = loadBootstrapFiles();
  const skills = loadSkills();

  let totalChars = 0;
  const fileReports = files.map((f) => {
    if (f.missing) {
      return {
        name: f.name,
        status: "MISSING" as const,
        rawChars: 0,
        rawTokens: 0,
        injectedChars: 0,
        injectedTokens: 0,
      };
    }

    const budget = Math.min(MAX_BOOTSTRAP_FILE_CHARS, MAX_BOOTSTRAP_TOTAL_CHARS - totalChars);
    const { text, truncated } = truncateFile(f.content, budget);
    totalChars += text.length;

    return {
      name: f.name,
      status: truncated ? ("TRUNCATED" as const) : ("OK" as const),
      rawChars: f.rawChars,
      rawTokens: Math.ceil(f.rawChars / CHARS_PER_TOKEN),
      injectedChars: text.length,
      injectedTokens: Math.ceil(text.length / CHARS_PER_TOKEN),
    };
  });

  return {
    workspace: workspaceDir,
    bootstrapMaxPerFile: MAX_BOOTSTRAP_FILE_CHARS,
    bootstrapMaxTotal: MAX_BOOTSTRAP_TOTAL_CHARS,
    systemPromptChars: systemPrompt.length,
    systemPromptTokens: Math.ceil(systemPrompt.length / CHARS_PER_TOKEN),
    files: fileReports,
    skillCount: skills.length,
    toolCount: 11,
  };
}
