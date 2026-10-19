import { eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod";
import { schema, type Db } from "../db/index.js";
import { GithubError, type InstallationClient } from "../github/index.js";
import type { GithubQuery } from "../github/query.js";
import { queries } from "../github/queries/index.js";
import { completeConnections } from "./connections.js";
import {
  CHUNK,
  chunks,
  deleteUnusedLabels,
  issueNodeSchema,
  toIssueData,
  writeIssues,
  type IssueData,
  type IssueNode,
} from "./issue-data.js";
import { createRemoval, type Removal } from "./remove.js";
import { writeRelations } from "./relations.js";

const { installations, issues, repos } = schema;

/** How many issues one `nodes(ids: [...])` query fetches (SPEC §6.3). */
export const REFETCH_BATCH = 50;

const nodeSchema = issueNodeSchema.extend({
  state: z.enum(["OPEN", "CLOSED"]),
});

type FetchedIssue = z.infer<typeof nodeSchema>;

interface Known {
  repoId: string;
  owner: string;
  name: string;
  installationId: number;
}

const responseSchema = z.object({ nodes: z.array(nodeSchema.nullable()) });

type Send = (
  query: GithubQuery,
  variables: Record<string, unknown>,
) => Promise<unknown>;

const rateLimitSchema = z.object({
  rateLimit: z.object({ cost: z.number() }),
});

export interface RefetchOptions {
  db: Db;
  installations: Pick<InstallationClient, "graphql">;
  /** Whether the installation is active now (SPEC FR-3). */
  isActive: (installationId: number) => boolean;
  logger: Logger;
  now?: () => number;
}

export interface Refetch extends Removal {
  /**
   * Refetches synced issues by node id with the SPEC §5.3 selection, in
   * batches of 50 grouped by the installation of each issue's repo and fetched
   * with that installation's token, and updates each one with its labels,
   * assignees, refs and edges. A result that is closed is removed as closed;
   * one that is `null` for its own installation as gone (SPEC §8.2), either of
   * which refetches the synced issues its removal affects in turn. Ids that are
   * not synced issues, and issues of an installation that is not active, are
   * left alone. A GitHub failure throws; whatever was fetched before it stays.
   * Resolves to the GraphQL cost of every query it sent, including those of the
   * refetches its removals needed.
   */
  refetch(ids: readonly string[]): Promise<number>;
}

/**
 * The issue refetch and, with it, the removal every path uses: removing an
 * issue refetches the synced issues it affects, and refetching can find an
 * issue closed or gone.
 */
export function createRefetch({
  db,
  installations: github,
  isActive,
  logger,
  now = Date.now,
}: RefetchOptions): Refetch {
  const removal = createRemoval({
    db,
    refetch: (ids) => refetch(ids),
  });

  const usable = (installationId: number): boolean => {
    const installation = db
      .select({ suspended: installations.suspended })
      .from(installations)
      .where(eq(installations.id, installationId))
      .get();
    return (
      installation !== undefined &&
      !installation.suspended &&
      isActive(installationId)
    );
  };

  /**
   * One `nodes` query. GitHub answers an id it cannot resolve with a `null`
   * node and a `NOT_FOUND` error, which the client raises as a failure of the
   * whole query; the ids are then split until the missing ones are alone.
   */
  async function fetchNodes(
    send: Send,
    ids: string[],
  ): Promise<Map<string, FetchedIssue | null>> {
    try {
      const data = responseSchema.parse(
        await send(queries.issuesByIds, { ids }),
      );
      if (data.nodes.length !== ids.length) {
        throw new Error("GitHub answered with a different number of nodes");
      }
      return new Map(ids.map((id, index) => [id, data.nodes[index] ?? null]));
    } catch (error) {
      if (!(error instanceof GithubError) || error.code !== "NOT_FOUND") {
        throw error;
      }
      const [only] = ids;
      if (only !== undefined && ids.length === 1) {
        return new Map([[only, null]]);
      }
      const middle = Math.ceil(ids.length / 2);
      return new Map([
        ...(await fetchNodes(send, ids.slice(0, middle))),
        ...(await fetchNodes(send, ids.slice(middle))),
      ]);
    }
  }

  async function refetch(requested: readonly string[]): Promise<number> {
    let total = 0;
    const ids = [...new Set(requested)];
    const known = new Map<string, Known>();
    for (const part of chunks(ids, CHUNK)) {
      for (const row of db
        .select({
          id: issues.id,
          repoId: issues.repoId,
          owner: repos.owner,
          name: repos.name,
          installationId: repos.installationId,
        })
        .from(issues)
        .innerJoin(repos, eq(issues.repoId, repos.id))
        .where(inArray(issues.id, part))
        .all()) {
        known.set(row.id, row);
      }
    }
    const byInstallation = new Map<number, string[]>();
    for (const [id, row] of known) {
      if (!usable(row.installationId)) {
        logger.debug(
          { installationId: row.installationId },
          "issue refetch skipped: the installation is not active",
        );
        continue;
      }
      byInstallation.set(row.installationId, [
        ...(byInstallation.get(row.installationId) ?? []),
        id,
      ]);
    }

    // Everything is fetched before anything is written, so a failure leaves
    // what is stored as it was.
    const open: { known: Known; node: IssueNode }[] = [];
    const closed: string[] = [];
    const gone: string[] = [];
    for (const [installationId, group] of byInstallation) {
      let cost = 0;
      const send: Send = async (query, variables) => {
        const data = await github.graphql(installationId, query, variables);
        const limit = rateLimitSchema.safeParse(data);
        if (limit.success) cost += limit.data.rateLimit.cost;
        return data;
      };
      const fetchedOpen: { known: Known; node: IssueNode }[] = [];
      for (const batch of chunks(group, REFETCH_BATCH)) {
        for (const [id, node] of await fetchNodes(send, batch)) {
          const row = known.get(id);
          if (row === undefined) continue;
          if (node === null) gone.push(id);
          else if (node.state === "CLOSED") closed.push(id);
          else fetchedOpen.push({ known: row, node });
        }
      }
      await completeConnections(
        send,
        fetchedOpen.map((entry) => entry.node),
      );
      open.push(...fetchedOpen);
      total += cost;
      logger.debug(
        { installationId, issues: group.length, cost },
        "issues refetched",
      );
    }

    if (open.length > 0) {
      const at = now();
      db.transaction((tx) => {
        const byRepo = new Map<string, { known: Known; data: IssueData[] }>();
        for (const entry of open) {
          const group = byRepo.get(entry.known.repoId) ?? {
            known: entry.known,
            data: [],
          };
          group.data.push(toIssueData(entry.node));
          byRepo.set(entry.known.repoId, group);
        }
        for (const [repoId, { known: repo, data }] of byRepo) {
          // A purge removes the repo while the issues are fetched.
          const present = tx
            .select({ id: repos.id })
            .from(repos)
            .where(eq(repos.id, repoId))
            .get();
          if (present === undefined) continue;
          writeIssues(tx, repoId, data, at);
          writeRelations(
            tx,
            `${repo.owner}/${repo.name}`,
            data,
            at,
            data.map((issue) => issue.id),
          );
          deleteUnusedLabels(tx, repoId);
        }
      });
    }
    total += await removal.remove(closed, "closed");
    total += await removal.remove(gone, "gone");
    return total;
  }

  return { refetch, remove: removal.remove };
}
