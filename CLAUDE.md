# Crossboard

## Agent workflow

<!-- Read by the vendored skills (orchestrate, triage, pr-review, security-audit).
     Keep these headings exactly; a subsection a repo doesn't need can be removed,
     and orchestrate then omits it from dispatches. Machine-read settings live in
     .claude/workflow.json, not here. -->

### Project

Crossboard is a self-hostable web app that shows every open GitHub issue across all repositories a user reaches through the Crossboard GitHub App (personal and organization repos) in one place, with cross-repo dependencies (blocked by / blocking), custom Kanban boards whose columns are filter queries, and GitHub's issue search syntax evaluated locally. v1 is strictly read-only against GitHub. Stack: TypeScript everywhere; one Node.js 24 process (Hono) serving a React + Vite SPA, SQLite through Drizzle, shipped as a single Docker container with one data volume; a pnpm workspace with `apps/server`, `apps/web` and `packages/query`. Users are developers and maintainers who self-host it; a hosted multi-tenant version may follow, so nothing may assume a single user.

### Design docs

`docs/SPEC.md` is the single source of truth: product scope, functional requirements (FR-n), GitHub integration, rate-limit strategy, architecture and repository layout (§7.2), HTTP API (§7.4), configuration (§7.5), data model (§8), milestones (M1–M9). Settled decisions are numbered D-n in its §13 with a date; open questions go to §14 with a recommended default. §5.5 lists GitHub behaviour that is not yet confirmed and the fallback to use until it is. When code and spec disagree, the spec wins until a decision changes it — change the spec in the same commit as the code, never silently diverge. Cite requirements as `SPEC FR-30` or `SPEC §6.2`, decisions as `D-4`.

### Area → paths

| Label | Paths |
|-------|-------|
| `area:server` | `apps/server/` (everything not claimed by a narrower area below) |
| `area:auth` | `apps/server/src/auth/`, `apps/server/src/security/` |
| `area:sync` | `apps/server/src/sync/`, `apps/server/src/webhooks/`, `apps/server/src/github/` |
| `area:db` | `apps/server/src/db/`, `apps/server/src/access/`, `**/migrations/` |
| `area:query` | `packages/query/` |
| `area:web` | `apps/web/`, `e2e/` |
| `area:ci` | `.github/`, `Dockerfile`, `docker-compose*.yml`, `.dockerignore`, `scripts/` |
| `area:docs` | `docs/`, `README.md` |

### Always-shared files

`CLAUDE.md`, `docs/SPEC.md`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, root `tsconfig*.json`, lint/format config, `.claude/workflow.json`, `.github/workflows/**`, `Dockerfile`, `apps/server/src/db/schema/**` and the migrations folder (one migration sequence for the whole app), `apps/web/components.json` and `apps/web/src/components/ui/**` (the vendored coss ui components).

### Entry points

- Server: `apps/server/src/index.ts` (process start, scheduler start) and the Hono app/route wiring it mounts (`/api/*`, `/webhooks/github`, auth routes, static SPA serving, health endpoint).
- Web: the SPA router in `apps/web/src/` — routes for the list view, boards, `/i/:owner/:repo/:number` and settings/setup.
- Query: the public exports of `packages/query` (consumed by both server and web).
- Packaging: `Dockerfile` and the example `docker-compose.yml`.

A capability is reachable only once it is wired into one of these; an unwired module is not done.

### Implementation rules

- **Read-only against GitHub in v1 (D-18).** No GraphQL mutation and no REST call that changes GitHub data anywhere in the server. The only non-`GET` calls are GraphQL queries and the credential exchanges D-18 lists (installation tokens, manifest conversion, OAuth code exchange and refresh). The App requests only Issues: read and Metadata: read.
- **Every GitHub call goes through the central rate-limit-aware client** (SPEC §6.5); nothing calls Octokit directly.
- **Every API query is scoped by the session user** via `user_repo_access`; issue data is stored once per repo, never "all issues in the DB" (SPEC §9.1).
- **DB access only through Drizzle**; no SQLite-specific SQL outside the migrations folder. Migrations are generated, never hand-edited after they are committed.
- **Rendered GitHub HTML is sanitized server-side** before it reaches the browser (SPEC FR-41, §9.3); the SPA never renders unsanitized HTML.
- **Configuration only via env vars** (12-factor), validated at startup; nothing reads `process.env` outside the config module.
- **Background work goes through the `jobs` interface** (in-process for v1).
- **Tokens and secrets are never logged**, nor webhook payload bodies of private repos at info level.
- The filter parser/evaluator lives only in `packages/query`; server and web never re-implement filter semantics.
- **UI is composed from coss ui (D-20).** Each UI element uses the component SPEC §10.1 maps to it, following the `coss` skill. Components are added to `apps/web/src/components/ui/` with the shadcn CLI, never written or restyled by hand there. An element the map does not cover goes to SPEC §14 first. Only the dependency graph SVG (FR-27) and the `markdown-body` container (FR-41) are hand-built.

### Risk review

For `safety-critical` items and `riskPaths` changes, the verifier checks:

- **Cross-user isolation:** a test proves a second user cannot see a repo, issue, board or saved view they lack access to through the changed route or query.
- **Tokens:** user tokens and App credentials are encrypted at rest (AES-256-GCM, key derived from `CROSSBOARD_APP_SECRET`, SPEC §9.3), refreshed before expiry, never returned to the browser and never logged.
- **Allowlist:** sign-in and syncing stay restricted to allowed users and active installations (SPEC FR-1–FR-3); a non-allowed account gets no session, token or user row.
- **Webhooks:** `X-Hub-Signature-256` is verified with a constant-time compare before any payload is parsed or applied; an invalid or missing signature is rejected with no side effect.
- **HTML:** every path that sends GitHub-rendered HTML to the browser passes through the sanitizer; a test with a script/`on*`-attribute payload proves it is stripped.
- **Sessions/CSRF:** cookies stay HTTP-only, `SameSite=Lax`, secure; state-changing routes reject a missing or foreign `Origin` header and non-JSON bodies (SPEC §9.3).
- **Migrations:** apply cleanly on an existing database with data (not only a fresh one) and never drop user-created data (boards, columns, saved views).
- **No GitHub writes:** the diff adds no GraphQL mutation and no non-`GET` REST call beyond the D-18 credential exchanges.
