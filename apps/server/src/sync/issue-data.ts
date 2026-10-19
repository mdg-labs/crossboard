import { eq, inArray, notInArray, and, ne } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "../db/index.js";

const { issueAssignees, issueDeps, issueLabels, issues, labels } = schema;

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Keeps one statement under SQLite's bound-parameter limit. */
export const CHUNK = 200;

export const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
};

export const labelSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
});

export const assigneeSchema = z.object({
  login: z.string(),
  avatarUrl: z.string(),
});

/** An issue named inside another issue's relations. */
export const refSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED"]),
  url: z.string(),
  repository: z.object({ nameWithOwner: z.string() }),
});

export const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});

/** A connection's page; GitHub may leave a node `null`. */
export const connection = <T extends z.ZodType>(node: T) =>
  z.object({
    totalCount: z.number(),
    pageInfo: pageInfoSchema,
    nodes: z.array(node.nullable()),
  });

/** One issue as the SPEC §5.3 selection returns it. */
export const issueNodeSchema = z.object({
  id: z.string(),
  databaseId: z.number(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: z.object({ login: z.string() }).nullable(),
  issueType: z
    .object({ name: z.string(), color: z.string().nullable() })
    .nullable(),
  milestone: z.object({ title: z.string(), url: z.string() }).nullable(),
  labels: connection(labelSchema),
  assignees: connection(assigneeSchema),
  parent: refSchema.nullable(),
  subIssuesSummary: z.object({ total: z.number(), completed: z.number() }),
  issueDependenciesSummary: z.object({
    totalBlockedBy: z.number(),
    totalBlocking: z.number(),
  }),
  blockedBy: connection(refSchema),
  blocking: connection(refSchema),
});

export type IssueNode = z.infer<typeof issueNodeSchema>;

export interface LabelData {
  id: string;
  name: string;
  color: string;
  description: string | null;
}

export interface AssigneeData {
  login: string;
  avatarUrl: string;
}

/** An issue named by another, as `issue_refs` stores it. */
export interface RefData {
  id: string;
  repoFullName: string;
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  url: string;
}

/** An issue as stored: scalars, labels, assignees and relations. */
export interface IssueData {
  id: string;
  databaseId: number;
  number: number;
  title: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  authorLogin: string | null;
  typeName: string | null;
  typeColor: string | null;
  milestoneTitle: string | null;
  milestoneUrl: string | null;
  subTotal: number;
  subCompleted: number;
  blockedByTotal: number;
  blockingTotal: number;
  labels: LabelData[];
  assignees: AssigneeData[];
  parent: RefData | null;
  blockedBy: RefData[];
  blocking: RefData[];
}

const present = <T>(items: readonly (T | null)[]): T[] =>
  items.filter((item): item is T => item !== null);

export const toRefData = (node: z.infer<typeof refSchema>): RefData => ({
  id: node.id,
  repoFullName: node.repository.nameWithOwner,
  number: node.number,
  title: node.title,
  state: node.state,
  url: node.url,
});

export function toIssueData(node: IssueNode): IssueData {
  return {
    id: node.id,
    databaseId: node.databaseId,
    number: node.number,
    title: node.title,
    url: node.url,
    createdAt: Date.parse(node.createdAt),
    updatedAt: Date.parse(node.updatedAt),
    authorLogin: node.author?.login ?? null,
    typeName: node.issueType?.name ?? null,
    typeColor: node.issueType?.color ?? null,
    milestoneTitle: node.milestone?.title ?? null,
    milestoneUrl: node.milestone?.url ?? null,
    subTotal: node.subIssuesSummary.total,
    subCompleted: node.subIssuesSummary.completed,
    blockedByTotal: node.issueDependenciesSummary.totalBlockedBy,
    blockingTotal: node.issueDependenciesSummary.totalBlocking,
    labels: present(node.labels.nodes),
    assignees: present(node.assignees.nodes),
    parent: node.parent === null ? null : toRefData(node.parent),
    blockedBy: present(node.blockedBy.nodes).map(toRefData),
    blocking: present(node.blocking.nodes).map(toRefData),
  };
}

/**
 * Writes the issues with their labels and assignees into one repo, replacing
 * what each issue had. Labels are upserted by node id first; a label of the
 * repo that holds one of these names under another id is removed, so a label
 * that was deleted and recreated does not clash on the name.
 */
export function writeIssues(
  tx: Tx,
  repoId: string,
  data: readonly IssueData[],
  at: number,
): void {
  const seen = new Map<string, LabelData>();
  for (const issue of data) {
    for (const label of issue.labels) seen.set(label.id, label);
  }
  for (const label of seen.values()) {
    tx.delete(labels)
      .where(
        and(
          eq(labels.repoId, repoId),
          eq(labels.name, label.name),
          ne(labels.id, label.id),
        ),
      )
      .run();
    tx.insert(labels)
      .values({ ...label, repoId })
      .onConflictDoUpdate({
        target: labels.id,
        set: {
          name: label.name,
          color: label.color,
          description: label.description,
        },
      })
      .run();
  }

  for (const issue of data) {
    const { labels: issueLabelData, assignees } = issue;
    const scalars = {
      id: issue.id,
      databaseId: issue.databaseId,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      authorLogin: issue.authorLogin,
      typeName: issue.typeName,
      typeColor: issue.typeColor,
      milestoneTitle: issue.milestoneTitle,
      milestoneUrl: issue.milestoneUrl,
      parentId: issue.parent?.id ?? null,
      subTotal: issue.subTotal,
      subCompleted: issue.subCompleted,
      blockedByTotal: issue.blockedByTotal,
      blockingTotal: issue.blockingTotal,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    };
    tx.insert(issues)
      .values({ ...scalars, repoId, syncedAt: at })
      .onConflictDoUpdate({
        target: issues.id,
        set: { ...scalars, repoId, syncedAt: at },
      })
      .run();
    tx.delete(issueLabels).where(eq(issueLabels.issueId, issue.id)).run();
    if (issueLabelData.length > 0) {
      tx.insert(issueLabels)
        .values(
          issueLabelData.map((label) => ({
            issueId: issue.id,
            labelId: label.id,
          })),
        )
        .run();
    }
    tx.delete(issueAssignees).where(eq(issueAssignees.issueId, issue.id)).run();
    if (assignees.length > 0) {
      tx.insert(issueAssignees)
        .values(
          assignees.map((assignee) => ({ issueId: issue.id, ...assignee })),
        )
        .run();
    }
  }
}

/** Deletes the repo's labels that no issue carries any more. */
export function deleteUnusedLabels(tx: Tx, repoId: string): void {
  tx.delete(labels)
    .where(
      and(
        eq(labels.repoId, repoId),
        notInArray(
          labels.id,
          tx.select({ id: issueLabels.labelId }).from(issueLabels),
        ),
      ),
    )
    .run();
}

/** The ids of the repo's stored issues. */
export function storedIssueIds(tx: Tx, repoId: string): string[] {
  return tx
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.repoId, repoId))
    .all()
    .map((row) => row.id);
}

/**
 * Deletes issues by id; their labels, assignees and details cascade, and so
 * do the dependency rows where they are the blocked side.
 */
export function deleteIssues(tx: Tx, ids: readonly string[]): void {
  for (const part of chunks(ids, CHUNK)) {
    tx.delete(issueDeps).where(inArray(issueDeps.blockedId, part)).run();
    tx.delete(issues).where(inArray(issues.id, part)).run();
  }
}
