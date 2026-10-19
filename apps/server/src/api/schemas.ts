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

export const issueStateSchema = z.enum(["OPEN", "CLOSED"]);

/**
 * One entry of a `blockedBy` / `blocking` list (SPEC FR-23). Only relations in
 * a repo the viewer can read are listed; the rest are counted in
 * `notAccessible` (FR-24). `synced` marks an entry that has a detail view
 * (FR-39); a closed or not yet synced issue is listed with `synced: false`.
 */
export const issueRelationSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  state: issueStateSchema,
  url: z.string(),
  synced: z.boolean(),
});

export type IssueRelationEntry = z.infer<typeof issueRelationSchema>;

const relationListSchema = relationCountsSchema.extend({
  items: z.array(issueRelationSchema),
});

/**
 * The summary route's response (SPEC §7.4): the issue item, with the parent's
 * title and state and the full dependency lists in place of the bare counts.
 */
export const issueSummarySchema = issueItemSchema.extend({
  parent: z
    .object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int(),
      title: z.string(),
      state: issueStateSchema,
    })
    .nullable(),
  blockedBy: relationListSchema,
  blocking: relationListSchema,
});

export type IssueSummary = z.infer<typeof issueSummarySchema>;

/** One comment of the details route (SPEC FR-43); `bodyHtml` is sanitized (FR-41). */
export const issueCommentSchema = z.object({
  url: z.string(),
  createdAt: z.number().int(),
  /** `ghost` for a deleted account (SPEC §4.3). */
  author: z.string(),
  avatarUrl: z.string().nullable(),
  bodyHtml: z.string(),
});

export type IssueComment = z.infer<typeof issueCommentSchema>;

export const subIssueSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  state: issueStateSchema,
  url: z.string(),
});

export type SubIssue = z.infer<typeof subIssueSchema>;

/**
 * The details route's response (SPEC §7.4, FR-42, FR-43): the issue's rendered
 * body, its most recent comments oldest first, and its first sub-issues.
 * `commentsTotal` counts every comment, so the UI can show "N earlier
 * comments"; `subIssues.total` counts every sub-issue on GitHub. Sub-issues in
 * a repo outside the viewer's access are left out of `items` and counted in
 * `notAccessible` (SPEC §9.1). `stale` marks a copy that is out of date
 * because the refetch failed.
 */
export const issueDetailsSchema = z.object({
  bodyHtml: z.string(),
  comments: z.array(issueCommentSchema),
  commentsTotal: z.number().int().nonnegative(),
  subIssues: z.object({
    total: z.number().int().nonnegative(),
    notAccessible: z.number().int().nonnegative(),
    items: z.array(subIssueSchema),
  }),
  fetchedAt: z.number().int(),
  stale: z.boolean(),
});

export type IssueDetails = z.infer<typeof issueDetailsSchema>;

export const issueParamsSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.coerce.number().int().min(1),
});

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

export const VIEW_NAME_MAX = 100;

const viewNameSchema = z.string().trim().min(1).max(VIEW_NAME_MAX);

/** A saved view of SPEC FR-22: a name for a filter and a sort. */
export const viewSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  filter: z.string(),
  sort: sortSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export type View = z.infer<typeof viewSchema>;

export const viewListSchema = z.object({ items: z.array(viewSchema) });

export const viewCreateSchema = z.object({
  name: viewNameSchema,
  filter: z.string().default(""),
  sort: sortSchema.default(DEFAULT_SORT),
});

export const viewPatchSchema = z
  .object({
    name: viewNameSchema,
    filter: z.string(),
    sort: sortSchema,
  })
  .partial()
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    {
      message: "Send at least one of name, filter and sort",
    },
  );

export const BOARD_NAME_MAX = 100;
export const BOARD_COLUMNS_MAX = 20;

export const SUB_ISSUE_MODES = ["collapsed", "expanded"] as const;

export const subIssueModeSchema = z.enum(SUB_ISSUE_MODES);

export type SubIssueMode = z.infer<typeof subIssueModeSchema>;

const boardNameSchema = z.string().trim().min(1).max(BOARD_NAME_MAX);

const boardColumnInputSchema = z.object({
  name: boardNameSchema,
  filter: z.string().default(""),
});

const boardColumnsInputSchema = z
  .array(boardColumnInputSchema)
  .min(1)
  .max(BOARD_COLUMNS_MAX);

export const boardColumnSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  filter: z.string(),
});

/** A board of SPEC FR-28: a base filter and ordered columns that are filters. */
export const boardSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  baseFilter: z.string(),
  sort: sortSchema,
  subIssueMode: subIssueModeSchema,
  showOther: z.boolean(),
  columns: z.array(boardColumnSchema),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export type Board = z.infer<typeof boardSchema>;

export const boardListSchema = z.object({ items: z.array(boardSchema) });

export const boardCreateSchema = z.object({
  name: boardNameSchema,
  baseFilter: z.string().default(""),
  columns: boardColumnsInputSchema,
  sort: sortSchema.default(DEFAULT_SORT),
  subIssueMode: subIssueModeSchema.default("collapsed"),
  showOther: z.boolean().default(false),
});

/** `columns`, when sent, replaces the board's whole column list in order. */
export const boardPatchSchema = z
  .object({
    name: boardNameSchema,
    baseFilter: z.string(),
    columns: boardColumnsInputSchema,
    sort: sortSchema,
    subIssueMode: subIssueModeSchema,
    showOther: z.boolean(),
  })
  .partial()
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    {
      message:
        "Send at least one of name, baseFilter, columns, sort, subIssueMode and showOther",
    },
  );
