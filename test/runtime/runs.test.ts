import { describe, it, expect, beforeEach } from "vitest";
import { createRunTracker, type RunHandle } from "../../src/runtime/runs.js";

function makeHandle(sessionId: string, runId: string, overrides?: Partial<RunHandle>): RunHandle {
  return {
    sessionId,
    runId,
    startedAt: Date.now(),
    abort: overrides?.abort ?? (() => {}),
    isStreaming: overrides?.isStreaming ?? (() => false),
  };
}

describe("RunTracker", () => {
  let tracker: ReturnType<typeof createRunTracker>;

  beforeEach(() => {
    tracker = createRunTracker();
  });

  it("generates unique run IDs", () => {
    const a = tracker.generateRunId();
    const b = tracker.generateRunId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^run-/);
  });

  it("tracks active runs", () => {
    const handle = makeHandle("s1", "r1");
    tracker.setActiveRun("s1", handle);
    expect(tracker.isRunActive("s1")).toBe(true);
    expect(tracker.getActiveRunCount()).toBe(1);
  });

  it("returns false for inactive sessions", () => {
    expect(tracker.isRunActive("nonexistent")).toBe(false);
  });

  it("clears active run", () => {
    const handle = makeHandle("s1", "r1");
    tracker.setActiveRun("s1", handle);
    tracker.clearActiveRun("r1");
    expect(tracker.isRunActive("s1")).toBe(false);
    expect(tracker.getActiveRunCount()).toBe(0);
  });

  it("clears only the specified run", () => {
    const h1 = makeHandle("s1", "r1");
    const h2 = makeHandle("s2", "r2");
    tracker.setActiveRun("s1", h1);
    tracker.setActiveRun("s2", h2);
    tracker.clearActiveRun("r1");
    expect(tracker.isRunActive("s1")).toBe(false);
    expect(tracker.isRunActive("s2")).toBe(true);
  });

  it("aborts existing run when new run set for same session", () => {
    let aborted = false;
    const h1 = makeHandle("s1", "r1", { abort: () => { aborted = true; } });
    tracker.setActiveRun("s1", h1);
    const h2 = makeHandle("s1", "r2");
    tracker.setActiveRun("s1", h2);
    expect(aborted).toBe(true);
    expect(tracker.getActiveRunCount()).toBe(1);
  });

  it("getActiveRun returns handle", () => {
    const handle = makeHandle("s1", "r1");
    tracker.setActiveRun("s1", handle);
    expect(tracker.getActiveRun("s1")).toBe(handle);
  });

  it("getActiveRun returns undefined for inactive", () => {
    expect(tracker.getActiveRun("s1")).toBeUndefined();
  });

  it("abortRun aborts and clears", () => {
    let aborted = false;
    const handle = makeHandle("s1", "r1", { abort: () => { aborted = true; } });
    tracker.setActiveRun("s1", handle);
    expect(tracker.abortRun("s1")).toBe(true);
    expect(aborted).toBe(true);
    expect(tracker.isRunActive("s1")).toBe(false);
  });

  it("abortRun returns false for nonexistent", () => {
    expect(tracker.abortRun("s1")).toBe(false);
  });

  it("acquireRun succeeds when no active run", () => {
    const handle = makeHandle("s1", "r1");
    expect(tracker.acquireRun("s1", handle)).toBe(true);
    expect(tracker.isRunActive("s1")).toBe(true);
  });

  it("acquireRun fails when run already active", () => {
    const h1 = makeHandle("s1", "r1");
    const h2 = makeHandle("s1", "r2");
    tracker.setActiveRun("s1", h1);
    expect(tracker.acquireRun("s1", h2)).toBe(false);
    // Original still active
    expect(tracker.getActiveRun("s1")).toBe(h1);
  });

  it("waitForRunEnd resolves immediately if no active run", async () => {
    const ended = await tracker.waitForRunEnd("s1", 100);
    expect(ended).toBe(true);
  });

  it("waitForRunEnd resolves when run clears", async () => {
    const handle = makeHandle("s1", "r1");
    tracker.setActiveRun("s1", handle);

    const promise = tracker.waitForRunEnd("s1", 5000);
    tracker.clearActiveRun("r1");
    const ended = await promise;
    expect(ended).toBe(true);
  });

  it("waitForRunEnd times out", async () => {
    const handle = makeHandle("s1", "r1");
    tracker.setActiveRun("s1", handle);

    const ended = await tracker.waitForRunEnd("s1", 50);
    expect(ended).toBe(false);
  });

  it("reset clears all state", () => {
    tracker.setActiveRun("s1", makeHandle("s1", "r1"));
    tracker.setActiveRun("s2", makeHandle("s2", "r2"));
    tracker.reset();
    expect(tracker.getActiveRunCount()).toBe(0);
    expect(tracker.isRunActive("s1")).toBe(false);
    expect(tracker.isRunActive("s2")).toBe(false);
  });
});
