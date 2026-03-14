// Run tracking: prevents concurrent runs on the same session

import { QUEUE_WAIT_TIMEOUT_MS } from "../core/constants.js";

export interface RunHandle {
  sessionId: string;
  runId: string;
  startedAt: number;
  abort: () => void;
  isStreaming: () => boolean;
}

export interface RunTracker {
  generateRunId: () => string;
  setActiveRun: (sessionId: string, handle: RunHandle) => void;
  clearActiveRun: (runId: string) => void;
  isRunActive: (sessionId: string) => boolean;
  getActiveRun: (sessionId: string) => RunHandle | undefined;
  abortRun: (sessionId: string) => boolean;
  waitForRunEnd: (sessionId: string, timeoutMs?: number) => Promise<boolean>;
  getActiveRunCount: () => number;
  /** Atomically check-and-set: if no run active for session, sets one and returns the handle. */
  acquireRun: (sessionId: string, handle: RunHandle) => boolean;
  /** Reset all state (for testing) */
  reset: () => void;
}

export function createRunTracker(): RunTracker {
  // Primary index: runId -> handle
  const runsByRunId = new Map<string, RunHandle>();
  // Secondary index: sessionId -> runId (latest)
  const sessionToRunId = new Map<string, string>();
  const waiters = new Map<string, Set<(ended: boolean) => void>>();
  let runCounter = 0;

  function generateRunId(): string {
    return `run-${Date.now()}-${++runCounter}`;
  }

  function setActiveRun(sessionId: string, handle: RunHandle): void {
    // Abort any existing run for this session
    const existingRunId = sessionToRunId.get(sessionId);
    if (existingRunId) {
      const existing = runsByRunId.get(existingRunId);
      if (existing) existing.abort();
      runsByRunId.delete(existingRunId);
    }
    runsByRunId.set(handle.runId, handle);
    sessionToRunId.set(sessionId, handle.runId);
  }

  function clearActiveRun(runId: string): void {
    const handle = runsByRunId.get(runId);
    if (!handle) return;

    runsByRunId.delete(runId);

    // Only clear session mapping if this is still the latest run
    if (sessionToRunId.get(handle.sessionId) === runId) {
      sessionToRunId.delete(handle.sessionId);
    }

    // Notify waiters for this session
    const sessionWaiters = waiters.get(handle.sessionId);
    if (sessionWaiters) {
      for (const resolve of sessionWaiters) resolve(true);
      waiters.delete(handle.sessionId);
    }
  }

  function isRunActive(sessionId: string): boolean {
    const runId = sessionToRunId.get(sessionId);
    return runId !== undefined && runsByRunId.has(runId);
  }

  function getActiveRun(sessionId: string): RunHandle | undefined {
    const runId = sessionToRunId.get(sessionId);
    return runId ? runsByRunId.get(runId) : undefined;
  }

  function abortRun(sessionId: string): boolean {
    const runId = sessionToRunId.get(sessionId);
    if (!runId) return false;
    const handle = runsByRunId.get(runId);
    if (handle) {
      handle.abort();
      clearActiveRun(runId);
      return true;
    }
    return false;
  }

  function waitForRunEnd(sessionId: string, timeoutMs = QUEUE_WAIT_TIMEOUT_MS): Promise<boolean> {
    if (!isRunActive(sessionId)) return Promise.resolve(true);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const set = waiters.get(sessionId);
        if (set) set.delete(wrappedResolve);
        resolve(false);
      }, timeoutMs);

      const wrappedResolve = (ended: boolean) => {
        clearTimeout(timer);
        resolve(ended);
      };

      if (!waiters.has(sessionId)) waiters.set(sessionId, new Set());
      waiters.get(sessionId)!.add(wrappedResolve);
    });
  }

  function getActiveRunCount(): number {
    return runsByRunId.size;
  }

  function acquireRun(sessionId: string, handle: RunHandle): boolean {
    if (isRunActive(sessionId)) return false;
    setActiveRun(sessionId, handle);
    return true;
  }

  function reset(): void {
    runsByRunId.clear();
    sessionToRunId.clear();
    waiters.clear();
    runCounter = 0;
  }

  return {
    generateRunId, setActiveRun, clearActiveRun, isRunActive,
    getActiveRun, abortRun, waitForRunEnd, getActiveRunCount,
    acquireRun, reset,
  };
}

// Backward-compat singleton
const defaultTracker = createRunTracker();
export const { generateRunId, setActiveRun, clearActiveRun, isRunActive,
  getActiveRun, abortRun, waitForRunEnd, getActiveRunCount } = defaultTracker;
