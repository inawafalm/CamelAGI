// Welcome screen component — Claude Code-inspired layout
// Renders a bordered box with ASCII art, tips, and recent activity

import { Text, visibleWidth } from "@mariozechner/pi-tui";
import chalk from "chalk";
import type { SessionMeta } from "../../session.js";

const palette = {
  border: "#3C414B",
  title: "#F6C453",
  heading: "#F6C453",
  text: "#E8E3D5",
  dim: "#7B7F87",
  accent: "#F2A65A",
  camelBody: "#F6C453",
  camelDetail: "#D4A843",
  camelAccessory: "#F2A65A",
};

const c = {
  border: (s: string) => chalk.hex(palette.border)(s),
  title: (s: string) => chalk.bold.hex(palette.title)(s),
  heading: (s: string) => chalk.hex(palette.heading)(s),
  text: (s: string) => chalk.hex(palette.text)(s),
  dim: (s: string) => chalk.hex(palette.dim)(s),
  accent: (s: string) => chalk.hex(palette.accent)(s),
  bold: (s: string) => chalk.bold.hex(palette.text)(s),
  camelBody: (s: string) => chalk.hex(palette.camelBody)(s),
  camelDetail: (s: string) => chalk.hex(palette.camelDetail)(s),
  camelAccessory: (s: string) => chalk.hex(palette.camelAccessory)(s),
};

// Camel ASCII art
const CAMEL_ART = [
  `   ${c.camelAccessory("╭──╮")}`,
  `   ${c.camelAccessory("│")}${c.camelBody("@@")}${c.camelAccessory("│")}`,
  `  ${c.camelBody("╭╯")}${c.camelAccessory("╰──╯")}${c.camelBody("╮")}`,
  `  ${c.camelBody("│")}  ${c.camelDetail("◉◉")}  ${c.camelBody("│")}`,
  ` ${c.camelBody("╭╯")}  ${c.camelBody("╰──╯")}  ${c.camelBody("╲")}`,
  ` ${c.camelBody("│")} ${c.camelDetail("╭────╮")} ${c.camelBody("│")}`,
  ` ${c.camelBody("╰╮")}${c.camelDetail("│")}    ${c.camelDetail("│")}${c.camelBody("╭╯")}`,
  `  ${c.camelBody("║")}${c.camelDetail("╰────╯")}${c.camelBody("║")}`,
  `  ${c.camelBody("╨")}  ${c.camelBody("╨╨")}  ${c.camelBody("╨")}`,
];

function padRight(str: string, width: number): string {
  const visible = visibleWidth(str);
  if (visible >= width) return str;
  return str + " ".repeat(width - visible);
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncateStr(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

export interface WelcomeOpts {
  version: string;
  userName?: string;
  model: string;
  effort: string;
  provider: string;
  cwd: string;
  sessions: SessionMeta[];
  thinking?: string;
}

export function buildWelcomeScreen(opts: WelcomeOpts, termWidth: number): Text {
  const boxWidth = Math.min(termWidth - 2, 90);
  const innerWidth = boxWidth - 4; // 2 for borders, 2 for inner padding
  const leftColWidth = 30;
  const rightColWidth = innerWidth - leftColWidth - 2; // 2 for gap

  // --- Left column ---
  const greeting = opts.userName
    ? c.bold(`Welcome back ${opts.userName}!`)
    : c.bold("Welcome to CamelAGI!");

  const thinkingStr = opts.thinking && opts.thinking !== "off"
    ? ` [think:${opts.thinking}]`
    : "";

  const modelLine = c.dim(
    `${opts.model}${thinkingStr}`,
  );
  const effortLine = c.dim(`${opts.effort} effort · ${opts.provider}`);

  // Shorten cwd
  const home = process.env.HOME ?? "";
  let cwdDisplay = opts.cwd;
  if (home && cwdDisplay.startsWith(home)) {
    cwdDisplay = "~" + cwdDisplay.slice(home.length);
  }
  const cwdLine = c.dim(truncateStr(cwdDisplay, leftColWidth));

  const leftLines: string[] = [];
  leftLines.push("");
  leftLines.push(greeting);
  leftLines.push("");
  for (const art of CAMEL_ART) {
    leftLines.push(art);
  }
  leftLines.push("");
  leftLines.push(modelLine);
  leftLines.push(effortLine);
  leftLines.push(cwdLine);

  // --- Right column ---
  const rightLines: string[] = [];
  rightLines.push("");
  rightLines.push(c.heading("Tips for getting started"));
  rightLines.push(c.text("Type a message to start chatting"));
  rightLines.push(c.text("Use /help for all commands"));
  rightLines.push("");
  rightLines.push(c.heading("Recent activity"));

  const recentSessions = opts.sessions.slice(0, 3);
  if (recentSessions.length === 0) {
    rightLines.push(c.dim("No recent sessions"));
  } else {
    for (const s of recentSessions) {
      const timeStr = formatRelativeTime(s.createdAt);
      const displayName = s.label ? `${s.id} (${s.label})` : s.id;
      const idStr = truncateStr(displayName, rightColWidth - 12);
      rightLines.push(
        c.dim(`${padRight(timeStr, 10)}`) + c.text(idStr),
      );
    }
  }
  rightLines.push(c.dim("/sessions for more"));

  // --- Combine columns ---
  const maxHeight = Math.max(leftLines.length, rightLines.length);

  // Pad both columns to same height
  while (leftLines.length < maxHeight) leftLines.push("");
  while (rightLines.length < maxHeight) rightLines.push("");

  // Build the box
  const lines: string[] = [];

  // Top border with title
  const titleText = ` CamelAGI v${opts.version} `;
  const titleLen = titleText.length;
  const leftBorderLen = 2;
  const rightBorderLen = boxWidth - leftBorderLen - titleLen - 2;
  lines.push(
    c.border("╭─") +
    c.title(titleText) +
    c.border("─".repeat(Math.max(0, rightBorderLen)) + "╮"),
  );

  // Content rows
  for (let i = 0; i < maxHeight; i++) {
    const left = padRight(leftLines[i], leftColWidth);
    const right = padRight(rightLines[i], rightColWidth);
    lines.push(
      c.border("│") +
      " " + left + "  " + right +
      " " + c.border("│"),
    );
  }

  // Bottom border
  lines.push(
    c.border("╰" + "─".repeat(boxWidth - 2) + "╯"),
  );

  const rendered = lines.join("\n");
  return new Text(rendered, 0, 0);
}
