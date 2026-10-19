import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobs, type JobContext, type Jobs } from "../src/jobs/index.js";
import { createLogger } from "../src/logger.js";

let logs: Record<string, unknown>[];
let jobs: Jobs;
let openGates: ReturnType<typeof deferred>[];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  logs = [];
  openGates = [];
  jobs = createJobs({
    logger: createLogger("debug", {
      write: (chunk) => logs.push(JSON.parse(chunk)),
    }),
  });
});

afterEach(async () => {
  for (const gate of openGates) gate.resolve();
  await jobs.stop();
  vi.useRealTimers();
});

describe("enqueue", () => {
  it("runs a payload through the handler registered under the name", async () => {
    const seen: [unknown, JobContext][] = [];
    jobs.register(
      "a",
      (payload, context) => void seen.push([payload, context]),
    );
    jobs.register("b", () => {
      throw new Error("b must not run");
    });
    jobs.start();
    expect(jobs.enqueue("a", { n: 1 })).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([
      [
        { n: 1 },
        {
          name: "a",
          kind: "background",
          installationId: undefined,
          key: undefined,
        },
      ],
    ]);
  });

  it("holds jobs enqueued before start until start", async () => {
    const handler = vi.fn();
    jobs.register("a", handler);
    jobs.enqueue("a", 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(handler).not.toHaveBeenCalled();
    jobs.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("delays the job by delayMs", async () => {
    const handler = vi.fn();
    jobs.register("a", handler);
    jobs.start();
    jobs.enqueue("a", 1, { delayMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects a name without a handler and an invalid delay", () => {
    jobs.register("a", () => undefined);
    expect(() => jobs.enqueue("missing", 1)).toThrow(/no handler/);
    expect(() => jobs.enqueue("a", 1, { delayMs: -1 })).toThrow(RangeError);
    expect(() => jobs.register("a", () => undefined)).toThrow(/already/);
  });

  it("marks the job as background by default and interactive when asked", async () => {
    const kinds: string[] = [];
    jobs.register("a", (_payload, context) => void kinds.push(context.kind));
    jobs.start();
    jobs.enqueue("a", 1);
    jobs.enqueue("a", 2, { kind: "interactive" });
    await vi.advanceTimersByTimeAsync(0);
    expect(kinds).toEqual(["background", "interactive"]);
  });
});

describe("key deduplication", () => {
  it("keeps one job while one with the same key is pending", async () => {
    const payloads: unknown[] = [];
    jobs.register("a", (payload) => void payloads.push(payload));
    jobs.start();
    expect(jobs.enqueue("a", 1, { key: "k", delayMs: 5_000 })).toBe(true);
    expect(jobs.enqueue("a", 2, { key: "k", delayMs: 5_000 })).toBe(false);
    expect(jobs.enqueue("a", 3, { key: "other", delayMs: 5_000 })).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(payloads).toEqual([1, 3]);
  });

  it("accepts the key again once the job has started", async () => {
    const gate = deferred();
    const payloads: unknown[] = [];
    jobs.register("a", async (payload) => {
      payloads.push(payload);
      await gate.promise;
    });
    jobs.start();
    jobs.enqueue("a", 1, { key: "k" });
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.enqueue("a", 2, { key: "k" })).toBe(true);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(payloads).toEqual([1, 2]);
  });

  it("scopes a key to the job name", async () => {
    const a = vi.fn();
    const b = vi.fn();
    jobs.register("a", a);
    jobs.register("b", b);
    jobs.start();
    jobs.enqueue("a", 1, { key: "k", delayMs: 10 });
    expect(jobs.enqueue("b", 1, { key: "k", delayMs: 10 })).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("concurrency", () => {
  function trackConcurrency() {
    const gates: ReturnType<typeof deferred>[] = [];
    const active = new Map<number, number>();
    let activeTotal = 0;
    let peakTotal = 0;
    const peakPerInstallation = new Map<number, number>();
    jobs.register("a", async (_payload, context) => {
      const id = context.installationId ?? -1;
      active.set(id, (active.get(id) ?? 0) + 1);
      activeTotal += 1;
      peakTotal = Math.max(peakTotal, activeTotal);
      peakPerInstallation.set(
        id,
        Math.max(peakPerInstallation.get(id) ?? 0, active.get(id) ?? 0),
      );
      const gate = deferred();
      gates.push(gate);
      openGates.push(gate);
      await gate.promise;
      active.set(id, (active.get(id) ?? 1) - 1);
      activeTotal -= 1;
    });
    return {
      gates,
      peak: () => ({ total: peakTotal, per: peakPerInstallation }),
      activeTotal: () => activeTotal,
    };
  }

  it("runs at most 2 jobs at a time per installation", async () => {
    const probe = trackConcurrency();
    jobs.start();
    for (let n = 0; n < 5; n += 1) {
      jobs.enqueue("a", n, { installationId: 1 });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.activeTotal()).toBe(2);
    probe.gates[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.activeTotal()).toBe(2);
    expect(probe.gates).toHaveLength(3);
    for (const gate of probe.gates) gate.resolve();
    for (let round = 0; round < 3; round += 1) {
      await vi.advanceTimersByTimeAsync(0);
      for (const gate of probe.gates) gate.resolve();
    }
    expect(probe.gates).toHaveLength(5);
    expect(probe.peak().per.get(1)).toBe(2);
  });

  it("runs at most 4 installation jobs at a time overall", async () => {
    const probe = trackConcurrency();
    jobs.start();
    for (let installation = 1; installation <= 3; installation += 1) {
      for (let n = 0; n < 2; n += 1) {
        jobs.enqueue("a", n, { installationId: installation });
      }
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.activeTotal()).toBe(4);
    probe.gates[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.activeTotal()).toBe(4);
    expect(probe.gates).toHaveLength(5);
    for (let round = 0; round < 4; round += 1) {
      for (const gate of probe.gates) gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(probe.gates).toHaveLength(6);
    expect(probe.peak().total).toBe(4);
  });

  it("lets a job of another installation pass one that is held back", async () => {
    const probe = trackConcurrency();
    jobs.start();
    for (let n = 0; n < 3; n += 1) {
      jobs.enqueue("a", n, { installationId: 1 });
    }
    jobs.enqueue("a", 9, { installationId: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.gates).toHaveLength(3);
    expect(probe.peak().per.get(2)).toBe(1);
  });

  it("does not limit jobs that carry no installation id", async () => {
    const probe = trackConcurrency();
    jobs.start();
    for (let n = 0; n < 6; n += 1) jobs.enqueue("a", n);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.activeTotal()).toBe(6);
  });
});

describe("failing handlers", () => {
  it("logs the failure and keeps running the queue", async () => {
    const done = vi.fn();
    jobs.register("bad", () => {
      throw new Error("boom");
    });
    jobs.register("badAsync", () => Promise.reject(new Error("later")));
    jobs.register("good", done);
    jobs.start();
    jobs.enqueue("bad", 1, { installationId: 1 });
    jobs.enqueue("badAsync", 1, { installationId: 1 });
    jobs.enqueue("bad", 1, { installationId: 1 });
    jobs.enqueue("good", 1, { installationId: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledTimes(1);
    const failures = logs.filter((record) => record.msg === "job failed");
    expect(failures).toHaveLength(3);
    expect(failures[0]).toMatchObject({
      level: 50,
      job: "bad",
      installationId: 1,
    });
  });
});

describe("schedule", () => {
  it("runs the named job every intervalMs once started", async () => {
    const handler = vi.fn();
    jobs.register("tick", handler);
    jobs.schedule("tick", 1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(handler).not.toHaveBeenCalled();
    jobs.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("arms a schedule added after start", async () => {
    const handler = vi.fn();
    jobs.register("tick", handler);
    jobs.start();
    jobs.schedule("tick", 100);
    await vi.advanceTimersByTimeAsync(250);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not start a run while the previous one is still in progress", async () => {
    const gate = deferred();
    const handler = vi.fn(() => gate.promise);
    jobs.register("tick", handler);
    jobs.schedule("tick", 100);
    jobs.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).toHaveBeenCalledTimes(1);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("keeps ticking after a failed run", async () => {
    const handler = vi.fn(() => Promise.reject(new Error("boom")));
    jobs.register("tick", handler);
    jobs.schedule("tick", 100);
    jobs.start();
    await vi.advanceTimersByTimeAsync(350);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("rejects an unknown name, a duplicate schedule and a bad interval", () => {
    jobs.register("tick", () => undefined);
    expect(() => jobs.schedule("nope", 100)).toThrow(/no handler/);
    expect(() => jobs.schedule("tick", 0)).toThrow(RangeError);
    jobs.schedule("tick", 100);
    expect(() => jobs.schedule("tick", 100)).toThrow(/already scheduled/);
  });
});

describe("stop", () => {
  it("drops pending jobs, stops the timers and waits for running jobs", async () => {
    const gate = deferred();
    const finished = vi.fn();
    const tick = vi.fn();
    jobs.register("slow", async () => {
      await gate.promise;
      finished();
    });
    jobs.register("tick", tick);
    jobs.schedule("tick", 100);
    jobs.start();
    expect(jobs.started).toBe(true);
    jobs.enqueue("slow", 1);
    jobs.enqueue("slow", 2, { delayMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    const ticksBefore = tick.mock.calls.length;

    let stopped = false;
    const stopping = jobs.stop().then(() => {
      stopped = true;
    });
    expect(jobs.started).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped).toBe(false);
    expect(tick.mock.calls.length).toBe(ticksBefore);
    gate.resolve();
    await stopping;
    expect(finished).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue("slow", 3)).toBe(false);
  });
});
