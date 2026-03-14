// Memory tools: search and read memory files
// Supports scoped memory per agent

import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { workspacePaths } from "../workspace.js";
import type { ToolDef } from "../core/types.js";

function discoverMemoryFiles(rootDir: string): { filePath: string; name: string }[] {
  const files: { filePath: string; name: string }[] = [];

  const memoryMd = path.join(rootDir, "MEMORY.md");
  if (fs.existsSync(memoryMd)) {
    files.push({ filePath: memoryMd, name: "MEMORY.md" });
  }

  const memoryDir = path.join(rootDir, "memory");
  if (fs.existsSync(memoryDir) && fs.statSync(memoryDir).isDirectory()) {
    const entries = fs.readdirSync(memoryDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const filePath = path.join(memoryDir, entry);
      if (fs.statSync(filePath).isFile()) {
        files.push({ filePath, name: `memory/${entry}` });
      }
    }
  }

  return files;
}

/** Compute a recency multiplier based on file name date */
function recencyMultiplier(fileName: string): number {
  if (fileName === "MEMORY.md") return 1.0; // curated, always relevant
  const match = fileName.match(/(\d{4}-\d{2}-\d{2})/);
  if (!match) return 1.0;
  const fileDate = new Date(match[1] + "T00:00:00");
  const now = new Date();
  const daysAgo = Math.floor((now.getTime() - fileDate.getTime()) / (1000 * 60 * 60 * 24));
  if (daysAgo <= 0) return 1.5;  // today
  if (daysAgo === 1) return 1.3; // yesterday
  if (daysAgo <= 7) return 1.1;  // this week
  return 1.0;                    // older
}

/** Get stats about the memory directory */
function memoryStats(rootDir: string): { fileCount: number; totalBytes: number } {
  const files = discoverMemoryFiles(rootDir);
  let totalBytes = 0;
  for (const { filePath } of files) {
    try { totalBytes += fs.statSync(filePath).size; } catch {}
  }
  return { fileCount: files.length, totalBytes };
}

function searchMemory(rootDir: string, query: string, maxResults: number): {
  file: string;
  snippet: string;
  score: number;
}[] {
  const files = discoverMemoryFiles(rootDir);
  if (files.length === 0) return [];

  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results: { file: string; snippet: string; score: number }[] = [];

  for (const { filePath, name } of files) {
    const content = fs.readFileSync(filePath, "utf-8");
    const paragraphs = content.split(/\n{2,}|\n(?=#)/).filter((p) => p.trim());
    const boost = recencyMultiplier(name);

    for (const para of paragraphs) {
      const lower = para.toLowerCase();
      let rawScore = 0;
      for (const kw of keywords) {
        const count = lower.split(kw).length - 1;
        rawScore += count;
      }
      if (rawScore > 0) {
        results.push({
          file: name,
          snippet: para.trim().slice(0, 500),
          score: rawScore * boost,
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

/** Create memory tools scoped to a specific root directory */
export function createScopedMemoryTools(rootDir: string): { search: ToolDef; get: ToolDef } {
  const search: ToolDef = {
    name: "memory_search",
    description:
      "Search across MEMORY.md and memory/*.md files for past decisions, facts, preferences, and notes. Use before answering questions about prior work or context.",
    schema: z.object({
      query: z.string().describe("Search query (keywords or phrase)"),
      maxResults: z
        .number()
        .nullable()
        .optional()
        .describe("Maximum results to return (default: 6)"),
    }),
    execute: async (args) => {
      const { query, maxResults } = args as { query: string; maxResults?: number | null };
      const results = searchMemory(rootDir, query, maxResults ?? 6);
      const stats = memoryStats(rootDir);

      if (results.length === 0) {
        if (stats.fileCount === 0) {
          return "No memory files found. The memory directory is empty.";
        }
        const kb = (stats.totalBytes / 1024).toFixed(1);
        return `No memory matches found. Searched ${stats.fileCount} file(s) (${kb} KB total). Try different keywords.`;
      }

      const formatScore = (s: number) => Number.isInteger(s) ? String(s) : s.toFixed(1);
      const body = results
        .map((r, i) => `[${i + 1}] ${r.file} (score: ${formatScore(r.score)})\n${r.snippet}`)
        .join("\n\n---\n\n");

      return `${body}\n\nSearched ${stats.fileCount} file(s).`;
    },
  };

  const get: ToolDef = {
    name: "memory_get",
    description:
      "Read a specific memory file (MEMORY.md or memory/*.md). Use after memory_search to read full context of a match.",
    schema: z.object({
      filePath: z
        .string()
        .describe('Relative path within workspace (e.g., "MEMORY.md", "memory/2026-03-09.md")'),
      from: z
        .number()
        .nullable()
        .optional()
        .describe("Starting line number (1-indexed, default: 1)"),
      lines: z
        .number()
        .nullable()
        .optional()
        .describe("Number of lines to read (default: all)"),
    }),
    execute: async (args) => {
      const { filePath: relativePath, from, lines } = args as {
        filePath: string;
        from?: number | null;
        lines?: number | null;
      };

      const isMemoryPath =
        relativePath === "MEMORY.md" ||
        relativePath === "memory.md" ||
        relativePath.startsWith("memory/");

      if (!isMemoryPath) {
        return "Error: Can only read MEMORY.md or files under memory/. Use the read tool for other files.";
      }

      const fullPath = path.resolve(rootDir, relativePath);

      if (!fullPath.startsWith(path.resolve(rootDir))) {
        return "Error: Path traversal detected.";
      }

      if (!fs.existsSync(fullPath)) {
        return `File not found: ${relativePath}. It may not exist yet.`;
      }

      const content = fs.readFileSync(fullPath, "utf-8");
      const allLines = content.split("\n");

      const startLine = (from ?? 1) - 1;
      const count = lines ?? allLines.length;
      const slice = allLines.slice(startLine, startLine + count);

      return slice.map((line, i) => `${startLine + i + 1}: ${line}`).join("\n");
    },
  };

  return { search, get };
}

// Global defaults (backward compat — used by TUI, HTTP, legacy telegram)
const globalTools = createScopedMemoryTools(workspacePaths.workspaceDir);
export const memorySearchTool: ToolDef = globalTools.search;
export const memoryGetTool: ToolDef = globalTools.get;
