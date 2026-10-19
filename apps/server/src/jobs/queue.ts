import type { Logger } from "pino";

/**
 * Background jobs are periodic or webhook-driven work that a rate-limit
 * guardrail may pause; interactive jobs serve a user who is waiting.
 */
export type JobKind = "background" | "interactive";

export interface JobContext {
  name: string;
  kind: JobKind;
  installationId: number | undefined;
  key: string | undefined;
}

export type JobHandler<P = unknown> = (
  payload: P,
  context: JobContext,
) => void | Promise<void>;

export interface EnqueueOptions {
  /** A job whose key matches a pending job of the same name is dropped. */
  key?: string;
  delayMs?: number;
  /** Subjects the job to the per-installation and overall limits. */
  installationId?: number;
  /** Defaults to `background`. */
  kind?: JobKind;
}

export interface JobsOptions {
  logger: Logger;
  perInstallationLimit?: number;
  overallLimit?: number;
}

export interface Jobs {
  register<P>(name: string, handler: JobHandler<P>): void;
  /** Returns false when the job was dropped as a duplicate or after `stop`. */
  enqueue(name: string, payload: unknown, options?: EnqueueOptions): boolean;
  schedule(name: string, intervalMs: number): void;
  /** Begins running queued jobs and scheduled timers. */
  start(): void;
  /** Stops new work, drops pending jobs and resolves once running ones end. */
  stop(): Promise<void>;
  readonly started: boolean;
}

interface QueuedJob {
  name: string;
  payload: unknown;
  context: JobContext;
  handler: JobHandler;
  dedupeKey: string | undefined;
  scheduled: boolean;
  timer: NodeJS.Timeout | undefined;
}

export const PER_INSTALLATION_LIMIT = 2;
export const OVERALL_LIMIT = 4;

export function createJobs(options: JobsOptions): Jobs {
  const { logger } = options;
  const perInstallationLimit =
    options.perInstallationLimit ?? PER_INSTALLATION_LIMIT;
  const overallLimit = options.overallLimit ?? OVERALL_LIMIT;

  const handlers = new Map<string, JobHandler>();
  const schedules = new Map<
    string,
    { intervalMs: number; timer: NodeJS.Timeout | undefined }
  >();
  const pending = new Set<QueuedJob>();
  const pendingKeys = new Set<string>();
  const waiting: QueuedJob[] = [];
  const running = new Set<Promise<void>>();
  const runningInstallations = new Map<number, number>();
  const runningScheduled = new Set<string>();
  let runningWithInstallation = 0;
  let started = false;
  let stopped = false;

  function canStart(job: QueuedJob): boolean {
    const { installationId } = job.context;
    if (installationId === undefined) return true;
    return (
      runningWithInstallation < overallLimit &&
      (runningInstallations.get(installationId) ?? 0) < perInstallationLimit
    );
  }

  function pump(): void {
    if (!started || stopped) return;
    for (let index = 0; index < waiting.length;) {
      const job = waiting[index];
      if (job === undefined || !canStart(job)) {
        index += 1;
        continue;
      }
      waiting.splice(index, 1);
      run(job);
    }
  }

  function run(job: QueuedJob): void {
    pending.delete(job);
    if (job.dedupeKey !== undefined) pendingKeys.delete(job.dedupeKey);
    const { installationId } = job.context;
    if (job.scheduled) runningScheduled.add(job.name);
    if (installationId !== undefined) {
      runningWithInstallation += 1;
      runningInstallations.set(
        installationId,
        (runningInstallations.get(installationId) ?? 0) + 1,
      );
    }
    const promise = (async () => {
      try {
        await job.handler(job.payload, job.context);
      } catch (error) {
        logger.error(
          {
            err: error,
            job: job.name,
            kind: job.context.kind,
            installationId,
            key: job.context.key,
          },
          "job failed",
        );
      } finally {
        if (job.scheduled) runningScheduled.delete(job.name);
        if (installationId !== undefined) {
          runningWithInstallation -= 1;
          const left = (runningInstallations.get(installationId) ?? 1) - 1;
          if (left === 0) runningInstallations.delete(installationId);
          else runningInstallations.set(installationId, left);
        }
      }
    })();
    running.add(promise);
    void promise.then(() => {
      running.delete(promise);
      pump();
    });
  }

  function release(job: QueuedJob): void {
    job.timer = undefined;
    if (stopped) return;
    waiting.push(job);
    pump();
  }

  function add(
    name: string,
    payload: unknown,
    enqueueOptions: EnqueueOptions,
    scheduled: boolean,
  ): boolean {
    const handler = handlers.get(name);
    if (handler === undefined) {
      throw new Error(`no handler registered for job "${name}"`);
    }
    if (stopped) {
      logger.debug({ job: name }, "job dropped: the queue is stopped");
      return false;
    }
    const delayMs = enqueueOptions.delayMs ?? 0;
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("delayMs must be a non-negative number");
    }
    const dedupeKey =
      enqueueOptions.key === undefined
        ? undefined
        : `${name}\u0000${enqueueOptions.key}`;
    if (dedupeKey !== undefined && pendingKeys.has(dedupeKey)) {
      logger.debug(
        { job: name, key: enqueueOptions.key },
        "job dropped: one with the same key is pending",
      );
      return false;
    }
    const job: QueuedJob = {
      name,
      payload,
      handler,
      dedupeKey,
      scheduled,
      timer: undefined,
      context: {
        name,
        kind: enqueueOptions.kind ?? "background",
        installationId: enqueueOptions.installationId,
        key: enqueueOptions.key,
      },
    };
    pending.add(job);
    if (dedupeKey !== undefined) pendingKeys.add(dedupeKey);
    if (delayMs > 0) {
      job.timer = setTimeout(() => release(job), delayMs);
      job.timer.unref();
    } else {
      release(job);
    }
    return true;
  }

  function enqueue(
    name: string,
    payload: unknown,
    enqueueOptions: EnqueueOptions = {},
  ): boolean {
    return add(name, payload, enqueueOptions, false);
  }

  function arm(
    name: string,
    entry: { intervalMs: number; timer: NodeJS.Timeout | undefined },
  ) {
    const timer = setInterval(() => {
      if (runningScheduled.has(name)) {
        logger.debug({ job: name }, "scheduled run skipped: still in progress");
        return;
      }
      add(name, undefined, { key: "[scheduled]" }, true);
    }, entry.intervalMs);
    timer.unref();
    entry.timer = timer;
  }

  return {
    register(name, handler) {
      if (handlers.has(name)) {
        throw new Error(`a handler is already registered for job "${name}"`);
      }
      handlers.set(name, handler as JobHandler);
    },
    enqueue,
    schedule(name, intervalMs) {
      if (!handlers.has(name)) {
        throw new Error(`no handler registered for job "${name}"`);
      }
      if (schedules.has(name)) {
        throw new Error(`job "${name}" is already scheduled`);
      }
      if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
        throw new RangeError("intervalMs must be a positive integer");
      }
      const entry = {
        intervalMs,
        timer: undefined as NodeJS.Timeout | undefined,
      };
      schedules.set(name, entry);
      if (started && !stopped) arm(name, entry);
    },
    start() {
      if (started || stopped) return;
      started = true;
      for (const [name, entry] of schedules) arm(name, entry);
      pump();
    },
    async stop() {
      stopped = true;
      for (const entry of schedules.values()) clearInterval(entry.timer);
      for (const job of pending) clearTimeout(job.timer);
      pending.clear();
      pendingKeys.clear();
      waiting.length = 0;
      await Promise.all(running);
    },
    get started() {
      return started && !stopped;
    },
  };
}
