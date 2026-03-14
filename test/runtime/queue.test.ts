import { describe, it, expect, beforeEach } from "vitest";
import { createMessageQueue } from "../../src/runtime/queue.js";

describe("MessageQueue", () => {
  let queue: ReturnType<typeof createMessageQueue>;

  beforeEach(() => {
    queue = createMessageQueue();
  });

  it("starts with zero length", () => {
    expect(queue.getQueueLength("s1")).toBe(0);
  });

  it("enqueues messages", () => {
    // enqueueMessage returns a promise that won't resolve until drained
    queue.enqueueMessage("s1", "hello");
    expect(queue.getQueueLength("s1")).toBe(1);

    queue.enqueueMessage("s1", "world");
    expect(queue.getQueueLength("s1")).toBe(2);
  });

  it("drains queue returns messages and clears", () => {
    queue.enqueueMessage("s1", "a");
    queue.enqueueMessage("s1", "b");

    const drained = queue.drainQueue("s1");
    expect(drained).toHaveLength(2);
    expect(drained[0].text).toBe("a");
    expect(drained[1].text).toBe("b");
    expect(queue.getQueueLength("s1")).toBe(0);
  });

  it("drainQueue returns empty array for empty queue", () => {
    expect(queue.drainQueue("s1")).toEqual([]);
  });

  it("clearQueue rejects pending messages", async () => {
    const promise = queue.enqueueMessage("s1", "hello");
    queue.clearQueue("s1");

    await expect(promise).rejects.toThrow("Queue cleared");
    expect(queue.getQueueLength("s1")).toBe(0);
  });

  it("clearQueue is no-op for empty session", () => {
    // Should not throw
    queue.clearQueue("nonexistent");
  });

  it("separate sessions are independent", () => {
    queue.enqueueMessage("s1", "a");
    queue.enqueueMessage("s2", "b");
    expect(queue.getQueueLength("s1")).toBe(1);
    expect(queue.getQueueLength("s2")).toBe(1);

    queue.drainQueue("s1");
    expect(queue.getQueueLength("s1")).toBe(0);
    expect(queue.getQueueLength("s2")).toBe(1);
  });

  it("reset clears all queues", async () => {
    const p1 = queue.enqueueMessage("s1", "a");
    const p2 = queue.enqueueMessage("s2", "b");
    queue.reset();

    await expect(p1).rejects.toThrow("Queue cleared");
    await expect(p2).rejects.toThrow("Queue cleared");
  });
});
