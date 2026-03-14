// JSON-line request logger — writes to ~/.camelagi/logs/server.log

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Request, Response, NextFunction } from "express";

const LOG_DIR = path.join(os.homedir(), ".camelagi", "logs");
const LOG_FILE = path.join(LOG_DIR, "server.log");
const MAX_AGE_DAYS = 7;

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/** Delete rotated log files older than MAX_AGE_DAYS */
export function rotateOldLogs(): void {
  ensureLogDir();
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.startsWith("server-") || !f.endsWith(".log")) continue;
      const stat = fs.statSync(path.join(LOG_DIR, f));
      if (stat.mtimeMs < cutoff) fs.unlinkSync(path.join(LOG_DIR, f));
    }
  } catch { /* best effort */ }
}

/** Rotate current log if it's from a previous day */
function maybeRotate(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stat = fs.statSync(LOG_FILE);
    const logDate = new Date(stat.mtimeMs).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (logDate !== today) {
      fs.renameSync(LOG_FILE, path.join(LOG_DIR, `server-${logDate}.log`));
    }
  } catch { /* best effort */ }
}

interface LogEntry {
  ts: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  sessionId?: string;
  error?: string;
}

function writeLog(entry: LogEntry): void {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch { /* best effort */ }
}

/** Express middleware that logs each request as a JSON line */
export function requestLogger() {
  ensureLogDir();
  maybeRotate();
  rotateOldLogs();

  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();

    res.on("finish", () => {
      const entry: LogEntry = {
        ts: new Date().toISOString(),
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
      };

      const sid = req.body?.session ?? req.params?.id;
      if (sid) entry.sessionId = sid;

      if (res.statusCode >= 400) entry.error = res.statusMessage;

      writeLog(entry);
    });

    next();
  };
}

/** Tail the current log file — used by `camelagi logs` */
export function tailLog(lines: number = 50): string {
  if (!fs.existsSync(LOG_FILE)) return "No logs yet.";
  const content = fs.readFileSync(LOG_FILE, "utf-8").trim();
  if (!content) return "No logs yet.";
  const allLines = content.split("\n");
  return allLines.slice(-lines).join("\n");
}
