import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "../src/db/index.js";
import type { RateBudget } from "../src/github/index.js";
import {
  BACKGROUND_BUDGET_FLOOR,
  createInstallationPause,
  createJobs,
  PAUSE_RETRY_MS,
  UNKNOWN_RESET_RETRY_MS,
  type Jobs,
} from "../src/jobs/index.js";
import { createLogger } from "../src/logger.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

const SUSPENDED = 7;
const OTHER = 8;
const LIMIT = 5000;
const MINUTE = 60_000;

let database: TestDatabase;
let jobs: Jobs;
let logs: Record<string, unknown>[];
let ran: string[];
let budgets: Map<
  number,
  { rest: RateBudget | null; graphql: RateBudget | null }
>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  database = createTestDatabase();
  logs = [];
  ran = [];
  budgets = new Map();
  for (const id of [SUSPENDED, OTHER]) {
    database.db
      .insert(schema.installations)
      .values({
        id,
        accountLogin: `account-${String(id)}`,
        accountId: id,
        accountType: "User",
        suspended: false,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  }
});

afterEach(async () => {
  await jobs.stop();
  database.cleanup();
  vi.useRealTimers();
});

function build(exemptJobs: string[] = []) {
  jobs = createJobs({
    logger: createLogger("debug", {
      write: (chunk) => logs.push(JSON.parse(chunk) as Record<string, unknown>),
    }),
    pause: createInstallationPause({
      db: database.db,
      budgets: {
        get: (id) => budgets.get(id) ?? { rest: null, graphql: null },
      },
      exemptJobs,
    }),
  });
  for (const name of ["work", "exempt", "fan-out"]) {
    jobs.register<string>(name, (tag) => void ran.push(`${name}:${tag}`));
  }
  jobs.start();
}

const setSuspended = (id: number, suspended: boolean) =>
  database.db
    .update(schema.installations)
    .set({ suspended })
    .where(eq(schema.installations.id, id))
    .run();

const budget = (
  remaining: number,
  resetInMs: number | null,
  limit: number | null = LIMIT,
): RateBudget => ({
  remaining,
  limit,
  resetAt: resetInMs === null ? null : Date.now() + resetInMs,
});

const settle = () => vi.advanceTimersByTimeAsync(0);
const logged = (message: string) => logs.filter((line) => line.msg === message);

describe("a suspended installation", () => {
  it("drops its background job, logs why, and frees the key", async () => {
    build();
    setSuspended(SUSPENDED, true);

    expect(
      jobs.enqueue("work", "a", { installationId: SUSPENDED, key: "k" }),
    ).toBe(true);
    await settle();

    expect(ran).toEqual([]);
    expect(logged("background job dropped")).toEqual([
      expect.objectContaining({
        level: 30,
        job: "work",
        installationId: SUSPENDED,
        reason: "installation suspended",
      }),
    ]);

    // What `unsuspend` does: clear the flag, then enqueue again.
    setSuspended(SUSPENDED, false);
    expect(
      jobs.enqueue("work", "b", { installationId: SUSPENDED, key: "k" }),
    ).toBe(true);
    await settle();
    expect(ran).toEqual(["work:b"]);
  });

  it("drops a job that waited in the queue when the installation was suspended meanwhile", async () => {
    build();
    jobs.enqueue("work", "a", { installationId: SUSPENDED, delayMs: MINUTE });
    setSuspended(SUSPENDED, true);

    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(ran).toEqual([]);
    expect(logged("background job dropped")).toHaveLength(1);
  });

  it("leaves the jobs of other installations alone", async () => {
    build();
    setSuspended(SUSPENDED, true);

    jobs.enqueue("work", "a", { installationId: SUSPENDED });
    jobs.enqueue("work", "b", { installationId: OTHER });
    await settle();

    expect(ran).toEqual(["work:b"]);
  });

  it("runs an exempt job, so the delivery that lifts the suspension is not lost", async () => {
    build(["exempt"]);
    setSuspended(SUSPENDED, true);

    jobs.enqueue("exempt", "unsuspend", { installationId: SUSPENDED });
    jobs.enqueue("work", "a", { installationId: SUSPENDED });
    await settle();

    expect(ran).toEqual(["exempt:unsuspend"]);
  });

  it("runs an interactive job and a job that names no installation", async () => {
    build();
    setSuspended(SUSPENDED, true);

    jobs.enqueue("work", "interactive", {
      installationId: SUSPENDED,
      kind: "interactive",
    });
    jobs.enqueue("fan-out", "scheduler");
    await settle();

    expect(ran).toEqual(["work:interactive", "fan-out:scheduler"]);
  });

  it("defers rather than runs a job when the suspended flag cannot be read", async () => {
    build();
    const select = vi.spyOn(database.db, "select").mockImplementation(() => {
      throw new Error("database is locked");
    });

    jobs.enqueue("work", "a", { installationId: SUSPENDED, key: "k" });
    await settle();
    expect(ran).toEqual([]);
    expect(logs.filter((line) => line.level === 40)).toEqual([
      expect.objectContaining({ job: "work", installationId: SUSPENDED }),
    ]);

    // The key stays held while the job waits for its next check.
    expect(
      jobs.enqueue("work", "dup", { installationId: SUSPENDED, key: "k" }),
    ).toBe(false);

    select.mockRestore();
    setSuspended(SUSPENDED, true);
    await vi.advanceTimersByTimeAsync(PAUSE_RETRY_MS);
    expect(ran).toEqual([]);
    expect(logged("background job dropped")).toHaveLength(1);
  });
});

describe("an installation below 10% of its budget", () => {
  it("defers its background job until the reset, then runs it", async () => {
    build();
    budgets.set(SUSPENDED, {
      rest: null,
      graphql: budget(LIMIT * BACKGROUND_BUDGET_FLOOR - 1, 10 * MINUTE),
    });

    jobs.enqueue("work", "a", { installationId: SUSPENDED, key: "k" });
    jobs.enqueue("work", "b", { installationId: OTHER });
    await settle();

    expect(ran).toEqual(["work:b"]);
    expect(logged("background job paused")).toEqual([
      expect.objectContaining({
        level: 30,
        job: "work",
        installationId: SUSPENDED,
        reason: "installation budget below 10% until its reset",
        delayMs: 10 * MINUTE,
      }),
    ]);
    expect(
      jobs.enqueue("work", "dup", { installationId: SUSPENDED, key: "k" }),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
    expect(ran).toEqual(["work:b"]);

    await vi.advanceTimersByTimeAsync(1);
    expect(ran).toEqual(["work:b", "work:a"]);
    expect(logged("background job resumed")).toEqual([
      expect.objectContaining({ job: "work", installationId: SUSPENDED }),
    ]);
  });

  it("runs a job at exactly 10% remaining", async () => {
    build();
    budgets.set(SUSPENDED, {
      rest: null,
      graphql: budget(LIMIT * BACKGROUND_BUDGET_FLOOR, 10 * MINUTE),
    });

    jobs.enqueue("work", "a", { installationId: SUSPENDED });
    await settle();

    expect(ran).toEqual(["work:a"]);
  });

  it("waits for the later reset when both budgets are low", async () => {
    build();
    budgets.set(SUSPENDED, {
      rest: budget(10, 5 * MINUTE),
      graphql: budget(10, 20 * MINUTE),
    });

    jobs.enqueue("work", "a", { installationId: SUSPENDED });
    await vi.advanceTimersByTimeAsync(20 * MINUTE - 1);
    expect(ran).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(ran).toEqual(["work:a"]);
  });

  it("defers for a low REST budget alone", async () => {
    build();
    budgets.set(SUSPENDED, {
      rest: budget(10, MINUTE),
      graphql: budget(LIMIT, MINUTE),
    });

    jobs.enqueue("work", "a", { installationId: SUSPENDED });
    await settle();
    expect(ran).toEqual([]);

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(ran).toEqual(["work:a"]);
  });

  it("checks the budget again at the reset and defers again when it is still low", async () => {
    build();
    budgets.set(SUSPENDED, { rest: null, graphql: budget(10, MINUTE) });

    jobs.enqueue("work", "a", { installationId: SUSPENDED });
    await settle();
    budgets.set(SUSPENDED, { rest: null, graphql: budget(10, 2 * MINUTE) });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(ran).toEqual([]);
    expect(logged("background job paused")).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(ran).toEqual(["work:a"]);
  });

  it("runs a job whose installation has no known budget, as after a restart", async () => {
    build();

    jobs.enqueue("work", "a", { installationId: SUSPENDED });
    await settle();

    expect(ran).toEqual(["work:a"]);
  });

  it("does not hold a job on a figure whose reset has passed", async () => {
    build();
    budgets.set(SUSPENDED, { rest: null, graphql: budget(0, -1) });

    jobs.enqueue("work", "a", { installationId: SUSPENDED });
    await settle();

    expect(ran).toEqual(["work:a"]);
  });

  it("rechecks a low budget that names no reset instead of waiting forever", async () => {
    build();
    budgets.set(SUSPENDED, { rest: null, graphql: budget(0, null, null) });

    jobs.enqueue("work", "a", { installationId: SUSPENDED });
    await settle();
    expect(ran).toEqual([]);

    budgets.set(SUSPENDED, { rest: null, graphql: budget(LIMIT, MINUTE) });
    await vi.advanceTimersByTimeAsync(UNKNOWN_RESET_RETRY_MS);
    expect(ran).toEqual(["work:a"]);
  });

  it("runs an interactive job, which the detail fetch's own 2% floor governs", async () => {
    build();
    budgets.set(SUSPENDED, { rest: null, graphql: budget(250, 10 * MINUTE) });

    jobs.enqueue("work", "detail", {
      installationId: SUSPENDED,
      kind: "interactive",
    });
    jobs.enqueue("work", "background", { installationId: SUSPENDED });
    await settle();

    expect(ran).toEqual(["work:detail"]);
  });

  it("does not run a deferred job after the queue stops", async () => {
    build();
    budgets.set(SUSPENDED, { rest: null, graphql: budget(10, MINUTE) });

    jobs.enqueue("work", "a", { installationId: SUSPENDED });
    await settle();
    await jobs.stop();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);

    expect(ran).toEqual([]);
  });
});
