import { z } from "zod";

/** In-flight requests per installation and across the whole process (SPEC §6.1). */
export const MAX_REQUESTS_PER_INSTALLATION = 2;
export const MAX_REQUESTS_OVERALL = 4;

/** Waits before the 1st, 2nd and 3rd retry of a failed request (SPEC §6.1). */
export const BACKOFF_MS: readonly number[] = [1_000, 4_000, 16_000];

/** How many times one call waits for a limit GitHub reported before it gives up. */
export const MAX_LIMIT_WAITS = 3;

/** The two budgets an installation token has: REST requests and GraphQL points. */
export type RateResource = "rest" | "graphql";

/** What is left of one budget as of the last response that reported it. */
export interface RateBudget {
  remaining: number;
  /** The hourly allowance, when a response has reported it. */
  limit: number | null;
  /** Epoch milliseconds at which the budget refills, when reported. */
  resetAt: number | null;
}

/**
 * Each installation's remaining budget, in memory only. An installation is
 * unknown (`null`) until the first call that reports it after a restart
 * (FR-46). A `resetAt` in the past means the figure is stale, not full.
 */
export interface GithubBudgets {
  get(installationId: number): {
    rest: RateBudget | null;
    graphql: RateBudget | null;
  };
}

export interface BudgetStore extends GithubBudgets {
  update(
    installationId: number,
    resource: RateResource,
    reported: Partial<RateBudget> & { remaining: number },
  ): void;
}

export function createBudgetStore(): BudgetStore {
  const budgets = new Map<
    number,
    { rest: RateBudget | null; graphql: RateBudget | null }
  >();
  return {
    get(installationId) {
      const known = budgets.get(installationId);
      return { rest: known?.rest ?? null, graphql: known?.graphql ?? null };
    },
    update(installationId, resource, reported) {
      const known = budgets.get(installationId) ?? {
        rest: null,
        graphql: null,
      };
      const previous = known[resource];
      known[resource] = {
        remaining: reported.remaining,
        limit: reported.limit ?? previous?.limit ?? null,
        resetAt: reported.resetAt ?? previous?.resetAt ?? null,
      };
      budgets.set(installationId, known);
    },
  };
}

export interface Semaphore {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks running now. */
  readonly active: number;
}

/** At most `max` tasks run at once; the rest wait in arrival order. */
export function createSemaphore(max: number): Semaphore {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    get active() {
      return active;
    },
    async run(task) {
      if (active >= max) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        active++;
      }
      try {
        return await task();
      } finally {
        // A waiter inherits this slot, so `active` only drops when none waits.
        const next = waiting.shift();
        if (next === undefined) active--;
        else next();
      }
    },
  };
}

export type ResponseHeaders = Record<string, string | number | undefined>;

function headerOf(headers: ResponseHeaders, name: string): string | undefined {
  const value = headers[name];
  return value === undefined ? undefined : String(value);
}

function integerOf(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value);
}

/** The budget a REST (or GraphQL) response's `x-ratelimit-*` headers report. */
export function budgetFromHeaders(
  headers: ResponseHeaders,
): (Partial<RateBudget> & { remaining: number }) | undefined {
  const remaining = integerOf(headerOf(headers, "x-ratelimit-remaining"));
  if (remaining === undefined) return undefined;
  const limit = integerOf(headerOf(headers, "x-ratelimit-limit"));
  const reset = integerOf(headerOf(headers, "x-ratelimit-reset"));
  return {
    remaining,
    ...(limit === undefined ? {} : { limit }),
    ...(reset === undefined ? {} : { resetAt: reset * 1000 }),
  };
}

const graphqlRateLimitSchema = z.object({
  data: z.object({
    rateLimit: z.object({
      cost: z.number().optional(),
      remaining: z.number().optional(),
      limit: z.number().optional(),
      resetAt: z.string().optional(),
    }),
  }),
});

export interface GraphqlRateLimit {
  cost?: number;
  budget?: Partial<RateBudget> & { remaining: number };
}

/** What the `rateLimit { cost remaining limit resetAt }` of a GraphQL response (`{ data, errors }`) reports. */
export function rateLimitFromGraphql(data: unknown): GraphqlRateLimit {
  const parsed = graphqlRateLimitSchema.safeParse(data);
  if (!parsed.success) return {};
  const { cost, remaining, limit, resetAt } = parsed.data.data.rateLimit;
  const reset = resetAt === undefined ? Number.NaN : Date.parse(resetAt);
  return {
    ...(cost === undefined ? {} : { cost }),
    ...(remaining === undefined
      ? {}
      : {
          budget: {
            remaining,
            ...(limit === undefined ? {} : { limit }),
            ...(Number.isNaN(reset) ? {} : { resetAt: reset }),
          },
        }),
  };
}

/**
 * How long GitHub told the client to wait after a `403` or `429`, or
 * undefined when it told it nothing. `retry-after` (seconds, or an HTTP date)
 * wins. `x-ratelimit-reset` counts only when it says the budget is spent: a
 * `403` for a missing permission carries the header too, with budget left.
 */
export function waitMsFromHeaders(
  status: number,
  headers: ResponseHeaders,
  now: number,
): number | undefined {
  if (status !== 403 && status !== 429) return undefined;
  const retryAfter = headerOf(headers, "retry-after");
  if (retryAfter !== undefined) {
    const seconds = integerOf(retryAfter);
    if (seconds !== undefined) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const reset = integerOf(headerOf(headers, "x-ratelimit-reset"));
  const remaining = integerOf(headerOf(headers, "x-ratelimit-remaining"));
  if (reset !== undefined && (status === 429 || remaining === 0)) {
    return Math.max(0, reset * 1000 - now);
  }
  return undefined;
}

const graphqlRateLimitedSchema = z.object({
  errors: z.array(z.object({ type: z.string().optional() })),
});

/**
 * How long to wait after a GraphQL answer GitHub limited, or undefined when
 * it was not limited or said nothing about when the budget refills. GitHub
 * answers a spent primary budget with `200` and an error of type
 * `RATE_LIMITED`; `x-ratelimit-reset` wins over the body's
 * `rateLimit.resetAt`.
 */
export function graphqlLimitWaitMs(
  body: unknown,
  headers: ResponseHeaders,
  now: number,
): number | undefined {
  const parsed = graphqlRateLimitedSchema.safeParse(body);
  if (
    !parsed.success ||
    !parsed.data.errors.some((error) => error.type === "RATE_LIMITED")
  ) {
    return undefined;
  }
  const reset = integerOf(headerOf(headers, "x-ratelimit-reset"));
  const resetAt =
    reset === undefined
      ? rateLimitFromGraphql(body).budget?.resetAt
      : reset * 1000;
  return resetAt === undefined || resetAt === null
    ? undefined
    : Math.max(0, resetAt - now);
}
