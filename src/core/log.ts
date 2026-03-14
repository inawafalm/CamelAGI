// Lightweight structured logging — no external deps
//
// Server/daemon/cron paths output structured JSON.
// TUI paths continue to use console directly (user-facing ANSI output).

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

function emit(level: Level, tag: string, msg: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    tag,
    msg,
  };
  if (data) Object.assign(entry, data);

  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const log = {
  debug: (tag: string, msg: string, data?: Record<string, unknown>) => emit("debug", tag, msg, data),
  info:  (tag: string, msg: string, data?: Record<string, unknown>) => emit("info", tag, msg, data),
  warn:  (tag: string, msg: string, data?: Record<string, unknown>) => emit("warn", tag, msg, data),
  error: (tag: string, msg: string, data?: Record<string, unknown>) => emit("error", tag, msg, data),
};
