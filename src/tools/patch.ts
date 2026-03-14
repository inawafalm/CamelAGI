// apply_patch tool: apply multi-file patches in a custom diff format

import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import type { ToolDef } from "../core/types.js";

interface PatchOp {
  type: "add" | "update" | "delete";
  path: string;
  chunks?: Chunk[];
  lines?: string[];
}

interface Chunk {
  context: string;
  lines: ChunkLine[];
}

interface ChunkLine {
  op: " " | "+" | "-";
  text: string;
}

function parsePatch(input: string): PatchOp[] {
  let text = input.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[^\n]*\n/, "").replace(/\n```$/, "");
  }
  text = text.replace(/^\*\*\* Begin Patch\s*\n/, "").replace(/\n\*\*\* End Patch\s*$/, "");

  const ops: PatchOp[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length).trim();
      const addLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("*** ")) {
        if (lines[i].startsWith("+")) {
          addLines.push(lines[i].slice(1));
        }
        i++;
      }
      ops.push({ type: "add", path: filePath, lines: addLines });

    } else if (line.startsWith("*** Delete File: ")) {
      const filePath = line.slice("*** Delete File: ".length).trim();
      ops.push({ type: "delete", path: filePath });
      i++;

    } else if (line.startsWith("*** Update File: ")) {
      const filePath = line.slice("*** Update File: ".length).trim();
      const chunks: Chunk[] = [];
      i++;

      while (i < lines.length && !lines[i].startsWith("*** ")) {
        if (lines[i].startsWith("@@ ")) {
          const context = lines[i].slice(3).trim();
          const chunkLines: ChunkLine[] = [];
          i++;

          while (i < lines.length && !lines[i].startsWith("*** ") && !lines[i].startsWith("@@ ")) {
            const cl = lines[i];
            if (cl.startsWith("+")) {
              chunkLines.push({ op: "+", text: cl.slice(1) });
            } else if (cl.startsWith("-")) {
              chunkLines.push({ op: "-", text: cl.slice(1) });
            } else if (cl.startsWith(" ") || cl === "") {
              chunkLines.push({ op: " ", text: cl.startsWith(" ") ? cl.slice(1) : cl });
            } else {
              chunkLines.push({ op: " ", text: cl });
            }
            i++;
          }

          chunks.push({ context, lines: chunkLines });
        } else {
          i++;
        }
      }

      ops.push({ type: "update", path: filePath, chunks });
    } else {
      i++;
    }
  }

  return ops;
}

function applyChunks(content: string, chunks: Chunk[]): string {
  const fileLines = content.split("\n");

  for (const chunk of chunks) {
    let contextIdx = -1;

    if (chunk.context) {
      for (let j = 0; j < fileLines.length; j++) {
        if (fileLines[j] === chunk.context) {
          contextIdx = j;
          break;
        }
      }
      if (contextIdx === -1) {
        for (let j = 0; j < fileLines.length; j++) {
          if (fileLines[j].trim() === chunk.context.trim()) {
            contextIdx = j;
            break;
          }
        }
      }
      if (contextIdx === -1) {
        throw new Error(`Context line not found: "${chunk.context}"`);
      }
    } else {
      contextIdx = 0;
    }

    const oldLines: string[] = [];
    const newLines: string[] = [];

    for (const cl of chunk.lines) {
      if (cl.op === " ") {
        oldLines.push(cl.text);
        newLines.push(cl.text);
      } else if (cl.op === "-") {
        oldLines.push(cl.text);
      } else if (cl.op === "+") {
        newLines.push(cl.text);
      }
    }

    let matchStart = -1;

    for (let start = contextIdx; start < fileLines.length; start++) {
      let matches = true;
      for (let k = 0; k < oldLines.length; k++) {
        if (start + k >= fileLines.length) { matches = false; break; }
        if (fileLines[start + k] !== oldLines[k]) {
          if (fileLines[start + k].trim() !== oldLines[k].trim()) {
            matches = false;
            break;
          }
        }
      }
      if (matches) {
        matchStart = start;
        break;
      }
    }

    if (matchStart === -1) {
      for (let start = Math.max(0, contextIdx - 1); start >= 0; start--) {
        let matches = true;
        for (let k = 0; k < oldLines.length; k++) {
          if (start + k >= fileLines.length) { matches = false; break; }
          if (fileLines[start + k].trim() !== oldLines[k].trim()) {
            matches = false;
            break;
          }
        }
        if (matches) {
          matchStart = start;
          break;
        }
      }
    }

    if (matchStart === -1) {
      throw new Error(`Could not match chunk at context: "${chunk.context}"`);
    }

    fileLines.splice(matchStart, oldLines.length, ...newLines);
  }

  return fileLines.join("\n");
}

/** Write atomically: write to temp file, then rename over target */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + `.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

function applyOp(op: PatchOp): string {
  switch (op.type) {
    case "add": {
      const dir = path.dirname(op.path);
      if (dir) fs.mkdirSync(dir, { recursive: true });
      const content = (op.lines ?? []).join("\n") + "\n";
      atomicWrite(op.path, content);
      return `A ${op.path}`;
    }
    case "delete": {
      if (!fs.existsSync(op.path)) return `D ${op.path} (already missing)`;
      fs.unlinkSync(op.path);
      return `D ${op.path}`;
    }
    case "update": {
      if (!fs.existsSync(op.path)) {
        return `ERROR: File not found: ${op.path}`;
      }
      const content = fs.readFileSync(op.path, "utf-8");
      const updated = applyChunks(content, op.chunks ?? []);
      atomicWrite(op.path, updated);
      return `M ${op.path}`;
    }
  }
}

export const patchTool: ToolDef = {
  name: "apply_patch",
  description: `Apply a patch to create, modify, or delete files. Use this for multi-file changes or when you know the exact diff.

Format:
*** Add File: path/to/new.ts
+line1
+line2

*** Update File: path/to/existing.ts
@@ context line to find
 unchanged line
-removed line
+added line

*** Delete File: path/to/old.ts`,
  schema: z.object({
    patch: z.string().describe("The patch content in the format described above"),
  }),
  execute: async (args) => {
    const { patch } = args as { patch: string };
    try {
      const ops = parsePatch(patch);
      if (ops.length === 0) return "ERROR: No valid patch operations found";

      // Phase 1: Dry-run all updates to catch errors before any writes
      // Save original contents for rollback
      const originals = new Map<string, string | null>();
      const staged: Array<{ op: PatchOp; content?: string }> = [];

      for (const op of ops) {
        if (op.type === "update") {
          if (!fs.existsSync(op.path)) {
            return `ERROR: File not found: ${op.path}`;
          }
          const content = fs.readFileSync(op.path, "utf-8");
          originals.set(op.path, content);
          const updated = applyChunks(content, op.chunks ?? []);
          staged.push({ op, content: updated });
        } else if (op.type === "add") {
          originals.set(op.path, fs.existsSync(op.path) ? fs.readFileSync(op.path, "utf-8") : null);
          staged.push({ op });
        } else {
          staged.push({ op });
        }
      }

      // Phase 2: Apply all operations
      const results: string[] = [];
      for (const { op, content } of staged) {
        try {
          if (op.type === "update" && content !== undefined) {
            atomicWrite(op.path, content);
            results.push(`M ${op.path}`);
          } else {
            results.push(applyOp(op));
          }
        } catch (err: unknown) {
          // Rollback already-applied files
          for (const [filePath, original] of originals) {
            try {
              if (original === null) {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
              } else {
                fs.writeFileSync(filePath, original, "utf-8");
              }
            } catch { /* best-effort rollback */ }
          }
          return `ERROR: ${op.path}: ${err instanceof Error ? err.message : String(err)} (all changes rolled back)`;
        }
      }

      return results.join("\n");
    } catch (err: unknown) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
