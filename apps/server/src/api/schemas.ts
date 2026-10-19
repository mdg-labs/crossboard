import { z } from "zod";

/** The sort options of SPEC FR-13, shared by the list and by boards. */
export const SORTS = [
  "updated-desc",
  "updated-asc",
  "created-desc",
  "created-asc",
  "repo-asc",
  "title-asc",
] as const;

export const sortSchema = z.enum(SORTS);

export type Sort = z.infer<typeof sortSchema>;

export const DEFAULT_SORT: Sort = "updated-desc";
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;

const relationCountsSchema = z.object({
  /** Readable relations whose issue is still open. */
  open: z.number().int().nonnegative(),
  /** `max(0, total - readable)` for the viewer (SPEC FR-24). */
  notAccessible: z.number().int().nonnegative(),
});

/** The issue item of SPEC §7.4, defined once for every route that returns one. */
export const issueItemSchema = z.object({
  id: z.string(),
  repo: z.object({ owner: z.string(), name: z.string() }),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  /** `ghost` for a deleted account (SPEC §4.3). */
  author: z.string(),
  type: z.object({ name: z.string(), color: z.string().nullable() }).nullable(),
  milestone: z.object({ title: z.string(), url: z.string() }).nullable(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  assignees: z.array(z.object({ login: z.string(), avatarUrl: z.string() })),
  parent: z
    .object({ owner: z.string(), repo: z.string(), number: z.number().int() })
    .nullable(),
  subIssues: z.object({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
  }),
  blockedBy: relationCountsSchema,
  blocking: relationCountsSchema,
  /** SPEC FR-25. */
  isBlocked: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export type IssueItem = z.infer<typeof issueItemSchema>;

export const issueListQuerySchema = z.object({
  q: z.string().default(""),
  sort: sortSchema.default(DEFAULT_SORT),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export const queryWarningSchema = z.object({
  message: z.string(),
  start: z.number().int(),
  end: z.number().int(),
});

export const issueListSchema = z.object({
  items: z.array(issueItemSchema),
  total: z.number().int().nonnegative(),
  warnings: z.array(queryWarningSchema),
});

export type IssueList = z.infer<typeof issueListSchema>;

/** The qualifiers `GET /api/suggest` completes values for (SPEC FR-20). */
export const SUGGEST_FIELDS = [
  "label",
  "assignee",
  "author",
  "repo",
  "org",
  "user",
  "type",
  "milestone",
] as const;

export type SuggestField = (typeof SUGGEST_FIELDS)[number];

export const SUGGEST_LIMIT = 20;

export const suggestQuerySchema = z.object({
  field: z.enum(SUGGEST_FIELDS),
  prefix: z.string().default(""),
});

export const suggestionsSchema = z.object({
  values: z.array(z.string()).max(SUGGEST_LIMIT),
});

export type Suggestions = z.infer<typeof suggestionsSchema>;
