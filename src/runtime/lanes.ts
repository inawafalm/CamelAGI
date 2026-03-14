// Concurrency lanes: limit parallel agent runs by type

export enum Lane {
  Main = "main",
  Cron = "cron",
  Subagent = "subagent",
}

interface LaneConfig {
  limit: number;
  active: number;
  queue: (() => void)[];
}

export interface LaneManager {
  configureLane: (lane: Lane, limit: number) => void;
  acquireLane: (lane: Lane) => Promise<() => void>;
  getLaneStats: () => Record<string, { active: number; limit: number; queued: number }>;
  reset: () => void;
}

export function createLaneManager(): LaneManager {
  const lanes = new Map<Lane, LaneConfig>();

  function configureLane(lane: Lane, limit: number): void {
    const existing = lanes.get(lane);
    if (existing) {
      existing.limit = limit;
    } else {
      lanes.set(lane, { limit, active: 0, queue: [] });
    }
  }

  function releaseLane(lane: Lane): void {
    const config = lanes.get(lane);
    if (!config) return;

    config.active--;

    // Wake up next waiter
    const next = config.queue.shift();
    if (next) next();
  }

  async function acquireLane(lane: Lane): Promise<() => void> {
    let config = lanes.get(lane);
    if (!config) {
      // Default: unlimited
      config = { limit: Infinity, active: 0, queue: [] };
      lanes.set(lane, config);
    }

    if (config.active < config.limit) {
      config.active++;
      return () => releaseLane(lane);
    }

    // Wait for a slot
    await new Promise<void>((resolve) => {
      config!.queue.push(resolve);
    });
    config.active++;
    return () => releaseLane(lane);
  }

  function getLaneStats(): Record<string, { active: number; limit: number; queued: number }> {
    const stats: Record<string, { active: number; limit: number; queued: number }> = {};
    for (const [lane, config] of lanes) {
      stats[lane] = {
        active: config.active,
        limit: config.limit === Infinity ? -1 : config.limit,
        queued: config.queue.length,
      };
    }
    return stats;
  }

  function reset(): void {
    lanes.clear();
  }

  return { configureLane, acquireLane, getLaneStats, reset };
}

// Backward-compat singleton
const defaultManager = createLaneManager();
export const { configureLane, acquireLane, getLaneStats } = defaultManager;
