// Lightweight structured logging — no external deps
//
// Pretty-prints colored output for terminal, with tag and message.

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: Level = "info";

export function setLogLevel(level: Level): void {
  currentLevel = level;
}

export function getLogLevel(): Level {
  return currentLevel;
}

function shouldLog(level: Level): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

const LEVEL_STYLE: Record<Level, { icon: string; color: string }> = {
  debug: { icon: "·", color: "\x1b[90m" },     // gray
  info:  { icon: "›", color: "\x1b[36m" },     // cyan
  warn:  { icon: "⚠", color: "\x1b[33m" },     // yellow
  error: { icon: "✗", color: "\x1b[31m" },     // red
};

function formatTime(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function emit(level: Level, tag: string, msg: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const { icon, color } = LEVEL_STYLE[level];
  const reset = "\x1b[0m";
  const gray = "\x1b[90m";
  const time = formatTime();

  let extra = "";
  if (data) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(data)) {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      // Truncate long values
      const display = val.length > 80 ? val.slice(0, 77) + "..." : val;
      parts.push(`${k}=${display}`);
    }
    if (parts.length > 0) extra = ` ${gray}${parts.join(" ")}${reset}`;
  }

  const line = `  ${gray}${time}${reset} ${color}${icon}${reset} ${gray}[${tag}]${reset} ${msg}${extra}\n`;

  if (level === "error" || level === "warn") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export const log = {
  debug: (tag: string, msg: string, data?: Record<string, unknown>) => emit("debug", tag, msg, data),
  info:  (tag: string, msg: string, data?: Record<string, unknown>) => emit("info", tag, msg, data),
  warn:  (tag: string, msg: string, data?: Record<string, unknown>) => emit("warn", tag, msg, data),
  error: (tag: string, msg: string, data?: Record<string, unknown>) => emit("error", tag, msg, data),
};
