// Message queue: per-session queue for inbound messages while agent is running

import { isRunActive, waitForRunEnd } from "./runs.js";

interface QueuedMessage {
  text: string;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  enqueuedAt: number;
}

export interface MessageQueue {
  enqueueMessage: (sessionId: string, text: string) => Promise<string>;
  getQueueLength: (sessionId: string) => number;
  drainQueue: (sessionId: string) => QueuedMessage[];
  clearQueue: (sessionId: string) => void;
  queueOrProcess: (sessionId: string, text: string) => Promise<{ queued: true; promise: Promise<string> } | { queued: false }>;
  reset: () => void;
}

export function createMessageQueue(): MessageQueue {
  const queues = new Map<string, QueuedMessage[]>();

  function enqueueMessage(sessionId: string, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!queues.has(sessionId)) queues.set(sessionId, []);
      queues.get(sessionId)!.push({ text, resolve, reject, enqueuedAt: Date.now() });
    });
  }

  function getQueueLength(sessionId: string): number {
    return queues.get(sessionId)?.length ?? 0;
  }

  function drainQueue(sessionId: string): QueuedMessage[] {
    const queue = queues.get(sessionId);
    if (!queue || queue.length === 0) return [];
    queues.delete(sessionId);
    return queue;
  }

  function clearQueue(sessionId: string): void {
    const queue = queues.get(sessionId);
    if (queue) {
      for (const msg of queue) {
        msg.reject(new Error("Queue cleared"));
      }
      queues.delete(sessionId);
    }
  }

  async function queueOrProcess(
    sessionId: string,
    text: string,
  ): Promise<{ queued: true; promise: Promise<string> } | { queued: false }> {
    if (!isRunActive(sessionId)) {
      return { queued: false };
    }

    // Run is active — enqueue and wait for run to end
    const promise = enqueueMessage(sessionId, text);
    await waitForRunEnd(sessionId);
    return { queued: true, promise };
  }

  function reset(): void {
    for (const [sid] of queues) {
      clearQueue(sid);
    }
  }

  return { enqueueMessage, getQueueLength, drainQueue, clearQueue, queueOrProcess, reset };
}

// Backward-compat singleton
const defaultQueue = createMessageQueue();
export const { enqueueMessage, getQueueLength, drainQueue, clearQueue, queueOrProcess } = defaultQueue;
