// Cron: scheduled agent runs with runtime management
//
// Two sources of jobs:
// 1. Config-defined (config.yaml `cron:` array) — read-only from here
// 2. Runtime-defined (~/.camelagi/cron/jobs.json) — CRUD via tool/CLI
//
// Schedule formats:
//   "5m", "1h", "1d"         — repeating interval
//   "*/5 * * * *"            — cron expression (interval extracted from minute field)
//   "+20m", "+2h"            — one-shot relative (runs once, then auto-deletes)
//   "2026-03-14T09:00:00Z"   — one-shot absolute ISO timestamp

import type { Config } from "../core/config.js";
import { runAgent } from "../agent.js";
import { loadMessages, saveMessage } from "../session.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { paths } from "../core/config.js";
import fs from "node:fs";
import path from "node:path";

// --- Types ---

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  session?: string;
  enabled: boolean;
  source?: "config" | "runtime";
  createdAt?: number;
  deleteAfterRun?: boolean;
}

export interface JobStatus {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  source: "config" | "runtime";
  lastRunAt?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
  running: boolean;
}

interface ActiveJob {
  job: CronJob;
  timer: ReturnType<typeof setTimeout>;
  lastRunAt?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
  consecutiveErrors: number;
  running: boolean;
}

// --- Module state ---

const activeJobs = new Map<string, ActiveJob>();

let serverConfig: Config | null = null;
let serverSystemPrompt = "";

const cronDir = path.join(paths.configDir, "cron");
const storeFile = path.join(cronDir, "jobs.json");

/** Set server context so runtime-added jobs can auto-start */
export function setCronContext(config: Config, systemPrompt: string): void {
  serverConfig = config;
  serverSystemPrompt = systemPrompt;
}

// --- Schedule parsing ---

function parseInterval(schedule: string): number | null {
  const match = schedule.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s": return value * 1000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    case "d": return value * 86_400_000;
    default: return null;
  }
}

function isOneShot(schedule: string): boolean {
  if (schedule.startsWith("+")) return true;
  const d = new Date(schedule);
  return !isNaN(d.getTime()) && schedule.length > 8;
}

function parseOneShotDelay(schedule: string): number | null {
  if (schedule.startsWith("+")) {
    const interval = parseInterval(schedule.slice(1));
    return interval ?? null;
  }
  const d = new Date(schedule);
  if (isNaN(d.getTime())) return null;
  return Math.max(0, d.getTime() - Date.now());
}

function parseCronInterval(schedule: string): number {
  const interval = parseInterval(schedule);
  if (interval) return interval;

  const parts = schedule.split(/\s+/);
  if (parts.length === 5) {
    const [min] = parts;
    if (min.startsWith("*/")) return parseInt(min.slice(2), 10) * 60_000;
  }

  return 60_000;
}

// --- Backoff (30s → 1m → 5m → 15m → 60m) ---

const BACKOFF = [30_000, 60_000, 300_000, 900_000, 3_600_000];

function backoffDelay(errors: number): number {
  return BACKOFF[Math.min(errors - 1, BACKOFF.length - 1)] ?? 30_000;
}

// --- Runtime store (~/.camelagi/cron/jobs.json) ---

export function loadRuntimeJobs(): CronJob[] {
  try {
    if (!fs.existsSync(storeFile)) return [];
    const raw = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    return (raw.jobs ?? []) as CronJob[];
  } catch {
    return [];
  }
}

function saveRuntimeJobs(jobs: CronJob[]): void {
  fs.mkdirSync(cronDir, { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify({ version: 1, jobs }, null, 2));
}

// --- Core: start/stop jobs ---

export function startCronJob(
  job: CronJob,
  config: Config,
  systemPrompt: string,
  opts?: {
    onRun?: (jobId: string, response: string) => void;
    onError?: (jobId: string, error: Error) => void;
    maxTurns?: number;
    timeoutMs?: number;
  },
): void {
  if (activeJobs.has(job.id)) stopCronJob(job.id);

  const sid = job.session ?? `cron-${job.id}`;
  const oneShot = isOneShot(job.schedule);

  const active: ActiveJob = {
    job,
    timer: null as unknown as ReturnType<typeof setTimeout>,
    consecutiveErrors: 0,
    running: false,
  };

  const run = async () => {
    if (active.running) return;
    active.running = true;

    try {
      // Build a cron-specific system prompt (minimal bootstrap: AGENTS.md + TOOLS.md only)
      const cronPrompt = buildSystemPrompt(config.systemPrompt, config.skills, undefined, "cron");
      const history = loadMessages(sid);
      const result = await runAgent(config.apiKey!, config.model, cronPrompt, history, job.prompt, {
        maxTurns: opts?.maxTurns ?? 10,
        timeoutMs: opts?.timeoutMs ?? 120_000,
        provider: config.provider,
        baseUrl: config.baseUrl,
      });

      saveMessage(sid, { role: "user", content: job.prompt }, "cron");
      if (result.response) saveMessage(sid, { role: "assistant", content: result.response }, "cron");

      active.lastRunAt = Date.now();
      active.lastStatus = "ok";
      active.lastError = undefined;
      active.consecutiveErrors = 0;
      active.running = false;

      opts?.onRun?.(job.id, result.response);

      // One-shot: auto-remove after success
      if (oneShot && job.deleteAfterRun !== false) {
        stopCronJob(job.id);
        removeRuntimeJob(job.id);
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      active.lastRunAt = Date.now();
      active.lastStatus = "error";
      active.lastError = error.message;
      active.consecutiveErrors++;
      active.running = false;
      opts?.onError?.(job.id, error);
    }
  };

  // Schedule using setTimeout chains (allows dynamic backoff)
  const scheduleNext = () => {
    if (!activeJobs.has(job.id)) return;
    const delay = active.consecutiveErrors > 0
      ? backoffDelay(active.consecutiveErrors)
      : parseCronInterval(job.schedule);
    active.timer = setTimeout(async () => {
      await run();
      if (!oneShot) scheduleNext();
    }, delay);
  };

  activeJobs.set(job.id, active);

  if (oneShot) {
    const delay = parseOneShotDelay(job.schedule);
    if (delay === null) { activeJobs.delete(job.id); return; }
    active.timer = setTimeout(run, delay);
  } else {
    // Run immediately, then schedule repeating
    void (async () => {
      await run();
      scheduleNext();
    })();
  }
}

export function stopCronJob(id: string): boolean {
  const active = activeJobs.get(id);
  if (!active) return false;
  clearTimeout(active.timer);
  activeJobs.delete(id);
  return true;
}

export function stopAllCronJobs(): void {
  for (const [id] of activeJobs) stopCronJob(id);
}

export function listCronJobs(): CronJob[] {
  return Array.from(activeJobs.values()).map((a) => a.job);
}

export function isCronRunning(id: string): boolean {
  return activeJobs.has(id);
}

// --- Runtime management ---

/** Get status of all jobs (active + inactive runtime jobs) */
export function getAllJobStatuses(): JobStatus[] {
  const statuses: JobStatus[] = [];
  const seen = new Set<string>();

  for (const [, a] of activeJobs) {
    seen.add(a.job.id);
    statuses.push({
      id: a.job.id,
      name: a.job.name,
      schedule: a.job.schedule,
      prompt: a.job.prompt,
      enabled: true,
      source: a.job.source ?? "config",
      lastRunAt: a.lastRunAt,
      lastStatus: a.lastStatus,
      lastError: a.lastError,
      running: a.running,
    });
  }

  // Include inactive runtime jobs
  for (const job of loadRuntimeJobs()) {
    if (!seen.has(job.id)) {
      statuses.push({
        id: job.id,
        name: job.name,
        schedule: job.schedule,
        prompt: job.prompt,
        enabled: job.enabled,
        source: "runtime",
        running: false,
      });
    }
  }

  return statuses;
}

/** Add a runtime job (persisted to jobs.json, auto-started if server running) */
export function addRuntimeJob(job: Omit<CronJob, "source" | "createdAt">, autoStart = true): CronJob {
  const jobs = loadRuntimeJobs();
  if (jobs.some((j) => j.id === job.id)) throw new Error(`Job "${job.id}" already exists`);
  if (activeJobs.has(job.id)) throw new Error(`Job "${job.id}" already exists (active)`);

  const full: CronJob = { ...job, source: "runtime", createdAt: Date.now() };

  // Convert relative "+20m" to absolute ISO so it survives server restarts
  if (full.schedule.startsWith("+")) {
    const interval = parseInterval(full.schedule.slice(1));
    if (interval) {
      full.schedule = new Date(Date.now() + interval).toISOString();
    }
  }

  if (isOneShot(full.schedule) && full.deleteAfterRun === undefined) full.deleteAfterRun = true;

  jobs.push(full);
  saveRuntimeJobs(jobs);

  if (autoStart && full.enabled && serverConfig) {
    startCronJob(full, serverConfig, serverSystemPrompt);
  }

  return full;
}

/** Remove a runtime job (stops if active, removes from store) */
export function removeRuntimeJob(id: string): boolean {
  const jobs = loadRuntimeJobs();
  const filtered = jobs.filter((j) => j.id !== id);
  if (filtered.length === jobs.length) return false;
  saveRuntimeJobs(filtered);
  stopCronJob(id);
  return true;
}

/** Trigger a job immediately (runs synchronously, returns response) */
export async function runJobNow(id: string): Promise<string> {
  if (!serverConfig) throw new Error("Server not running");

  const active = activeJobs.get(id);
  const job = active?.job ?? loadRuntimeJobs().find((j) => j.id === id);
  if (!job) {
    // Also check config jobs
    const configJob = serverConfig.cron.find((j) => j.id === id);
    if (!configJob) throw new Error(`Job "${id}" not found`);
    return runJobWithConfig(configJob);
  }

  return runJobWithConfig(job);
}

async function runJobWithConfig(job: CronJob): Promise<string> {
  if (!serverConfig) throw new Error("Server not running");

  const cronPrompt = buildSystemPrompt(serverConfig.systemPrompt, serverConfig.skills, undefined, "cron");
  const sid = job.session ?? `cron-${job.id}`;
  const history = loadMessages(sid);
  const result = await runAgent(serverConfig.apiKey!, serverConfig.model, cronPrompt, history, job.prompt, {
    maxTurns: 10,
    timeoutMs: 120_000,
    provider: serverConfig.provider,
    baseUrl: serverConfig.baseUrl,
  });

  saveMessage(sid, { role: "user", content: job.prompt }, "cron");
  if (result.response) saveMessage(sid, { role: "assistant", content: result.response }, "cron");

  const active = activeJobs.get(job.id);
  if (active) {
    active.lastRunAt = Date.now();
    active.lastStatus = "ok";
    active.lastError = undefined;
    active.consecutiveErrors = 0;
  }

  return result.response;
}

/** Start all enabled runtime jobs (call from serve.ts alongside config jobs) */
export function startRuntimeJobs(
  config: Config,
  systemPrompt: string,
  opts?: {
    onRun?: (id: string, response: string) => void;
    onError?: (id: string, error: Error) => void;
  },
): number {
  const jobs = loadRuntimeJobs().filter((j) => j.enabled);
  for (const job of jobs) {
    if (!activeJobs.has(job.id)) {
      startCronJob(job, config, systemPrompt, opts);
    }
  }
  return jobs.length;
}
