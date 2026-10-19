import { http, HttpResponse } from "msw";
import { schema, type Db } from "../src/db/index.js";
import { encrypt } from "../src/security/index.js";
import { FAKE_API_URL } from "./github-fake.js";

export interface WorldInstallation {
  id: number;
  login: string;
  type?: "User" | "Organization";
  suspended?: boolean;
}

export interface WorldRepo {
  id: number;
  nodeId: string;
  owner: string;
  name: string;
  private?: boolean;
}

/** What GitHub says one user token can reach. */
export interface World {
  installations: WorldInstallation[];
  repos: Record<number, WorldRepo[]>;
  /** Installation ids whose repository listing answers 500. */
  failing?: number[];
}

export const installationPayload = (entry: WorldInstallation) => ({
  id: entry.id,
  app_id: 99,
  target_type: entry.type ?? "User",
  account: {
    id: 1000 + entry.id,
    login: entry.login,
    type: entry.type ?? "User",
  },
  suspended_at: entry.suspended === true ? "2026-01-01T00:00:00Z" : null,
  repository_selection: "all",
});

export const repoPayload = (repo: WorldRepo) => ({
  id: repo.id,
  node_id: repo.nodeId,
  name: repo.name,
  full_name: `${repo.owner}/${repo.name}`,
  owner: { id: 1, login: repo.owner },
  private: repo.private ?? false,
  archived: false,
  has_issues: true,
});

/** msw handlers that answer the two access endpoints per bearer token. */
export function accessHandlers(worlds: Record<string, World>) {
  const worldOf = (request: Request) =>
    worlds[(request.headers.get("authorization") ?? "").replace("Bearer ", "")];
  const bad = () =>
    HttpResponse.json({ message: "Bad credentials" }, { status: 401 });
  return [
    http.get(`${FAKE_API_URL}/user/installations`, ({ request }) => {
      const world = worldOf(request);
      if (world === undefined) return bad();
      return HttpResponse.json({
        total_count: world.installations.length,
        installations: world.installations.map(installationPayload),
      });
    }),
    http.get(
      `${FAKE_API_URL}/user/installations/:installationId/repositories`,
      ({ request, params }) => {
        const world = worldOf(request);
        if (world === undefined) return bad();
        const id = Number(params.installationId);
        if (world.failing?.includes(id) === true) {
          return HttpResponse.json({ message: "boom" }, { status: 500 });
        }
        const repos = world.repos[id];
        if (repos === undefined) {
          return HttpResponse.json({ message: "Not Found" }, { status: 404 });
        }
        return HttpResponse.json({
          total_count: repos.length,
          repositories: repos.map(repoPayload),
        });
      },
    ),
  ];
}

export function storeTokens(
  db: Db,
  appSecret: string,
  userId: number,
  tokens: {
    access: string;
    refresh?: string;
    accessExpiresAt?: number;
    refreshExpiresAt?: number;
  },
): void {
  db.insert(schema.userTokens)
    .values({
      userId,
      accessTokenEnc: encrypt(tokens.access, appSecret),
      accessExpiresAt: tokens.accessExpiresAt ?? Date.now() + 8 * 3_600_000,
      refreshTokenEnc: encrypt(tokens.refresh ?? "refresh", appSecret),
      refreshExpiresAt: tokens.refreshExpiresAt ?? Date.now() + 86_400_000,
      updatedAt: 1,
    })
    .run();
}
