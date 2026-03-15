// Skills system: load skill definitions from ~/.camelagi/skills/

import fs from "node:fs";
import path from "node:path";
import { paths } from "../core/config.js";
import { MAX_SKILLS_TOTAL_CHARS } from "../core/constants.js";

const skillsDir = path.join(paths.configDir, "skills");

export interface Skill {
  name: string;
  description: string;
  content: string;
  path: string;
}

/**
 * Load all skills from ~/.camelagi/skills/
 * Each skill is a directory containing SKILL.md with optional frontmatter.
 *
 * Format:
 *   ~/.camelagi/skills/my-skill/SKILL.md
 *
 * Frontmatter (optional):
 *   ---
 *   name: my-skill
 *   description: Does something useful
 *   ---
 *   # Skill content here...
 */
export function loadSkills(): Skill[] {
  if (!fs.existsSync(skillsDir)) return [];

  const skills: Skill[] = [];
  const dirs = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;

    const skillFile = path.join(skillsDir, dir.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;

    const raw = fs.readFileSync(skillFile, "utf-8").trim();
    if (!raw) continue;

    const { frontmatter, content } = parseFrontmatter(raw);

    skills.push({
      name: frontmatter.name ?? dir.name,
      description: frontmatter.description ?? "",
      content,
      path: skillFile,
    });
  }

  return skills;
}

/**
 * Format skills for injection into the system prompt.
 * Uses progressive disclosure: only metadata is injected upfront.
 * The model reads the full SKILL.md on demand using the read tool.
 */
export function formatSkillsForPrompt(skills: Skill[], _maxChars = MAX_SKILLS_TOTAL_CHARS): string {
  if (skills.length === 0) return "";

  const lines: string[] = [
    "## Skills",
    "",
    "The following skills are available. When a user's request matches a skill,",
    "read its SKILL.md file to get detailed instructions, then follow them.",
    "",
    "<available_skills>",
  ];

  for (const skill of skills) {
    const desc = skill.description ? `: ${skill.description}` : "";
    lines.push(`  <skill name="${skill.name}" path="${skill.path}"${desc} />`);
  }

  lines.push("</available_skills>");
  lines.push("");
  lines.push("To use a skill: read its SKILL.md path above, then follow the instructions inside.");

  return lines.join("\n");
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; content: string } {
  const frontmatter: Record<string, string> = {};

  if (!raw.startsWith("---")) {
    return { frontmatter, content: raw };
  }

  const endIdx = raw.indexOf("---", 3);
  if (endIdx === -1) {
    return { frontmatter, content: raw };
  }

  const yaml = raw.slice(3, endIdx).trim();
  const content = raw.slice(endIdx + 3).trim();

  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    frontmatter[key] = value;
  }

  return { frontmatter, content };
}

export function ensureSkillsDir(): void {
  fs.mkdirSync(skillsDir, { recursive: true });
}

export function listSkillNames(): string[] {
  return loadSkills().map((s) => s.name);
}
