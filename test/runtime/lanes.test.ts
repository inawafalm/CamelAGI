import { describe, it, expect, beforeEach } from "vitest";
import { createLaneManager, Lane } from "../../src/runtime/lanes.js";

describe("LaneManager", () => {
  let lm: ReturnType<typeof createLaneManager>;

  beforeEach(() => {
    lm = createLaneManager();
  });

  it("acquires lane with default unlimited config", async () => {
    const release = await lm.acquireLane(Lane.Main);
    expect(typeof release).toBe("function");
    release();
  });

  it("tracks active count in stats", async () => {
    const r1 = await lm.acquireLane(Lane.Main);
    const stats = lm.getLaneStats();
    expect(stats.main.active).toBe(1);

    const r2 = await lm.acquireLane(Lane.Main);
    expect(lm.getLaneStats().main.active).toBe(2);

    r1();
    expect(lm.getLaneStats().main.active).toBe(1);

    r2();
    expect(lm.getLaneStats().main.active).toBe(0);
  });

  it("respects lane limits", async () => {
    lm.configureLane(Lane.Main, 1);

    const r1 = await lm.acquireLane(Lane.Main);
    expect(lm.getLaneStats().main.active).toBe(1);

    // Second acquire should queue
    let acquired = false;
    const p2 = lm.acquireLane(Lane.Main).then((release) => {
      acquired = true;
      return release;
    });

    // Allow microtasks to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(acquired).toBe(false);
    expect(lm.getLaneStats().main.queued).toBe(1);

    // Release first — second should now acquire
    r1();
    const r2 = await p2;
    expect(acquired).toBe(true);
    expect(lm.getLaneStats().main.active).toBe(1);
    expect(lm.getLaneStats().main.queued).toBe(0);

    r2();
  });

  it("different lanes are independent", async () => {
    lm.configureLane(Lane.Main, 1);
    lm.configureLane(Lane.Cron, 1);

    const r1 = await lm.acquireLane(Lane.Main);
    const r2 = await lm.acquireLane(Lane.Cron);

    expect(lm.getLaneStats().main.active).toBe(1);
    expect(lm.getLaneStats().cron.active).toBe(1);

    r1();
    r2();
  });

  it("configureLane updates limit on existing lane", async () => {
    lm.configureLane(Lane.Main, 1);
    expect(lm.getLaneStats().main.limit).toBe(1);

    lm.configureLane(Lane.Main, 5);
    expect(lm.getLaneStats().main.limit).toBe(5);
  });

  it("reports -1 for unlimited lanes", async () => {
    await lm.acquireLane(Lane.Main);
    expect(lm.getLaneStats().main.limit).toBe(-1);
  });

  it("reset clears all lanes", async () => {
    await lm.acquireLane(Lane.Main);
    lm.reset();
    expect(lm.getLaneStats()).toEqual({});
  });
});
