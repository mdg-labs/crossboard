# Roadmap

**This file is a one-shot seed.** `scripts/roadmap-sync.py` files every entry below as a GitHub issue, with native sub-issue parents, blocked-by links and one milestone per SPEC §11 milestone, and then deletes this file. From then on the issues are the plan; `docs/SPEC.md` stays the source of truth.

Format: a ```` ```epic ```` block marks an entry with children, a ```` ```meta ```` block a leaf. `parent:` and `depends:` are the only relations; children inherit their top epic's milestone. Heading depth is for reading only. Ids are stable handles, not an order.

```milestones
M1: M1 — Skeleton
M2: M2 — Auth + access
M3: M3 — Initial sync
M4: M4 — Query engine
M5: M5 — List view
M6: M6 — Detail view
M7: M7 — Boards
M8: M8 — Freshness
M9: M9 — Release
```

## M1 — Skeleton

```epic
id: M1
milestone: M1
labels: [area:server, area:web, area:query, area:db, area:ci, area:docs]
depends: []
```

**Done when** Workspace with the three packages, config module, logging, DB with migration runner, `/api/health`, SPA shell served by the server, Dockerfile, CI running the gate, threat model written (`docs/THREAT_MODEL.md`, in the format of the vendored security-audit skill, so it can be enabled)

**Summary** Stand up the pnpm workspace, the server process with validated configuration, logging and a migrated SQLite database, the coss ui SPA shell served by that process, the container image, CI running the gate and the Docker build, and the threat model.

**Design references** SPEC §7, §7.1, §7.2, §7.5, §7.6, §8.1, §9.3, §10.1, SPEC §11 M1, D-8, D-17, D-20, CLAUDE.md `## Agent workflow`

**Goal** One container built by CI serves `/api/health` and the empty SPA shell from a migrated database; every later item lands on CI that runs `pnpm gate` (lint, typecheck, tests, build) and the Docker build; the security audit can be enabled against the threat model.

**Out of scope** Authentication, setup and sessions (SPEC §11 M2); GitHub calls of any kind; the filter language beyond an empty package (SPEC §11 M4); the release workflow and GHCR (SPEC §11 M9).

### Scaffold the pnpm workspace with the server, web and query packages

```meta
id: M1.1
parent: M1
labels: [chore, area:server, area:web, area:query]
depends: []
```

**Summary** Create the pnpm 10 workspace with `apps/server` (`@crossboard/server`), `apps/web` (`@crossboard/web`) and `packages/query` (`@crossboard/query`), strict TypeScript, ESLint, Prettier, Vitest and the root `gate` script, so every package lints, typechecks, tests and builds from a clean clone.

**Design references** SPEC §7.1 (stack, lint and format, testing), SPEC §7.2 (layout and scripts), D-8, CLAUDE.md `### Implementation rules`

**Current state** nothing yet: the repository holds only `docs/`, `.claude/`, `.agents/`, `.github/`, `scripts/`, `README.md`, `LICENSE` and `CLAUDE.md`.

**Acceptance criteria**
- [ ] `pnpm install --frozen-lockfile` and `pnpm gate` succeed from a clean clone; `pnpm-workspace.yaml` lists `apps/*`, `packages/*` and `e2e`
- [ ] Node 24 is pinned by `.nvmrc` and `engines`, pnpm 10 by the root `packageManager` field; every package is ES modules and private
- [ ] the shared `tsconfig` base is `strict` with `noUncheckedIndexedAccess`; each package extends it
- [ ] ESLint flat config with `typescript-eslint` strict and Prettier with default settings cover the whole workspace and ignore `apps/web/src/components/ui/`; `pnpm format:check` fails on an unformatted file
- [ ] every package has `lint`, `typecheck` and `test` scripts (and `build` where it builds), each with one passing Vitest test; `apps/web` builds a placeholder page with Vite; the root has `lint`, `typecheck`, `test`, `build`, `format:check` and `gate` (all of them in sequence)
- [ ] `packages/query` declares no runtime `dependencies`
- [ ] `.gitignore` covers `node_modules`, build output and local data directories
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** The config module and logging (owned by "Validate configuration at startup and log as JSON"); the database (owned by "Open the SQLite database and apply migrations at startup"); server routes (owned by "Serve the health endpoint and the built SPA from the server"); the SPA shell (owned by "Build the SPA shell with coss ui"); the `e2e` package (owned by "Add the fake GitHub server and the sign-in end-to-end test").

**Scope hint** `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.nvmrc`, `.gitignore`, `apps/server/`, `apps/web/`, `packages/query/` · ~300 changed lines (excluding the lockfile) · Expected files: 20 reviewable

### Validate configuration at startup and log as JSON

```meta
id: M1.2
parent: M1
labels: [feat, area:server]
depends: [M1.1]
```

**Summary** Add `apps/server/src/config/`, the only module that reads `process.env`, validating every SPEC §7.5 variable with Zod at startup, and a `pino` logger writing JSON to stdout that never prints secrets.

**Design references** SPEC §7.5, FR-1, FR-50, FR-51, SPEC §9.3 (logging), §7.1 (Zod 4, pino), CLAUDE.md `### Implementation rules` (configuration, secrets)

**Current state** `apps/server` exists with a placeholder entry and one test.

**Acceptance criteria**
- [ ] every variable of the SPEC §7.5 table is parsed with its default; `CROSSBOARD_PUBLIC_URL` must be a URL; `CROSSBOARD_APP_SECRET` must be at least 32 characters
- [ ] `CROSSBOARD_RECONCILE_INTERVAL_MIN` defaults to 15, or to 2 when `CROSSBOARD_WEBHOOKS=false` (FR-51)
- [ ] the process refuses to start when both `CROSSBOARD_ALLOWED_USERS` and `CROSSBOARD_ALLOWED_ORGS` are empty (FR-1); allowlists are split on commas, trimmed and compared case-insensitively
- [ ] the six `GITHUB_*` App credential variables are all-or-none: a partial set stops the process (FR-50)
- [ ] an invalid or missing value stops the process with a message that names the variable and never its value (test with a sentinel secret)
- [ ] a lint rule forbids `process.env` outside `apps/server/src/config/`
- [ ] the `pino` logger honours `LOG_LEVEL` and redacts token, secret, cookie and authorization fields (test with a sentinel value)
- [ ] Reachable via: `apps/server/src/index.ts` loads the config and creates the logger before anything else
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Using the App credentials (owned by "Create the instance's GitHub App from a manifest"); the HTTP listener (owned by "Serve the health endpoint and the built SPA from the server").

**Scope hint** `apps/server/src/config/`, `apps/server/src/index.ts`, `apps/server/src/logger.ts`, `eslint.config.js` · ~250 changed lines · Expected files: 7 reviewable

### Open the SQLite database and apply migrations at startup

```meta
id: M1.3
parent: M1
labels: [feat, area:db, safety-critical]
depends: [M1.2]
```

**Summary** Add the Drizzle schema for every SPEC §8.1 table, the generated first migration, a migration test harness, and a startup step that opens `crossboard.db` in WAL mode with foreign keys on and applies pending migrations.

**Design references** SPEC §8.1, §8.2, §7.1 (DB), §7.2 (`src/db/schema/`, `src/db/migrations/`), §9.1, CLAUDE.md `### Implementation rules` (Drizzle only, generated migrations), CLAUDE.md `### Risk review` (migrations)

**Current state** `apps/server/src/index.ts` loads config and the logger; no database yet.

**Acceptance criteria**
- [ ] `apps/server/src/db/schema/` defines every table, column, primary key, unique constraint and foreign key of SPEC §8.1; foreign keys cascade on delete except where §8.1 says otherwise (`issue_deps` has no foreign key to `issues`)
- [ ] the first migration is generated by `drizzle-kit` into `apps/server/src/db/migrations/` and not hand-edited; `drizzle-kit check` passes
- [ ] the database is `<CROSSBOARD_DATA_DIR>/crossboard.db`, opened with `better-sqlite3`, WAL mode and `foreign_keys = ON`
- [ ] pending migrations are applied at startup before anything else touches the database; a failing migration stops the process with a non-zero exit; a restart applies nothing twice
- [ ] a migration test harness seeds rows into every table at one migration and migrates to the latest, asserting no row of `boards`, `board_columns` or `saved_views` is lost; every later schema change adds its case to it
- [ ] a test helper creates a temporary database file with all migrations applied for integration tests
- [ ] no SQLite-specific SQL exists outside the migrations folder
- [ ] Reachable via: `apps/server/src/index.ts` runs the migrations after loading config
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Data access for any feature (owned by the items that use each table); access scoping helpers (owned by "Compute each user's installation and repository access").

**Scope hint** `apps/server/src/db/`, `apps/server/drizzle.config.ts`, `apps/server/src/index.ts` · ~380 changed lines (excluding generated migrations) · Expected files: 11 reviewable

### Serve the health endpoint and the built SPA from the server

```meta
id: M1.4
parent: M1
labels: [feat, area:server]
depends: [M1.3]
```

**Summary** Add the Hono app with `GET /api/health`, the JSON error format, request validation through `@hono/zod-validator`, static serving of the built `apps/web` with a client-route fallback, and the HTTP listener.

**Design references** SPEC §7, §7.1 (Hono, Zod 4, `@hono/zod-validator`), §7.2 (`src/app.ts`, `src/index.ts`), §7.4 (`/api/health`, error shape)

**Current state** `apps/server/src/index.ts` loads config and the logger and applies migrations; there is no HTTP listener and no `app.ts`; `apps/web` builds a placeholder page.

**Acceptance criteria**
- [ ] `apps/server/src/app.ts` builds the Hono app and exports `AppType`; `apps/server/src/index.ts` starts the listener on `PORT` after migrations
- [ ] `GET /api/health` answers `{ status: "ok", version }` without auth, `version` being the server package's version
- [ ] errors use `{ "error": { "code", "message" } }`; unknown `/api/*` routes answer `404` in that shape; a request failing its Zod schema answers `400` in that shape through one shared `@hono/zod-validator` helper that every later route uses
- [ ] the server serves the built `apps/web` files and answers any other non-API `GET` with `index.html`, so client-side routes load on refresh
- [ ] tests: the health route, the `404` and `400` shapes, static serving and the fallback
- [ ] Reachable via: `apps/server/src/index.ts` → `apps/server/src/app.ts` → `GET /api/health` and `GET /`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** The SPA shell itself (owned by "Build the SPA shell with coss ui"); security headers and CSRF (owned by "Keep server-side sessions and protect state-changing routes").

**Scope hint** `apps/server/src/app.ts`, `apps/server/src/index.ts`, `apps/server/src/api/`, `apps/server/test/` · ~250 changed lines · Expected files: 7 reviewable

### Build the SPA shell with coss ui

```meta
id: M1.8
parent: M1
labels: [feat, area:web]
depends: [M1.4]
```

**Summary** Set up the React SPA with TanStack Router and Query, Tailwind CSS 4 and coss ui, bundled fonts and `lucide-react`, rendering the top bar and an empty main area, typed against the server through `hc<AppType>`.

**Design references** SPEC §7.1 (frontend), §10 (layout, light and dark mode), §10.1 (Top bar), §9.3 (CSP), D-13, D-20, the `coss` skill (`.agents/skills/coss`, `references/cli.md`, `references/rules/styling.md`)

**Current state** `apps/web` builds a placeholder page that the server serves at `/`.

**Acceptance criteria**
- [ ] coss ui is initialised with the shadcn CLI (`@coss/style`): `apps/web/components.json` exists, components are added to `apps/web/src/components/ui/` by the CLI only, and the Tailwind CSS 4 theme tokens come from coss
- [ ] Inter and Geist Mono are bundled from npm font packages and wired to `--font-sans`, `--font-heading` and `--font-mono`; no font, stylesheet or script is loaded from another origin
- [ ] the app root wraps its tree in Base UI's `CSPProvider` with `disableStyleElements`, and the scrollbar CSS it would have injected is in the app stylesheet; with the SPEC §9.3 CSP the shell renders with no CSP violation in the browser console
- [ ] `apps/web/src/router.tsx` defines code-based TanStack Router routes; `apps/web/src/routes/index.tsx` renders an empty main area; TanStack Query and `hc<AppType>` live in `apps/web/src/lib/`
- [ ] the top bar (`apps/web/src/components/top-bar/`) uses the SPEC §10.1 components (Toolbar, Group) with empty slots for the filter, switcher, sync status and user menu
- [ ] light and dark follow the system; the layout targets widths of 1024 px and more, with no mobile layout (D-13); icons come from `lucide-react`
- [ ] a component test renders the shell
- [ ] Reachable via: `apps/server/src/app.ts` serves the built SPA → `apps/web/src/router.tsx` → `/`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Any real view (owned by "Show open issues in a virtualized list" and the later view items); the sign-in redirect (owned by "Keep server-side sessions and protect state-changing routes").

**Scope hint** `apps/web/src/main.tsx`, `apps/web/src/router.tsx`, `apps/web/src/routes/index.tsx`, `apps/web/src/components/top-bar/`, `apps/web/src/lib/`, `apps/web/src/styles.css`, `apps/web/components.json`, `apps/web/package.json` · ~300 changed lines (excluding vendored components) · Expected files: 12 reviewable

### Package the server and SPA as a Docker image

```meta
id: M1.5
parent: M1
labels: [chore, area:ci]
depends: [M1.8]
```

**Summary** Add a multi-stage `Dockerfile`, `.dockerignore` and an example `docker-compose.yml` producing one image that runs the server, serves the SPA and stores its database on the `/data` volume.

**Design references** SPEC §7.1 (packaging), §7.5, §1, D-8

**Current state** nothing yet

**Acceptance criteria**
- [ ] the `Dockerfile` is multi-stage on Node 24 slim, builds the workspace and runs the server as a non-root user on port 3000, with `/data` as a volume and `CROSSBOARD_DATA_DIR=/data`
- [ ] `HEALTHCHECK` calls `/api/health`
- [ ] the image builds for `linux/amd64` and `linux/arm64` with `docker buildx`
- [ ] `docker-compose.yml` runs the image with a named volume for `/data` and lists the required variables with placeholder values only (`<your app secret>`), never a real or token-shaped value
- [ ] `.dockerignore` keeps `node_modules`, `.git`, `.claude`, `.agents` and local data out of the build context
- [ ] a container started from the image with valid env answers `/api/health` and serves the SPA shell
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Publishing the image (owned by "Publish the image to GHCR from a release workflow"); CI (owned by "Run the gate and the Docker build in CI").

**Scope hint** `Dockerfile`, `.dockerignore`, `docker-compose.yml` · ~120 changed lines · Expected files: 3 reviewable

### Run the gate and the Docker build in CI

```meta
id: M1.6
parent: M1
labels: [chore, area:ci, safety-critical]
depends: [M1.5]
```

**Summary** Add `.github/workflows/ci.yml` that installs the workspace, runs `pnpm gate` and builds the Docker image on the self-hosted runner for pushes to `dev` and `main` and for pull requests.

**Design references** SPEC §7.6 (CI), §7.2 (`gate`), `.claude/workflow.json` `githubRunner`, `gate` and `checks`

**Current state** `.github/workflows/` holds only `issue-status.yml`; `.github/actionlint.yaml` exists.

**Acceptance criteria**
- [ ] `ci.yml` runs on `push` to `dev` and `main` and on `pull_request`, on `[self-hosted, runners01]`
- [ ] steps: checkout, pnpm install with `--frozen-lockfile`, `pnpm gate`, `docker build`
- [ ] the workflow's `permissions` are `contents: read` only; actions are pinned to a full commit SHA
- [ ] a failing lint, typecheck, test, build or Docker build fails the run
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** The Playwright job (owned by "Add the fake GitHub server and the sign-in end-to-end test"); the release workflow (owned by "Publish the image to GHCR from a release workflow").

**Scope hint** `.github/workflows/ci.yml` · ~70 changed lines · Expected files: 1 reviewable

### Write the threat model

```meta
id: M1.7
parent: M1
labels: [docs, area:docs]
depends: []
```

**Summary** Write `docs/THREAT_MODEL.md` for Crossboard in the security-audit format (D-17), so the security audit can be enabled once the file exists.

**Design references** D-17, D-3, D-4, D-18, D-20, SPEC §4.1, §4.8, §5.2, §6.2, §8.2, §9, §9.3, CLAUDE.md `### Risk review`, `.claude/rules/mdg-security.md`, `.claude/workflow.json` `riskPaths`

**Current state** nothing yet; `.claude/workflow.json` has `"threatModel": null`.

**Constraints** The format (from the security-audit skill in mdg-labs/skills), which this item must follow exactly: `##` headings numbered and ordered as below; the text after each number is free.
- `## 1. Assets`: what an attacker wants (data, secrets, availability, the host). Every finding's impact names one.
- `## 2. Attackers`: one `### 2.<n> <name>` per attacker with its capability (what it can and cannot already do). One of them is the trust ceiling, whose by-design abilities are never a finding.
- `## 3. Entry points, mapped to code`: every place outside input arrives, each with a **bold name** and the repo paths that own it (listener, handlers, outbound fetches, CI).
- `## 4. Security invariants`: numbered `T1`, `T2`, …, never reused or renumbered.
- `## 5. Accepted residuals`: numbered risks accepted on purpose, each with its reason.
- `## 6. Severity rubric`: `critical`, `high`, `medium`, `low`, `info` defined by outcome and attacker, followed by anti-inflation rules (a path needing the trust ceiling, a capability the attacker lacks, a developer flag, a mock or a test helper is not Critical or High), ideally with worked examples.
- `## 7. Disclosure split`: where a confirmed finding goes and how outside reports arrive.
Sections 1–6 are pasted verbatim into audit agents, so they must be self-contained and must not refer to other documents for their meaning.

**Acceptance criteria**
- [ ] `docs/THREAT_MODEL.md` has exactly the seven numbered sections of the format above, in order
- [ ] §1 covers at least: user and installation tokens, App credentials and `CROSSBOARD_APP_SECRET`, private-repo issue data, boards and saved views, sessions, the host and availability
- [ ] §2 covers at least: an anonymous internet client, a GitHub user who is not allow-listed, a signed-in allowed user trying to read another user's data or repos they lack access to, a forged webhook sender, a malicious issue author on a synced repo (rendered HTML), and the operator as the trust ceiling
- [ ] §3 maps every entry point of SPEC §7.4 (setup, auth, `/api/*`, `/webhooks/github`), the outbound GitHub client, the SPA's rendering of sanitized HTML and CI workflows to their SPEC §7.2 paths
- [ ] §4 has an invariant for each item of CLAUDE.md `### Risk review` (cross-user isolation, tokens, allowlist, webhook signatures, HTML sanitizing, sessions and CSRF, migrations, no GitHub writes per D-18), for the setup token, and for the CSP staying free of inline styles and scripts (D-20)
- [ ] §7 states that while the repository is private, Critical and High findings are filed as `security` items per `.claude/rules/mdg-security.md`, and that from going public (D-5) they become draft private security advisories
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Setting `threatModel` in `.claude/workflow.json` and vendoring the security-audit skill: the maintainer does that by re-running the workflow setup once this file has landed.

**Scope hint** `docs/THREAT_MODEL.md` · ~250 changed lines · Expected files: 1 reviewable

## M2 — Auth + access

```epic
id: M2
milestone: M2
labels: [area:auth, area:server, area:db, area:web]
depends: [M1]
```

**Done when** Setup flow (manifest and env), sign-in, sessions, allowlist, access computation, installations in settings

**Summary** A fresh instance is set up through the GitHub App manifest (or env credentials), allowed users sign in with GitHub into server-side sessions, and each user's installation and repository access is computed and shown on the settings page.

**Design references** SPEC §4.1, §4.8, §5.1, §5.2, §7.3, §7.4, §9.3, §10.1, D-3, D-4, D-18, D-19, D-20, SPEC §11 M2

**Goal** An operator creates the instance's App from `/setup`, an allowed user signs in and sees on `/settings` which accounts have the App installed and which are active, and a non-allowed account gets no session, token or user row.

**Product rules** Tokens and App secrets are stored only as ciphertext, never reach the browser and are never logged; every state-changing route checks `Origin` and a JSON content type; the only non-`GET` GitHub calls are the D-18 credential exchanges.

**Out of scope** Repository discovery and issue sync (SPEC §11 M3); webhook intake and webhook-triggered access recomputation (SPEC §11 M8).

### Add the jobs interface with an in-process queue and scheduler

```meta
id: M2.1
parent: M2
labels: [feat, area:server]
depends: [M1.4]
```

**Summary** Add `apps/server/src/jobs/` with `enqueue(name, payload, { key?, delayMs? })` and `schedule(name, intervalMs)`, implemented as an in-process async queue with per-installation concurrency, started and stopped with the process.

**Design references** SPEC §7.3, §6.1 (concurrency), §9.1, CLAUDE.md `### Implementation rules` (background work)

**Current state** nothing yet

**Acceptance criteria**
- [ ] handlers are registered by name; `enqueue` runs a payload through its handler; `delayMs` delays it
- [ ] a `key` deduplicates pending jobs: enqueueing the same key while one is pending keeps one job
- [ ] jobs carrying an installation id run at most 2 at a time per installation and 4 overall; others queue
- [ ] a job is marked as background or interactive when enqueued, so later guardrails can act on background jobs only
- [ ] `schedule` runs a named job every `intervalMs`; a run still in progress is not started twice
- [ ] a failing handler is logged and does not stop the queue; jobs are not persisted
- [ ] Reachable via: `apps/server/src/index.ts` starts the scheduler after migrations and stops it on `SIGTERM`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Concrete jobs (owned by the items that add them, starting with "Keep server-side sessions and protect state-changing routes"); deriving work from DB state at startup (owned by "Sync a repository's open issues, labels and assignees"); pausing jobs (owned by "Pause background sync for suspended or low-budget installations").

**Scope hint** `apps/server/src/jobs/`, `apps/server/src/index.ts` · ~230 changed lines · Expected files: 4 reviewable

### Add the central GitHub client for REST and OAuth calls

```meta
id: M2.2
parent: M2
labels: [feat, area:sync]
depends: [M1.4]
```

**Summary** Add `apps/server/src/github/` as the one place that talks to GitHub, starting with REST calls under a user token, the OAuth exchanges and the manifest conversion, with base URLs from config and `msw` fakes for server tests.

**Design references** SPEC §6.5, §5.2, §7.1 (`octokit`, `msw`), §7.5 (`CROSSBOARD_GITHUB_API_URL`, `CROSSBOARD_GITHUB_WEB_URL`), D-4, D-14, D-18, CLAUDE.md `### Implementation rules`

**Current state** nothing yet

**Acceptance criteria**
- [ ] the client exposes typed functions for `GET /user`, `GET /user/installations`, `GET /user/installations/{id}/repositories` (paginated), the OAuth code exchange and refresh, and the manifest conversion; the App's client id and secret are passed in by the caller, not read here
- [ ] API and web base URLs come from config, so tests and the fake GitHub can redirect them
- [ ] the only non-`GET` calls are the D-18 credential exchanges; a unit test lists the client's methods and fails if one sends another non-`GET` REST call
- [ ] each call is logged at `debug` without the token or response body; errors carry status and GitHub's message, never the token
- [ ] server tests use `msw` handlers for these endpoints; no test reaches the real GitHub
- [ ] a lint rule forbids importing Octokit outside `apps/server/src/github/`
- [ ] Reachable via: `apps/server/src/index.ts` creates the client from config and passes it to `apps/server/src/app.ts`, where route modules receive it
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Installation tokens and GraphQL (owned by "Authenticate as the App and query GraphQL with installation tokens"); budget tracking and concurrency limits (owned by "Track rate-limit budgets and limit concurrency in the GitHub client"); the callers (owned by "Sign users in with GitHub and enforce the allowlist" and "Create the instance's GitHub App from a manifest").

**Scope hint** `apps/server/src/github/`, `apps/server/src/index.ts`, `apps/server/src/app.ts`, `eslint.config.js`, `apps/server/test/` · ~300 changed lines · Expected files: 9 reviewable

### Gate a fresh instance behind a one-time setup token

```meta
id: M2.3
parent: M2
labels: [feat, area:auth, safety-critical]
depends: [M1.4]
```

**Summary** With no App credentials, the server generates and logs a setup token at start, serves only the setup routes and `/api/health`, and exchanges a correct token for a signed 30-minute setup cookie; also adds the encryption-at-rest helper and the `Origin`/JSON check every state-changing route reuses.

**Design references** FR-47, FR-48, D-19, SPEC §9.3 (encryption at rest, cookies, CSRF), §8.1 (`app_config`), §4.8, D-3, CLAUDE.md `### Risk review` (tokens, sessions and CSRF)

**Current state** nothing yet

**Acceptance criteria**
- [ ] `apps/server/src/security/` encrypts with AES-256-GCM, a random 12-byte IV per value and a key derived from `CROSSBOARD_APP_SECRET` with HKDF-SHA256 (info `crossboard-encryption-v1`), stored as `v1:<iv>:<ciphertext>:<tag>` in base64url; tampered ciphertext and a different secret fail to decrypt (tests)
- [ ] with neither env credentials nor stored ones, each start generates a random setup token, stores only its hash in `app_config` (replacing the previous one) and logs the token at `warn`
- [ ] in that state every request except `/setup`, `/setup/*` (including `GET /setup/callback`), `/api/setup/*`, static assets and `/api/health` redirects to `/setup`
- [ ] `POST /api/setup/token` with `{ token }` sets an HTTP-only `SameSite=Lax` cookie (`Secure` except on `http://localhost`), signed with an HMAC key derived from `CROSSBOARD_APP_SECRET` and valid 30 minutes; a wrong token answers `401` and sets nothing; the comparison is constant-time; a test asserts the `Set-Cookie` attributes
- [ ] `apps/server/src/security/` provides the check that rejects a missing or foreign `Origin` (against `CROSSBOARD_PUBLIC_URL`) and a non-JSON body; `POST /api/setup/token` uses it (tests for both rejections)
- [ ] Reachable via: `apps/server/src/app.ts` mounts the setup gate and `POST /api/setup/token`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** The manifest and callback (owned by "Create the instance's GitHub App from a manifest"); the `/setup` page (owned by "Guide the operator through first-run setup on the setup page"); applying the `Origin`/JSON check to session routes (owned by "Keep server-side sessions and protect state-changing routes").

**Scope hint** `apps/server/src/security/`, `apps/server/src/auth/setup/`, `apps/server/src/app.ts` · ~320 changed lines · Expected files: 9 reviewable

### Create the instance's GitHub App from a manifest

```meta
id: M2.4
parent: M2
labels: [feat, area:auth, safety-critical]
depends: [M2.2, M2.3]
```

**Summary** Behind the setup cookie, `POST /api/setup/manifest` builds the GitHub App manifest and `GET /setup/callback` exchanges the returned code and stores the credentials encrypted, after which setup closes; env credentials take precedence and skip setup entirely.

**Design references** FR-48, FR-49, FR-50, SPEC §5.1 (permissions and events), §4.8, §9.3 (encryption, CSRF), D-3, D-18, CLAUDE.md `### Risk review` (tokens)

**Current state** the setup gate, setup cookie, encryption helper and `Origin`/JSON check exist in `apps/server/src/security/` and `apps/server/src/auth/setup/`.

**Acceptance criteria**
- [ ] `POST /api/setup/manifest` (setup cookie required, `Origin`/JSON check applied) takes the owning account (personal or org login) and App name (default `Crossboard (<host>)`) and returns the manifest, the target URL (`/settings/apps/new` or `/organizations/<org>/settings/apps/new`) and a random `state` also stored in the setup cookie
- [ ] the manifest sets every field FR-48 lists, with `default_permissions` `issues: read`, `metadata: read` and `default_events` from SPEC §5.1; a test asserts the full manifest
- [ ] `GET /setup/callback` rejects a missing or mismatched `state` and a missing setup cookie with no side effect; otherwise it exchanges the code via the manifest conversion and stores `id`, `slug`, `client_id`, `client_secret`, `webhook_secret` and `pem` encrypted in `app_config`, then redirects to `/settings`
- [ ] a test with sentinel values proves `client_secret`, `webhook_secret` and `pem` are stored only as ciphertext and appear in no log line and no response
- [ ] after a successful callback the setup routes answer `404` until the stored credentials are deleted
- [ ] `apps/server/src/auth/credentials.ts` returns the App credentials from all six `GITHUB_*` variables when set (they take precedence and setup is never served, FR-50), otherwise from `app_config`
- [ ] Reachable via: `apps/server/src/app.ts` mounts `POST /api/setup/manifest` and `GET /setup/callback`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** The `/setup` page (owned by "Guide the operator through first-run setup on the setup page"); sign-in (owned by "Sign users in with GitHub and enforce the allowlist").

**Scope hint** `apps/server/src/auth/setup/`, `apps/server/src/auth/credentials.ts`, `apps/server/src/app.ts` · ~320 changed lines · Expected files: 8 reviewable

### Guide the operator through first-run setup on the setup page

```meta
id: M2.10
parent: M2
labels: [feat, area:web]
depends: [M2.4, M1.8]
```

**Summary** Add the SPA's `/setup` route: the operator enters the setup token, then the owning account and App name, and the page submits the manifest form to GitHub.

**Design references** FR-47, FR-48, FR-49, SPEC §4.8, §9.3 (CSP `form-action`), §10.1 (First-run setup steps), D-19, D-20, the `coss` skill (`references/primitives/form.md`, `field.md`)

**Current state** the setup routes exist on the server; the SPA has no `/setup` route.

**Acceptance criteria**
- [ ] step one posts the token to `POST /api/setup/token` and shows a wrong-token error; step two asks for the owning account and the App name (prefilled `Crossboard (<host>)`), calls `POST /api/setup/manifest` and submits the returned manifest as a form `POST` to the returned GitHub URL
- [ ] both steps use the SPEC §10.1 components (Card, Form, Field, Input, Button) and show loading and error states (component tests)
- [ ] Reachable via: `apps/web/src/router.tsx` → `apps/web/src/routes/setup.tsx`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** none

**Scope hint** `apps/web/src/routes/setup.tsx`, `apps/web/src/router.tsx` · ~200 changed lines · Expected files: 4 reviewable

### Keep server-side sessions and protect state-changing routes

```meta
id: M2.5
parent: M2
labels: [feat, area:auth, area:web, safety-critical]
depends: [M2.1, M2.3, M1.8]
```

**Summary** Add session rows referenced by a hashed cookie token with sliding 30-day expiry, the session middleware for `/api/*`, sign-out, the daily cleanup job, the SPA's redirect to sign-in, CSRF protection on every state-changing route and the CSP header.

**Design references** FR-5, FR-6, FR-10a, SPEC §7.4 (auth requirement), §9.3 (cookies, CSRF, CSP), §8.1 (`sessions`, `user_tokens`), D-20, CLAUDE.md `### Risk review` (sessions and CSRF)

**Current state** the `Origin`/JSON check exists in `apps/server/src/security/` and guards the setup routes only.

**Acceptance criteria**
- [ ] a session is a random 32-byte token in the HTTP-only, `SameSite=Lax` cookie `crossboard_session` (`Secure` except on `http://localhost`); only its SHA-256 hash is stored; a test asserts the `Set-Cookie` attributes
- [ ] sessions expire after 30 days of inactivity; `last_seen_at` and `expires_at` advance at most once per hour
- [ ] every `/api/*` route except `/api/health` and `/api/setup/*` answers `401` without a valid session
- [ ] `POST /auth/logout` deletes the session; when the user has no session left, their `user_tokens` row is deleted too
- [ ] a daily job (jobs interface) deletes expired sessions, then the tokens of users left without a session
- [ ] every `POST`, `PATCH` and `DELETE` except `/webhooks/github` goes through the existing `Origin`/JSON check (tests on a session route)
- [ ] every response carries the CSP of SPEC §9.3
- [ ] an SPA route loaded without a session redirects to `/auth/login?return=<path>`; only same-origin relative paths are kept (test with an absolute and a protocol-relative `return`)
- [ ] Reachable via: `apps/server/src/app.ts` mounts the session and CSRF middleware and `POST /auth/logout`; `apps/web/src/router.tsx` redirects
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Creating sessions at sign-in (owned by "Sign users in with GitHub and enforce the allowlist").

**Scope hint** `apps/server/src/auth/sessions/`, `apps/server/src/security/`, `apps/server/src/app.ts`, `apps/web/src/router.tsx` · ~330 changed lines · Expected files: 10 reviewable

### Sign users in with GitHub and enforce the allowlist

```meta
id: M2.6
parent: M2
labels: [feat, area:auth, area:web, safety-critical]
depends: [M2.2, M2.4, M2.5]
```

**Summary** `GET /auth/login` and `GET /auth/callback` run the App's OAuth web flow; the callback admits only allowed users, stores their tokens encrypted and creates a session, and anyone else lands on a "not allowed" page with nothing stored.

**Design references** FR-1, FR-2, FR-4, FR-7, FR-10a, SPEC §5.2, §9.3, §10.1 (not allowed page), D-3, D-4, D-18, D-20, CLAUDE.md `### Risk review` (allowlist, tokens)

**Current state** sessions, the credential accessor (`apps/server/src/auth/credentials.ts`) and the OAuth functions of the GitHub client exist; nothing creates a session.

**Acceptance criteria**
- [ ] `GET /auth/login` stores a random `state` in an HTTP-only cookie valid 10 minutes and redirects to GitHub's authorize URL with the App's client id and `<PUBLIC_URL>/auth/callback`
- [ ] the callback rejects a missing or mismatched `state` with no side effect
- [ ] a user is allowed when their login is in `CROSSBOARD_ALLOWED_USERS`, or when `GET /user/installations` returns an installation whose account login is in `CROSSBOARD_ALLOWED_ORGS` (case-insensitive)
- [ ] a non-allowed account is sent to `/auth/not-allowed`, an SPA route saying the account is not allowed on this instance (SPEC §10.1 Empty), and no session, token or user row is stored (test asserts all three tables stay empty)
- [ ] an allowed user gets a `users` row (created or updated with login, name, avatar, `last_login_at`), encrypted access and refresh tokens with their expiry times, and a session; then lands on the `return` path or `/`
- [ ] a test with sentinel tokens proves the database holds only ciphertext and no log line or response contains a token
- [ ] Reachable via: `apps/server/src/app.ts` mounts `GET /auth/login` and `GET /auth/callback`; `apps/web/src/router.tsx` serves `/auth/not-allowed`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Refreshing tokens and computing access (owned by "Compute each user's installation and repository access"); the `github_app_authorization` webhook (owned by "Apply installation, repository and authorization webhooks").

**Scope hint** `apps/server/src/auth/`, `apps/server/src/app.ts`, `apps/web/src/routes/not-allowed.tsx`, `apps/web/src/router.tsx` · ~340 changed lines · Expected files: 10 reviewable

### Compute each user's installation and repository access

```meta
id: M2.7
parent: M2
labels: [feat, area:auth, area:db, safety-critical]
depends: [M2.6]
```

**Summary** Compute the `(installation, repo)` pairs a user reaches at sign-in and every 60 minutes for users with a live session, record installations and minimal repo rows, derive which installations are active, refresh tokens before use, and provide the scoping helpers every API query uses.

**Design references** FR-3, FR-7, FR-8, FR-9, SPEC §5.2, §8.1 (`installations`, `user_installations`, `repos`, `user_repo_access`), §9.1, D-3, D-4, CLAUDE.md `### Risk review` (cross-user isolation, tokens)

**Current state** sign-in stores encrypted tokens and creates sessions; nothing reads the tokens yet.

**Acceptance criteria**
- [ ] access is computed from `GET /user/installations` and `GET /user/installations/{id}/repositories` with the user's token and replaces that user's `user_installations` and `user_repo_access` rows; installations seen are upserted into `installations`
- [ ] a repository in the user's access that is not yet in `repos` is inserted with identity fields only and `sync_state = pending`; this item never sets any other sync field
- [ ] computation runs at sign-in and every 60 minutes for users with a live session (jobs interface); users without one are skipped
- [ ] an access token with less than 5 minutes left is refreshed before use and the rotated refresh token stored encrypted; a failed refresh deletes the user's tokens and sessions (test)
- [ ] an installation is active when its account login is in either allowlist or at least one allowed user's computed access includes it; the active set is recomputed after every access computation and exposed as a function other modules call
- [ ] `apps/server/src/access/` exports the helpers that restrict any query to the session user's `user_repo_access`; a test with two users proves one never gets the other's repos
- [ ] Reachable via: the callback in `apps/server/src/auth/` calls the computation at sign-in; `apps/server/src/index.ts` schedules the hourly job
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Discovering, checking and purging repositories when the active set changes (owned by "Discover the repositories of active installations"); recomputation triggered by webhooks (owned by "Apply installation, repository and authorization webhooks").

**Scope hint** `apps/server/src/access/`, `apps/server/src/auth/`, `apps/server/src/index.ts` · ~380 changed lines · Expected files: 9 reviewable

### Show the user's installations on the settings page

```meta
id: M2.8
parent: M2
labels: [feat, area:server, area:web]
depends: [M2.7]
```

**Summary** Add `GET /api/me` and the `/settings` page listing the accounts and orgs that have the App installed, whether each is active, and the link to install it on more, plus the user menu with sign-out.

**Design references** FR-10, FR-10a, SPEC §7.4 (`GET /api/me`), §10 (layout, empty states), §10.1 (Settings page, User menu), D-20

**Current state** the top bar has an empty user-menu slot; there is no `/settings` route.

**Acceptance criteria**
- [ ] `GET /api/me` returns the session user (login, name, avatar), their installations from `user_installations` with account login, type and active flag, and the install URL `https://github.com/apps/<slug>/installations/new`; no token or secret appears in the response (test)
- [ ] `/settings` lists the installations with the SPEC §10.1 components (Card, Table, Badge for the active flag) and the install link; it shows loading, an empty state explaining how to install the App, and an error state with retry (component tests for all three)
- [ ] the top bar's user menu (Menu, Avatar) signs out through `POST /auth/logout`
- [ ] GitHub's redirect to the App's `setup_url` (`/settings`) after installing lands on this page, through sign-in when needed
- [ ] Reachable via: `apps/server/src/app.ts` mounts `GET /api/me`; `apps/web/src/router.tsx` serves `/settings`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Per-repo sync state and budget on the settings page (owned by "Show sync status, manual refresh and per-repo state").

**Scope hint** `apps/server/src/api/me.ts`, `apps/server/src/app.ts`, `apps/web/src/routes/settings.tsx`, `apps/web/src/router.tsx`, `apps/web/src/components/top-bar/` · ~300 changed lines · Expected files: 9 reviewable

### Add the fake GitHub server and the sign-in end-to-end test

```meta
id: M2.9
parent: M2
labels: [chore, area:web, area:ci, safety-critical]
depends: [M2.8, M1.6]
```

**Summary** Create the `e2e` package with a small fake GitHub server (OAuth, REST and GraphQL answered from fixtures) and a Playwright smoke test that signs in against the built container, and run it in CI.

**Design references** SPEC §7.6 (`e2e/`, CI), §7.5 (`CROSSBOARD_GITHUB_API_URL`, `CROSSBOARD_GITHUB_WEB_URL`), FR-50, §5.3, §7.2

**Current state** nothing yet; `pnpm-workspace.yaml` already lists `e2e` but the directory does not exist.

**Acceptance criteria**
- [ ] `e2e/` is the `@crossboard/e2e` package with `lint`, `typecheck` and `test` scripts and a Playwright config
- [ ] the fake GitHub serves, from fixtures: the OAuth authorize and token endpoints, `GET /user`, `GET /user/installations`, `GET /user/installations/{id}/repositories`, `POST /app/installations/{id}/access_tokens`, `GET /installation/repositories`, and a GraphQL endpoint that answers each query by its operation name from a fixture file, so later items only add fixtures
- [ ] the container runs with env App credentials (FR-50) and the two base URLs pointing at the fake
- [ ] a Playwright test signs in as an allowed user and sees the settings page with an installation; a second test signs in as a non-allowed user and sees the "not allowed" page
- [ ] `ci.yml` builds the image and runs `pnpm --filter ./e2e test` against it; the job keeps `contents: read` permissions
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Issue fixtures and the list smoke test (owned by "Edit and validate the filter in the list"); detail and board smoke tests (owned by "Show the issue detail panel and route" and "Show a board's columns and cards").

**Scope hint** `e2e/`, `.github/workflows/ci.yml` · ~350 changed lines (excluding fixtures) · Expected files: 10 reviewable

## M3 — Initial sync

```epic
id: M3
milestone: M3
labels: [area:sync, area:db]
depends: [M2]
```

**Done when** GitHub behaviour spike done (§5.5); all open issues of active installations' repos in SQLite, including labels, assignees, parent, sub-issue summary and dependencies; rate-limit-aware client

**Summary** Run the maintainer's instance and the SPEC §5.5 spike, make the GitHub client rate-limit-aware with installation tokens, discover the repositories of active installations, and sync their open issues with labels, assignees, parents, sub-issue summaries and dependencies into SQLite.

**Design references** SPEC §5.2, §5.3, §5.5, §6.1, §6.5, §7.3, §8.1, §8.2, D-4, D-7, D-15, D-18, SPEC §11 M3

**Goal** After an allowed user signs in, every open issue of every non-archived, issues-enabled repository of the active installations is in SQLite with its relations, synced within the rate-limit budget, and the §5.5 table records what GitHub actually does.

**Product rules** All data is fetched with installation tokens (D-4); issue data is stored once per repo; the REST issue list is never used for issue data; no GraphQL mutation is ever sent (D-18).

**Out of scope** Webhooks, reconciliation and the daily resync (SPEC §11 M8); serving issues through the API (SPEC §11 M5).

### Deploy the maintainer's instance and register its App through setup

```meta
id: M3.1
parent: M3
labels: [chore, area:ci, maintainer-only]
depends: [M2.9, M2.10, M1.5]
```

**Summary** The maintainer deploys a private Crossboard instance with a public HTTPS URL, built from the repository's `Dockerfile` on `dev`, creates its GitHub App through `/setup`, and installs it on their account and at least one organization, so the behaviour spike has a real installation and real webhook deliveries (D-15).

**Design references** D-15, D-3, FR-47, FR-48, FR-49, FR-51, SPEC §7.1 (packaging), §7.5

**Current state** nothing yet; no image is published before the release workflow exists, so the host builds the image itself.

**Acceptance criteria**
- [ ] the instance runs an image built on the host from `dev` with `CROSSBOARD_PUBLIC_URL` set to its public HTTPS URL, `CROSSBOARD_WEBHOOKS=true`, a generated `CROSSBOARD_APP_SECRET` and the maintainer in `CROSSBOARD_ALLOWED_USERS`; `/data` is on a persistent volume
- [ ] the App was created through `/setup` with the setup token from the log, and the setup routes now answer `404`
- [ ] the App is installed on the maintainer's personal account and on at least one organization whose test repositories have issue types, sub-issues, and same-repo and cross-repo dependencies, including one dependency on an issue in a repository the App cannot read
- [ ] the maintainer signs in and `/settings` lists the installations as active
- [ ] no secret is committed or written into any item
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** The behaviour checks themselves (owned by "Confirm the unconfirmed GitHub behaviour of SPEC §5.5"); publishing images (owned by "Publish the image to GHCR from a release workflow").

**Scope hint** no repository files; the instance's hosting configuration only · ~0 changed lines · Expected files: 0 reviewable

### Confirm the unconfirmed GitHub behaviour of SPEC §5.5

```meta
id: M3.2
parent: M3
labels: [spike, area:sync, area:docs, maintainer-only]
depends: [M3.1]
```

**Summary** Check each row of the SPEC §5.5 table against real GraphQL queries and real webhook deliveries on the maintainer's instance and record the results in that section.

**Design references** SPEC §5.5, §5.3, §6.2, §6.3, FR-7, FR-24, D-11, D-12, D-15

**Current state** every §5.5 row is unconfirmed; the implementation uses each row's fallback.

**Acceptance criteria**
- [ ] each of the eight §5.5 rows is measured: the GraphQL dependency and sub-issue fields queried without a preview header; the fields of real `issues` webhook payloads (seen in the App's recent deliveries); a transferred issue's node id before and after; `blockedBy`/`blocking` and the summary totals for a dependency on an unreadable issue; `updatedAt` before and after adding and removing a dependency and a sub-issue; the totals with a closed blocker; the `github_app_authorization` actions delivered; `issueType` on a user-owned repository
- [ ] SPEC §5.5 records each row's result with the date (confirmed, or what GitHub actually does), in the same commit
- [ ] pass: every row is confirmed or its fallback still holds. Kill: a row whose result invalidates its fallback is added to SPEC §14 with a recommended default, and the maintainer files an item for the change; the webhook items of SPEC §11 M8 wait for this spike
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Changing sync code to use a confirmed behaviour: only a SPEC §14 decision can do that.

**Scope hint** `docs/SPEC.md` · ~30 changed lines · Expected files: 1 reviewable

### Authenticate as the App and query GraphQL with installation tokens

```meta
id: M3.3
parent: M3
labels: [feat, area:sync]
depends: [M2.2, M2.4]
```

**Summary** Extend the central client with App authentication from the stored or env private key, cached installation tokens, and GraphQL queries under those tokens, with cost logging and a guard that no mutation can be sent.

**Design references** SPEC §5.2 (installation tokens), §6.1 (cost logging), §6.5, §5.5 (no preview header), D-4, D-14, D-18, CLAUDE.md `### Risk review` (no GitHub writes)

**Current state** the client in `apps/server/src/github/` handles user-token REST, the OAuth exchanges and the manifest conversion; the credential accessor is `apps/server/src/auth/credentials.ts`.

**Acceptance criteria**
- [ ] installation access tokens are created from the App's private key through the credential accessor, cached and renewed 5 minutes before expiry; tokens are never logged (sentinel test)
- [ ] GraphQL queries run with installation tokens and send no preview header; queries live as named documents in `apps/server/src/github/queries/`
- [ ] the GraphQL function refuses any document containing a `mutation` operation, and a test runs every document in `queries/` through that check; together with the REST test, the only non-`GET` calls are the D-18 list
- [ ] each GraphQL call logs at `debug` its installation, repo and `rateLimit { cost }`; REST and GraphQL calls with installation tokens go through one function per kind
- [ ] Reachable via: `apps/server/src/index.ts` creates the installation-aware client and passes it to the jobs and route modules
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Budget tracking, concurrency limits, retries and ETags (owned by "Track rate-limit budgets and limit concurrency in the GitHub client").

**Scope hint** `apps/server/src/github/`, `apps/server/src/index.ts` · ~280 changed lines · Expected files: 7 reviewable

### Track rate-limit budgets and limit concurrency in the GitHub client

```meta
id: M3.7
parent: M3
labels: [feat, area:sync]
depends: [M3.3]
```

**Summary** Track each installation's remaining budget from response headers and GraphQL `rateLimit`, enforce the concurrency limits, apply the wait, retry and backoff rules, and support ETag-conditional REST requests.

**Design references** SPEC §6, §6.1 (concurrency, retries), §6.5, FR-46 (budget unknown until the first call)

**Current state** the client authenticates as the App and runs GraphQL with installation tokens; it tracks no budget and has no limits.

**Acceptance criteria**
- [ ] each installation's remaining budget and reset time are tracked in memory from REST headers and GraphQL `rateLimit`, readable by other modules, and "unknown" until the first call after a restart
- [ ] at most 2 in-flight requests per installation and 4 overall
- [ ] on `403` or `429` with `retry-after` or `x-ratelimit-reset` the client waits as told; other failures retry 3 times after 1 s, 4 s and 16 s, then throw
- [ ] REST GETs can send `If-None-Match`; a `304` is returned as "not modified"
- [ ] every call is logged at `debug` with installation, repo, cost and remaining budget
- [ ] tests with `msw` cover budget tracking, concurrency, both wait paths, the backoff and a `304`
- [ ] Reachable via: every call of the client created in `apps/server/src/index.ts` passes through these limits
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Pausing background work below 10% (owned by "Pause background sync for suspended or low-budget installations"); the 2% rule for detail fetches (owned by "Fetch issue details lazily and sanitize them").

**Scope hint** `apps/server/src/github/` · ~300 changed lines · Expected files: 5 reviewable

### Discover the repositories of active installations

```meta
id: M3.4
parent: M3
labels: [feat, area:sync, area:db, safety-critical]
depends: [M3.7, M2.7]
```

**Summary** For each active installation, list its repositories, check them in batched GraphQL queries, mark archived and issues-disabled ones `skipped`, and enqueue the initial sync of the rest; an installation that stops being active is purged. Discovery and purging are functions other modules call.

**Design references** SPEC §5.3 (discovery), §6.1 (triggers), §8.1 (`repos`), §8.2 (purging), FR-3, D-7, CLAUDE.md `### Risk review` (cross-user isolation)

**Current state** access computation inserts `repos` rows with identity fields and `pending`, and recomputes the active set; nothing reacts to the active set changing.

**Acceptance criteria**
- [ ] discovery calls `GET /installation/repositories` (installation token, paginated, ETag-cached) and upserts `repos` rows with owner, name, private flag and installation
- [ ] one GraphQL query per up to 25 repos reads `isArchived`, `hasIssuesEnabled` and the open issue count; archived and issues-disabled repos get `skipped` with the reason; repos with zero open issues become `ready` without paging; the rest stay `pending` with `open_issue_count` set
- [ ] discovery runs when an installation becomes active (called from the active-set recomputation in `apps/server/src/access/`) and at startup for every active installation, before any startup sync
- [ ] an installation that stops being active is purged: its repos, their issues, labels and access rows are deleted, boards and saved views are untouched, and a user who had access to those repos sees none of them through the scoping helpers afterwards (test)
- [ ] Reachable via: the active-set recomputation in `apps/server/src/access/` and `apps/server/src/index.ts` at startup call discovery
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Syncing issues (owned by "Sync a repository's open issues, labels and assignees"); installation and repository webhooks (owned by "Apply installation, repository and authorization webhooks").

**Scope hint** `apps/server/src/sync/discovery.ts`, `apps/server/src/github/queries/`, `apps/server/src/access/`, `apps/server/src/index.ts` · ~300 changed lines · Expected files: 7 reviewable

### Sync a repository's open issues, labels and assignees

```meta
id: M3.5
parent: M3
labels: [feat, area:sync]
depends: [M3.4]
```

**Summary** The initial sync pages a repository's open issues through GraphQL with the SPEC §5.3 selection and replaces the repo's issues, labels and assignees atomically when it completes, moving the repo through its sync states.

**Design references** SPEC §5.3 (open issues), §5.4, §6.1, §7.3 (startup), §8.1 (`issues`, `labels`, `issue_labels`, `issue_assignees`, `repos`), §8.2, §6.5 (logging), §5.5 (`issueType` may be null), D-7

**Current state** discovery checks repos, marks them `pending`, `ready` or `skipped`, and has no sync job to enqueue; `apps/server/src/sync/` holds only `discovery.ts`.

**Acceptance criteria**
- [ ] one GraphQL query per page of 100 open issues with the full SPEC §5.3 selection
- [ ] `issues` stores every scalar of SPEC §8.1 (including type name and color enum, milestone, `parent_id`, sub-issue total and completed, `blocked_by_total`, `blocking_total`); labels are stored per repo with color; assignees with avatar
- [ ] the repo goes `pending` → `syncing` → `ready`, or `error` with the message after the client's retries fail; `last_full_sync_at` is set and `reconcile_since` is set to the sync's start time
- [ ] when the sync completes the repo's issues are replaced in one transaction: open issues no longer returned are deleted
- [ ] only repos of active installations are synced, and never an archived or issues-disabled one: a repo that discovery has not checked yet is checked first and marked `skipped` when it fails the check
- [ ] each completed sync is logged at `info` with page count and total cost
- [ ] at startup, after discovery, repos `pending` or `syncing` are (re)synced
- [ ] an integration test with `msw` syncs a two-page repo and a re-sync that drops one issue
- [ ] Reachable via: discovery enqueues the sync job for each `pending` repo; `apps/server/src/index.ts` resumes it at startup
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Dependencies, parents and paging connections longer than one page (owned by "Sync dependencies and parents, and page long connections"); refetching single issues (owned by "Apply issue, sub-issue, dependency, comment and label webhooks").

**Scope hint** `apps/server/src/sync/`, `apps/server/src/github/queries/`, `apps/server/src/index.ts` · ~350 changed lines · Expected files: 7 reviewable

### Sync dependencies and parents, and page long connections

```meta
id: M3.6
parent: M3
labels: [feat, area:sync]
depends: [M3.5]
```

**Summary** During the sync, store every parent and every issue on either side of a dependency in `issue_refs`, the readable blocked-by and blocking edges in `issue_deps`, and page labels, assignees and relation lists that exceed their first page.

**Design references** SPEC §5.3 (`parent`, `blockedBy`, `blocking`, follow-up queries), §8.1 (`issue_refs`, `issue_deps`), §8.2, FR-23, FR-24, §5.5 (fallbacks for unreadable relations and closed totals)

**Current state** the sync stores issue scalars, labels and assignees from the first page of each connection only.

**Acceptance criteria**
- [ ] every parent and every `blockedBy`/`blocking` node gets an `issue_refs` row (repo full name, number, title, state, url, `seen_at`), synced or not
- [ ] `issue_deps` holds one row per readable edge, deduplicated across both sides, including closed relations with state `CLOSED`
- [ ] labels beyond 20, assignees beyond 10, and `blockedBy` or `blocking` beyond 20 are paged by follow-up queries for the affected issues
- [ ] the repo's edges are replaced in the same transaction as its issues; edges where the other side lives in another repo are kept
- [ ] an integration test covers a cross-repo edge, a closed blocker, an issue with 25 blockers, an issue with 25 labels, and a total above the readable count (not-accessible relation per FR-24)
- [ ] Reachable via: the sync job from "Sync a repository's open issues, labels and assignees" stores relations in each run
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Removing refs and edges of closed, deleted or transferred issues (owned by "Apply issue, sub-issue, dependency, comment and label webhooks"); pruning unreferenced refs (owned by "Run the daily full resync and prune orphaned references").

**Scope hint** `apps/server/src/sync/`, `apps/server/src/github/queries/` · ~300 changed lines · Expected files: 6 reviewable

## M4 — Query engine

```epic
id: M4
milestone: M4
labels: [area:query]
depends: [M1]
```

**Done when** Parser and evaluator for the full §4.3 table, ≥ 90% branch coverage

**Summary** `packages/query` parses the GitHub-compatible filter language into an AST with warnings or a positioned error, and evaluates it against any `FilterableIssue`, with no runtime dependencies.

**Design references** SPEC §4.3, FR-17, FR-18, FR-21, FR-25, §7.6, D-9, D-10, SPEC §11 M4

**Goal** Server and web import one `parse` and one `evaluate` that implement every row of the SPEC §4.3 table, proven by unit tests at 90% branch coverage or more.

**Product rules** The filter semantics live only here; server and web never re-implement them. SPEC §11 says this milestone may run in parallel with SPEC §11 M2 and SPEC §11 M3.

**Out of scope** Using the engine in API routes and the UI (SPEC §11 M5 and SPEC §11 M7); autocomplete values (SPEC §11 M5).

### Parse boolean structure, quoting and comma lists

```meta
id: M4.1
parent: M4
labels: [feat, area:query]
depends: [M1.1]
```

**Summary** Add `parse(query)` with the tokenizer and grammar: whitespace terms with implicit `AND`, uppercase `AND`/`OR`, parentheses, quoting, negation and comma lists, returning `{ ast, warnings }` or a positioned `{ error }`.

**Design references** SPEC §4.3 (syntax), FR-18, FR-21, D-10, §7.6

**Current state** `packages/query` exists with a placeholder export and one passing test.

**Acceptance criteria**
- [ ] `AND` binds tighter than `OR`; implicit AND has the precedence of explicit `AND`; lowercase `and`/`or` are free text
- [ ] qualifier names are case-insensitive; double-quoted values may contain spaces; no escape sequence exists
- [ ] a comma inside a value is OR of its elements (`label:"a b",c` is valid); repeated qualifiers stay separate AND terms
- [ ] `-` negates a qualifier; `-` before a group or free text is a syntax error
- [ ] syntax errors with `{ message, start, end }` (end exclusive): unbalanced parentheses or quotes, dangling `AND`/`OR`, negated group or free text, empty value or element, more than 5 open parentheses
- [ ] Vitest coverage with a branch threshold of 90% for the package is enforced by its `test` script
- [ ] Reachable via: `packages/query/src/index.ts` exports `parse` and the AST and error types
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Qualifier-specific validation and warnings (owned by "Validate qualifiers and report warnings"); evaluation (owned by "Evaluate filters against a FilterableIssue").

**Scope hint** `packages/query/src/`, `packages/query/vitest.config.ts` · ~380 changed lines · Expected files: 6 reviewable

### Validate qualifiers and report warnings

```meta
id: M4.2
parent: M4
labels: [feat, area:query]
depends: [M4.1]
```

**Summary** Resolve every qualifier of the SPEC §4.3 table during parsing: known names and values become typed AST nodes, malformed values become syntax errors, and unknown qualifiers or values become warnings.

**Design references** SPEC §4.3 (qualifiers table, syntax), FR-17, FR-18, FR-21

**Current state** `parse` handles structure only.

**Acceptance criteria**
- [ ] every qualifier of the table is recognised: `is` (`open`, `closed`, `issue`, `pr`, `blocked`, `blocking`), `label`, `no` (`label`, `assignee`, `milestone`, `type`, `parent`), `has` (`sub-issues`, `parent`, `dependencies`), `assignee`, `author`, `repo`, `org`, `user`, `type`, `milestone`, `parent`, `blocked-by`, `blocking`
- [ ] `repo:` requires `owner/name`; `parent:`, `blocked-by:` and `blocking:` require `owner/repo#N`; anything else is a syntax error with its range
- [ ] an unknown qualifier (including `sort:`, `in:`, `reason:`) or a known one with an unknown value matches everything and adds a warning `{ message, start, end }` naming it
- [ ] `is:closed` warns "Crossboard only syncs open issues"; `is:pr` warns "Pull requests are not shown"
- [ ] a free-text term `#` followed by digits is parsed as an issue-number match; a quoted phrase is one free-text term
- [ ] Reachable via: `packages/query/src/index.ts` `parse`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Evaluating the nodes (owned by "Evaluate filters against a FilterableIssue").

**Scope hint** `packages/query/src/` · ~330 changed lines · Expected files: 4 reviewable

### Evaluate filters against a FilterableIssue

```meta
id: M4.3
parent: M4
labels: [feat, area:query]
depends: [M4.2]
```

**Summary** Add the `FilterableIssue` interface and `evaluate(ast, issue, context)` implementing the semantics of every SPEC §4.3 row and the dependency rules of SPEC §4.4.

**Design references** SPEC §4.3 (qualifiers table), FR-21, FR-25, D-9, D-10, §7.6

**Current state** `parse` returns typed AST nodes; nothing evaluates them.

**Acceptance criteria**
- [ ] `FilterableIssue` carries what the rows need: repo owner and name, number, title, author login, type name, milestone title, label names, assignee logins, parent reference, sub-issue total, readable blocked-by and blocking relations with state, and not-accessible counts; `context` carries `viewerLogin`
- [ ] one test per table row: `is:open`/`is:issue` match all; `is:closed`/`is:pr` match none; `label`, `assignee`, `author`, `type`, `milestone` match case-insensitively and exactly; `@me` resolves to `viewerLogin`; `no:*` and `has:*` as defined; `repo` matches `owner/name`; `org` and `user` both match the repo owner; `parent` matches the direct parent; free text is a case-insensitive substring of the title only (D-9), and `#N` matches the number
- [ ] `is:blocked` is true with a readable open blocker or a not-accessible one; `is:blocking` likewise; closed relations never count; `blocked-by:`/`blocking:` match a readable relation in any state (FR-25)
- [ ] comma lists are OR within a qualifier, negation inverts a qualifier, precedence matches the parser
- [ ] the package has no runtime dependencies and its tests pass in Node and in a browser-like environment; branch coverage stays at 90% or more
- [ ] Reachable via: `packages/query/src/index.ts` exports `evaluate` and `FilterableIssue`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Mapping database rows to `FilterableIssue` (owned by "Serve the filtered, sorted issue list").

**Scope hint** `packages/query/src/` · ~380 changed lines · Expected files: 4 reviewable

## M5 — List view

```epic
id: M5
milestone: M5
labels: [area:server, area:web]
depends: [M3, M4]
```

**Done when** Filterable, sortable, virtualized list; URL state; autocomplete; saved views

**Summary** The default route lists every open issue the user can access, filtered with the shared query engine, sorted and paged on the server, with the filter and sort in the URL, autocomplete, and personal saved views, composed from coss ui.

**Design references** SPEC §4.2, §4.3, FR-11–FR-22, §5.4, §7.4, §9.1, §10, §10.1, D-2, D-13, D-20, SPEC §11 M5

**Goal** A user types `assignee:@me is:blocked`, gets the matching issues across all their repos in a fast virtualized list, shares the URL, and saves the filter as a named view.

**Product rules** Every query is scoped by `user_repo_access`; filters are parsed and evaluated only by `packages/query`; every UI element uses its SPEC §10.1 component.

**Out of scope** The detail panel (SPEC §11 M6); boards in the switcher (SPEC §11 M7); sync status in the top bar (SPEC §11 M8).

### Serve the filtered, sorted issue list

```meta
id: M5.1
parent: M5
labels: [feat, area:server]
depends: [M3.6, M4.3, M2.7]
```

**Summary** Add `GET /api/issues` returning `{ items, total, warnings }` for the session user's accessible open issues, evaluated in memory with `packages/query`, sorted and paged on the server, with the issue item schema and the row-to-`FilterableIssue` mapping defined once for reuse.

**Design references** SPEC §7.4 (route, issue item, filtering target), FR-9, FR-11, FR-12, FR-13, FR-17, FR-18, FR-24, FR-25, §4.3 (`author`, `ghost`), §9.1, D-9

**Current state** issues and relations are synced into SQLite; no API route serves them.

**Acceptance criteria**
- [ ] the issue item Zod schema of SPEC §7.4 is defined once in `apps/server/src/api/schemas.ts`; `blockedBy`/`blocking` carry `open` and `notAccessible` counts per FR-24, and `isBlocked` follows FR-25
- [ ] `apps/server/src/issues/filterable.ts` loads the session user's accessible issues with labels, assignees and dependency states and maps them to `FilterableIssue`; a missing author maps to `ghost`; later routes reuse it
- [ ] the route evaluates the filter with `viewerLogin`; an empty `q` means `is:open`
- [ ] sort is one of `updated-desc` (default), `updated-asc`, `created-desc`, `created-asc`, `repo-asc` (then number), `title-asc`; `limit` is at most 200, default 100; `offset` pages
- [ ] an invalid filter answers `400` with the parse error; warnings are returned with the result
- [ ] a second user never sees a repo or issue they lack access to (integration test)
- [ ] an integration test seeds 10,000 issues and a single filtered request completes in under 1,000 ms
- [ ] Reachable via: `apps/server/src/app.ts` mounts `GET /api/issues`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** The list UI (owned by "Show open issues in a virtualized list"); the summary route with full relation lists (owned by "Serve an issue's summary with its relations").

**Scope hint** `apps/server/src/api/issues.ts`, `apps/server/src/api/schemas.ts`, `apps/server/src/issues/filterable.ts`, `apps/server/src/app.ts` · ~360 changed lines · Expected files: 7 reviewable

### Show open issues in a virtualized list

```meta
id: M5.2
parent: M5
labels: [feat, area:web]
depends: [M5.1, M2.8]
```

**Summary** Route `/` renders the virtualized issue list with every FR-12 column, server-side sorting and paging as the user scrolls, the filter and sort in the URL, and explicit loading, empty and error states, using the SPEC §10.1 components.

**Design references** FR-11, FR-12, FR-13, FR-14, FR-16, FR-19, FR-26, SPEC §5.4, §10 (layout, times), §10.1 (Issue list, Badge, Avatar, Tooltip, Skeleton, Empty, Alert, Select), D-13, D-20, the `coss` skill (`references/primitives/table.md`, `badge.md`)

**Current state** `/` renders an empty main area under the top bar; `/settings` and the user menu exist.

**Acceptance criteria**
- [ ] `/` shows the total count and a Table virtualized with TanStack Virtual, loading 100 rows per page as the user scrolls
- [ ] columns: repo, number, title, issue type as a Badge in its SPEC §5.4 color (unknown as GRAY), labels as Badges in their repo's color, assignee Avatars, milestone, `blocked by N` / `blocks N` Badges where N counts open readable plus not-accessible relations and a badge with N = 0 is hidden, the red "blocked" Badge, sub-issue Progress when total > 0, and the updated time
- [ ] `apps/web/src/lib/time.ts` and one time component render times relative with the absolute time in a Tooltip in the browser's time zone; every later view reuses them
- [ ] a Select offers the FR-13 sort options; `?q=` and `?sort=` reflect the current filter and sort and restore them on load
- [ ] each row has an icon button that opens the issue on GitHub in a new tab
- [ ] loading shows Skeleton rows; empty shows an Empty with "No open issues match this filter", plus the install link when the user has no active installation; error shows an Alert with a retry Button (component tests for all three)
- [ ] Reachable via: `apps/web/src/router.tsx` → `apps/web/src/routes/index.tsx`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** The filter input, qualifier clicks and keyboard navigation (owned by "Edit and validate the filter in the list"); opening the detail panel (owned by "Show the issue detail panel and route").

**Scope hint** `apps/web/src/routes/index.tsx`, `apps/web/src/components/issue-list/`, `apps/web/src/lib/`, `apps/web/src/router.tsx` · ~380 changed lines · Expected files: 12 reviewable

### Edit and validate the filter in the list

```meta
id: M5.3
parent: M5
labels: [feat, area:web]
depends: [M5.2, M2.9]
```

**Summary** The top bar's filter input validates with the shared parser as the user types, underlines errors while keeping the last valid results, shows warnings, appends qualifiers when a label, assignee or repo is clicked, supports the list's keyboard shortcuts, and is covered by a list smoke test.

**Design references** FR-15, FR-17, FR-18, FR-19, FR-21, SPEC §10 (keyboard), §10.1 (Filter input, Filter warnings, Keyboard hints), §7.6 (component and e2e tests), D-20, the `coss` skill (`references/primitives/input-group.md`)

**Current state** the list reads `?q=` but has no input; the fake GitHub has no issue fixtures.

**Acceptance criteria**
- [ ] the filter is an Input Group in the top bar; it parses with `packages/query` on change; an error underlines its range and the list keeps the last valid results; warnings show as an Alert, non-fatal
- [ ] submitting updates `?q=` and reloads the list
- [ ] clicking a label, assignee or repo appends `label:"x"`, `assignee:x` or `repo:o/r`; a label whose name contains a double quote does nothing when clicked
- [ ] keyboard: `/` focuses the filter, `j`/`k` move the selection, `o` opens the selected issue on GitHub, `Esc` leaves the input; shortcuts are hinted with Kbd
- [ ] component tests: error underlining and keyboard navigation
- [ ] the fake GitHub gains fixtures for discovery and sync of two repos; a Playwright test lists and filters issues from them, run by `pnpm --filter ./e2e test` in `ci.yml`
- [ ] Reachable via: the top bar in `apps/web/src/components/top-bar/`, on the `/` route
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Autocomplete (owned by "Suggest qualifier values while typing a filter"); `Enter` opening the detail panel (owned by "Show the issue detail panel and route").

**Scope hint** `apps/web/src/components/filter-bar/`, `apps/web/src/components/top-bar/`, `apps/web/src/components/issue-list/`, `e2e/` · ~350 changed lines (excluding fixtures) · Expected files: 10 reviewable

### Suggest qualifier values while typing a filter

```meta
id: M5.4
parent: M5
labels: [feat, area:server, area:web]
depends: [M5.3]
```

**Summary** Add `GET /api/suggest` returning up to 20 values from the user's accessible cached data, and turn the filter input into an Autocomplete suggesting qualifier names, and values after a qualifier's `:` and after commas.

**Design references** FR-20, FR-9, SPEC §7.4, §9.1, §10.1 (Filter input), D-20, the `coss` skill (`references/primitives/autocomplete.md`)

**Current state** the filter input validates but suggests nothing.

**Acceptance criteria**
- [ ] `GET /api/suggest?field=&prefix=` supports `label`, `assignee`, `author`, `repo`, `org`/`user` (equivalent), `type` and `milestone`; matches by case-insensitive prefix; returns at most 20 distinct values; an unknown field answers `400`
- [ ] values come only from repos in the session user's access (integration test with two users)
- [ ] the filter input uses Autocomplete to suggest qualifier names, and values after `:` and after each comma, using the text after the last comma without quotes as the prefix; choosing one inserts it, quoted when it contains a space
- [ ] Reachable via: `apps/server/src/app.ts` mounts `GET /api/suggest`; the filter input in the top bar
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** none

**Scope hint** `apps/server/src/api/suggest.ts`, `apps/server/src/app.ts`, `apps/web/src/components/filter-bar/` · ~280 changed lines · Expected files: 6 reviewable

### Save, rename and delete personal views

```meta
id: M5.5
parent: M5
labels: [feat, area:server, area:web]
depends: [M5.3]
```

**Summary** Add the saved-views API and the top bar's view switcher, so a user can name the current filter and sort, reopen it, rename it and delete it.

**Design references** FR-22, D-2, SPEC §7.4 (views routes), §8.1 (`saved_views`), §9.1, §9.3 (CSRF), §10.1 (View/board switcher, Rename or save a view, Delete board or view), D-20

**Current state** the top bar has an empty switcher slot.

**Acceptance criteria**
- [ ] `GET`, `POST /api/views` and `PATCH`, `DELETE /api/views/:id` manage the session user's views; names are 1–100 characters and unique per user (`409` on a duplicate); an invalid filter answers `400` with the parse error
- [ ] another user's view id answers `404` on every route (integration test)
- [ ] the switcher is a Menu listing the views; choosing one sets `?q=` and `?sort=`; saving and renaming use a Dialog with a Form; deleting asks in an Alert Dialog; loading, empty and error states (component tests)
- [ ] Reachable via: `apps/server/src/app.ts` mounts `/api/views`; the switcher in `apps/web/src/components/view-switcher/`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Listing boards in the switcher (owned by "Edit boards in a form").

**Scope hint** `apps/server/src/api/views.ts`, `apps/server/src/app.ts`, `apps/web/src/components/view-switcher/`, `apps/web/src/components/top-bar/` · ~340 changed lines · Expected files: 8 reviewable

## M6 — Detail view

```epic
id: M6
milestone: M6
labels: [area:server, area:web, area:sync, area:auth]
depends: [M5]
```

**Done when** Panel and route, lazy body/comments/sub-issues, sanitized, deep links, dependency lists and graph

**Summary** An issue opens in a side panel and on its own route with all its fields, relations, the one-hop dependency graph, and its body, comments and sub-issues fetched lazily and sanitized on the server.

**Design references** SPEC §4.4, §4.6, FR-23, FR-24, FR-27, FR-39–FR-44, §5.3 (lazy fields), §6.4, §6.5, §9.3, §10.1, D-6, D-20, SPEC §11 M6

**Goal** Clicking any synced issue shows everything about it without leaving Crossboard, including what blocks it across repos, and every reference links to GitHub.

**Product rules** GitHub HTML reaches the browser only after the server-side sanitizer; a detail fetch happens only after the session user's access to the repo is checked.

**Out of scope** Webhook-driven cache invalidation of comments (SPEC §11 M8).

### Serve an issue's summary with its relations

```meta
id: M6.1
parent: M6
labels: [feat, area:server]
depends: [M5.1]
```

**Summary** Add `GET /api/issues/:owner/:repo/:number` returning the issue item plus the full blocked-by and blocking lists with states and not-accessible counts, and the parent's title and state.

**Design references** SPEC §7.4 (summary route), FR-23, FR-24, FR-25, FR-39, §8.1 (`issue_refs`, `issue_deps`), §9.1

**Current state** the issue item schema and the accessible-issue loader exist for the list route.

**Acceptance criteria**
- [ ] the response is the issue item plus `blockedBy` and `blocking` lists (each entry `owner/repo#N`, title, state, url, and whether it is synced and readable) and the parent's title and state
- [ ] not-accessible counts follow FR-24 (`max(0, total − readable)`)
- [ ] an issue that is not synced or not in the session user's access answers `404` (integration test with two users)
- [ ] Reachable via: `apps/server/src/app.ts` mounts `GET /api/issues/:owner/:repo/:number`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Body, comments and sub-issues (owned by "Fetch issue details lazily and sanitize them").

**Scope hint** `apps/server/src/api/issues.ts`, `apps/server/src/api/schemas.ts` · ~200 changed lines · Expected files: 4 reviewable

### Fetch issue details lazily and sanitize them

```meta
id: M6.2
parent: M6
labels: [feat, area:sync, area:server, area:auth, safety-critical]
depends: [M6.1, M3.7]
```

**Summary** Add `GET /api/issues/:owner/:repo/:number/details`, which fetches body, comments and sub-issues through GraphQL when the cached copy is stale, sanitizes all HTML with the GitHub-like allowlist before storing it, and degrades to a stale copy or a clear error.

**Design references** FR-41, FR-42, FR-43, SPEC §5.3 (lazy fields), §6.4, §6.5 (2% rule), §9.3 (HTML sanitizing), §8.1 (`issue_details`), D-4, CLAUDE.md `### Risk review` (HTML, cross-user isolation)

**Current state** the summary route exists; the client tracks each installation's budget.

**Acceptance criteria**
- [ ] the session user's access to the repo is checked before any fetch; a non-accessible or unsynced issue answers `404` and causes no GitHub call (integration test with two users)
- [ ] the fetch selects `bodyHTML`, `comments(last: 100)` with author, avatar, time, url and `bodyHTML`, and `subIssues(first: 50)` with state, url and repo, using the installation token of the issue's repo
- [ ] the cache in `issue_details` is valid while `fetched_for_updated_at` equals the issue's `updated_at` and the copy is younger than 10 minutes; otherwise the route waits for a refetch; concurrent requests for one issue share one fetch
- [ ] on a failed fetch the route returns the stale copy with `stale: true` when one exists; otherwise `503` (budget below 2% or installation suspended, with the reset time when known) or `502` (GitHub error)
- [ ] every `bodyHTML` passes `sanitize-html` in `apps/server/src/security/sanitize.ts` with the SPEC §9.3 allowlist before storage; negative fixtures prove `<script>`, an `onerror` attribute, `style` attributes, `<style>`, `<iframe>`, `<form>`, a `javascript:` link, an `http:` image and a non-allowlisted `class` are stripped
- [ ] positive fixtures prove headings, lists, a disabled task-list checkbox, code and `pre`, tables, `details`/`summary`, `kbd`, an `https:` image and `markdown-*`, `highlight*`, `pl-*` and `task-list-item*` classes survive, and that links gain `rel="noopener noreferrer nofollow"` and `target="_blank"`
- [ ] the response carries `commentsTotal` and the sub-issue total so the UI can show "N earlier comments" and "+N more"
- [ ] Reachable via: `apps/server/src/app.ts` mounts the details route
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Dropping cached details on `issue_comment` (owned by "Apply issue, sub-issue, dependency, comment and label webhooks"); rendering (owned by "Show the issue detail panel and route").

**Scope hint** `apps/server/src/api/details.ts`, `apps/server/src/security/sanitize.ts`, `apps/server/src/github/queries/`, `apps/server/src/app.ts` · ~380 changed lines (excluding fixtures) · Expected files: 8 reviewable

### Show the issue detail panel and route

```meta
id: M6.3
parent: M6
labels: [feat, area:web]
depends: [M6.2, M5.3]
```

**Summary** The detail opens as a right-side Drawer over the list (row click or `Enter`) and as the route `/i/:owner/:repo/:number`, showing every FR-40 field, the dependency lists, and the sanitized body and comments in a `markdown-body` container.

**Design references** FR-14, FR-23, FR-24, FR-39, FR-40, FR-41, FR-42, FR-43, FR-44, SPEC §10 (keyboard, times), §10.1 (Detail side panel, Detail sections), §7.1 (`github-markdown-css`), D-20, the `coss` skill (`references/primitives/drawer.md`)

**Current state** list rows link only to GitHub; the shared time component exists in `apps/web/src/lib/`.

**Acceptance criteria**
- [ ] clicking a row or pressing `Enter` opens the detail in a Drawer from the right; `Esc` closes it; `/i/:owner/:repo/:number` shows the same view full-page
- [ ] shows title, state, `owner/repo#number`, author, created and updated (shared time component), type, milestone, labels, assignees, parent issue, sub-issues with state, blocked-by and blocking lists, body and comments (oldest first) with author Avatar and time, in Collapsible sections with Separators
- [ ] dependency entries show `owner/repo#N`, title and state; closed ones are struck through; synced ones open their detail, others GitHub; a list ends with "+N not accessible" without a link when N > 0
- [ ] the panel shows the summary immediately and the body when it arrives; "N earlier comments on GitHub" precedes comments when there are more than 100; "+N more on GitHub" follows 50 sub-issues
- [ ] bodies render inside `markdown-body` styled with `github-markdown-css` in light and dark; only HTML from the details route is injected
- [ ] an "Open on GitHub" Button; every referenced issue, user, label and repo links to GitHub
- [ ] loading (Skeleton), error (Alert with retry, and the `503` reset time when present) and stale states (component tests)
- [ ] the fake GitHub gains a details fixture; a Playwright test opens an issue's detail, run by `pnpm --filter ./e2e test` in `ci.yml`
- [ ] Reachable via: `apps/web/src/router.tsx` → `apps/web/src/routes/issue.tsx`, and the list's row click
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** The dependency graph (owned by "Draw the one-hop dependency graph"); opening the panel from boards (owned by "Show a board's columns and cards").

**Scope hint** `apps/web/src/routes/issue.tsx`, `apps/web/src/router.tsx`, `apps/web/src/components/detail/`, `apps/web/src/components/issue-list/`, `e2e/` · ~400 changed lines (excluding fixtures) · Expected files: 12 reviewable

### Draw the one-hop dependency graph

```meta
id: M6.4
parent: M6
labels: [feat, area:web]
depends: [M6.3]
```

**Summary** The detail view shows a hand-written inline SVG with the issue's blockers on the left, the issue in the middle and the issues it blocks on the right.

**Design references** FR-27, D-6, FR-24, FR-25, SPEC §7.6 (layout-limit tests), §10.1 (the graph is hand-built)

**Current state** the detail view shows the dependency lists only.

**Acceptance criteria**
- [ ] three columns: blockers, the issue, blocked issues (one hop each way); straight edges from each blocker to the issue and from the issue to each blocked issue
- [ ] nodes show `repo#N` and the title truncated to 40 characters; closed nodes are struck through and greyed; colors come from the coss theme tokens so light and dark both work
- [ ] at most 15 nodes per side, then a "+N more" node; not-accessible relations are one "+N not accessible" node
- [ ] clicking a node opens that issue's detail (synced) or GitHub (others)
- [ ] with no dependencies at all the graph is omitted
- [ ] no graph library is added; component tests cover the 15-node limit, the not-accessible node and the omitted graph
- [ ] Reachable via: the detail panel and `apps/web/src/routes/issue.tsx`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** A board-wide dependency graph (a SPEC §12 candidate).

**Scope hint** `apps/web/src/components/detail/dependency-graph/` · ~250 changed lines · Expected files: 4 reviewable

## M7 — Boards

```epic
id: M7
milestone: M7
labels: [area:server, area:web]
depends: [M6]
```

**Done when** CRUD, column filters, placement, collapsed/expanded sub-issues, ad-hoc filter, export/import

**Summary** Users create personal Kanban boards whose columns are filter queries, see issues placed into the first matching column with sub-issues nested under their nearest placed ancestor, narrow a board ad hoc, and export and import boards as JSON.

**Design references** SPEC §4.5, FR-28–FR-38, §7.4 (boards routes, cards shape), §8.1 (`boards`, `board_columns`), §9.1, §10.1, D-2, D-20, SPEC §11 M7

**Goal** A user builds the U3/U4 boards of SPEC §3 in a form, sees each issue in exactly one column with epics folding their sub-issues, and moves a board to another instance by export and import.

**Product rules** Boards are strictly personal: another user's board id answers `404`, and a board only ever shows issues of repos its owner can access. No manual ordering and no drag and drop.

**Out of scope** Writing to GitHub from a board (a SPEC §12 candidate); sharing boards (D-2).

### Create, read, update and delete boards through the API

```meta
id: M7.1
parent: M7
labels: [feat, area:server]
depends: [M2.7, M4.3]
```

**Summary** Add the board CRUD routes storing name, base filter, ordered columns, sort, sub-issue mode and the Other toggle, validating every filter with `packages/query`.

**Design references** FR-28, FR-29, FR-35, SPEC §7.4 (boards routes), §8.1, §9.1, §9.3 (CSRF), D-2

**Current state** nothing yet

**Acceptance criteria**
- [ ] `GET /api/boards`, `POST /api/boards`, `GET`, `PATCH`, `DELETE /api/boards/:id` manage the session user's boards and their columns in one transaction
- [ ] limits: name 1–100 characters, 1–20 columns, column name 1–100 characters; sort as FR-13 (default `updated-desc`); sub-issue mode `collapsed` (default) or `expanded`; Other off by default; board names need not be unique
- [ ] an invalid base or column filter answers `400` with the parse error naming the column
- [ ] another user's board id answers `404` on every route (integration test)
- [ ] Reachable via: `apps/server/src/app.ts` mounts `/api/boards`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Cards (owned by "Place issues into board columns with sub-issue nesting"); export and import (owned by "Export and import boards as JSON").

**Scope hint** `apps/server/src/api/boards.ts`, `apps/server/src/app.ts` · ~300 changed lines · Expected files: 5 reviewable

### Place issues into board columns with sub-issue nesting

```meta
id: M7.2
parent: M7
labels: [feat, area:server]
depends: [M7.1, M5.1]
```

**Summary** Add the pure placement and nesting functions in `apps/server/src/boards/` and `GET /api/boards/:id/cards?q=` returning every placed card per column, with sub-issues nested under their nearest placed ancestor in collapsed mode.

**Design references** FR-30, FR-31, FR-33, FR-34, SPEC §7.4 (cards route and shape), §7.6 (placement and nesting tests), §9.1

**Current state** board CRUD exists; `apps/server/src/issues/filterable.ts` loads accessible issues for the list route.

**Acceptance criteria**
- [ ] candidates come from `apps/server/src/issues/filterable.ts`, so only issues of repos in the board owner's `user_repo_access` are ever placed (integration test with two users sharing no repo)
- [ ] an issue matching the base filter and the ad-hoc `q` is placed in the first column, in order, whose filter matches; otherwise in Other when enabled, otherwise not shown
- [ ] collapsed mode: an issue whose nearest placed ancestor exists is nested in that ancestor's card, following `parent_id` across synced issues only, skipping synced but unplaced ancestors, stopping at an unsynced parent and before a repeated issue (cycle); nested cards carry `columnName`
- [ ] expanded mode: every placed issue is its own card
- [ ] column counts include only top-level cards; cards within a column follow the board's sort
- [ ] the response is `{ columns: [{ id, name, count, cards }], other?: { count, cards }, warnings }` with every placed card (no paging); an invalid `q` answers `400`; another user's board answers `404`
- [ ] unit tests cover first-match placement, Other, nesting through an unplaced ancestor, a chain ending at an unsynced parent, and a cycle
- [ ] Reachable via: `apps/server/src/app.ts` mounts `GET /api/boards/:id/cards`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Rendering (owned by "Show a board's columns and cards").

**Scope hint** `apps/server/src/boards/`, `apps/server/src/api/boards.ts` · ~380 changed lines · Expected files: 6 reviewable

### Edit boards in a form

```meta
id: M7.3
parent: M7
labels: [feat, area:web]
depends: [M7.1, M5.5]
```

**Summary** Add `/b/new` and `/b/:boardId/edit`: a form for name, base filter, sort, sub-issue mode, Other toggle and the column list, plus board deletion and boards in the view/board switcher.

**Design references** FR-28, FR-29, FR-37, FR-38, SPEC §10, §10.1 (Board form, Delete board or view, View/board switcher), D-20, the `coss` skill (`references/primitives/form.md`, `field.md`)

**Current state** the switcher lists saved views only.

**Acceptance criteria**
- [ ] the form uses Form, Field, Fieldset, Input, Select and Switch and edits every board field; columns can be added, removed, renamed, have their filter edited and be moved up or down with Buttons (no drag and drop)
- [ ] filters are validated with `packages/query` as the user types; an invalid filter blocks saving and shows the parse error at its column's Field
- [ ] saving creates or updates the board and opens it; deleting asks in an Alert Dialog, removes the board and returns to `/`
- [ ] the switcher Menu lists the user's boards next to saved views
- [ ] loading, error and not-found states (component tests)
- [ ] Reachable via: `apps/web/src/router.tsx` → `apps/web/src/routes/board-edit.tsx` for `/b/new` and `/b/:boardId/edit`, and the switcher
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** The board view (owned by "Show a board's columns and cards"); export and import buttons (owned by "Export and import boards as JSON").

**Scope hint** `apps/web/src/routes/board-edit.tsx`, `apps/web/src/router.tsx`, `apps/web/src/components/board-form/`, `apps/web/src/components/view-switcher/` · ~380 changed lines · Expected files: 8 reviewable

### Show a board's columns and cards

```meta
id: M7.4
parent: M7
labels: [feat, area:web]
depends: [M7.2, M7.3, M6.3, M5.4]
```

**Summary** Add `/b/:boardId`, rendering the columns and cards from the cards route with nested sub-issues behind per-card toggles, the ad-hoc filter bar, the 200-card cap and the detail Drawer.

**Design references** FR-20, FR-26, FR-31, FR-32, FR-34, FR-38, SPEC §2 (deep links), §3 (U5), §10 (keyboard on boards), §10.1 (Board columns and cards, Board repo picker, Nested sub-issues, Sub-issue progress, Show N more), §7.6, D-20, D-21, the `coss` skill (`references/primitives/combobox.md`)

**Current state** the cards route, the board form and the detail Drawer exist.

**Acceptance criteria**
- [ ] columns in order in Scroll Areas with their name and top-level card count, then Other when enabled
- [ ] cards are Cards showing repo, `#number`, title, label Badges, assignee Avatars, type, the blocked Badge, sub-issue Progress and an icon button that opens the issue on GitHub; clicking a card opens the detail Drawer
- [ ] in collapsed mode a parent card has a Collapsible toggle with `completed/total`; nested cards show their own column name as a Badge and can themselves expand; the per-card state is kept in `localStorage` under `crossboard:board:<boardId>:expanded` and cards start collapsed when storage is unavailable
- [ ] a column renders at most 200 cards, then a "Show N more" Button
- [ ] the filter bar narrows the board through `?q=` without changing it; `/` focuses it and `Esc` closes the Drawer
- [ ] a repo picker (Combobox, multi-select) next to the filter bar searches the user's repos through `GET /api/suggest?field=repo` and sets the one top-level `repo:` term of `?q=` (`repo:o/a,o/b`); with nothing picked the term is removed and all repos show; a `repo:` term typed into the filter shows as picked (component test)
- [ ] loading, empty, error and not-found states; component tests for "Show N more" and the storage fallback
- [ ] a Playwright test creates a board and sees an issue placed in the expected column, run by `pnpm --filter ./e2e test` in `ci.yml`
- [ ] Reachable via: `apps/web/src/router.tsx` → `apps/web/src/routes/board.tsx`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Editing the board (owned by "Edit boards in a form").

**Scope hint** `apps/web/src/routes/board.tsx`, `apps/web/src/router.tsx`, `apps/web/src/components/board/`, `e2e/` · ~400 changed lines (excluding fixtures) · Expected files: 11 reviewable

### Export and import boards as JSON

```meta
id: M7.5
parent: M7
labels: [feat, area:server, area:web]
depends: [M7.3]
```

**Summary** Add `GET /api/boards/:id/export` and `POST /api/boards/import` with the FR-36 format, and the buttons that download a board and import a file as a new board.

**Design references** FR-36, FR-28, FR-29, FR-35, SPEC §7.4, §9.3 (CSRF), §10.1 (Board import file picker, Toast), D-20

**Current state** board CRUD and the board form exist.

**Acceptance criteria**
- [ ] export returns `{ "crossboard": "board", "version": 1, "name", "baseFilter", "sort", "subIssueMode", "showOther", "columns": [{ "name", "filter" }] }`; another user's board answers `404`
- [ ] import accepts at most 256 KB, validates shape, enums, limits and every filter, and answers `400` naming the first problem (including any `version` other than 1); it always creates a new board and never overwrites; a duplicate name is allowed
- [ ] the board edit page offers an export Button (download) and the switcher offers import (file picker); import errors show as a Toast
- [ ] an export imported again yields an equal board (integration test)
- [ ] Reachable via: `apps/server/src/app.ts` mounts both routes; the buttons in the SPA
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** none

**Scope hint** `apps/server/src/api/boards-transfer.ts`, `apps/server/src/app.ts`, `apps/web/src/components/board-form/`, `apps/web/src/components/view-switcher/` · ~280 changed lines · Expected files: 7 reviewable

## M8 — Freshness

```epic
id: M8
milestone: M8
labels: [area:sync, area:auth, area:db, area:server, area:web]
depends: [M7]
```

**Done when** Webhooks applied, polling reconciliation with ETags, daily resync, guardrails, sync status UI

**Summary** Keep the cache fresh: verified webhooks trigger refetches and removals, polling with ETags reconciles every repo, a daily full resync is the safety net, background work respects suspension and the budget, and the UI shows sync status with a manual refresh.

**Design references** SPEC §6.2, §6.3, §6.5, §8.2, FR-3, FR-7, FR-8, FR-45, FR-46, FR-51, §10.1, D-11, D-12, D-20, SPEC §11 M8

**Goal** An issue changed on GitHub shows up in Crossboard within seconds with webhooks, or within the reconciliation interval without them, and the user can see when each repo last synced.

**Product rules** Apart from removals, webhooks never update issue fields from their payload; they enqueue a GraphQL refetch (D-11). Every delivery's signature is verified before parsing. The §6.5 guardrails are split: budget tracking lives in the client, the 2% detail cut-off in the details route, the 10% background pause here.

**Out of scope** Persisting jobs across restarts (SPEC §9.2).

### Verify and acknowledge GitHub webhook deliveries

```meta
id: M8.1
parent: M8
labels: [feat, area:sync, safety-critical]
depends: [M2.1, M2.7, M2.4]
```

**Summary** `POST /webhooks/github` verifies each delivery's signature, acknowledges it with `202` and hands it to the jobs interface, dropping deliveries for inactive installations.

**Design references** SPEC §6.2, FR-3, §7.4, §9.3 (CSRF exemption, logging), CLAUDE.md `### Implementation rules`, CLAUDE.md `### Risk review` (webhooks)

**Current state** nothing yet; the webhook secret is available through `apps/server/src/auth/credentials.ts`.

**Acceptance criteria**
- [ ] `X-Hub-Signature-256` is checked with a constant-time compare against the webhook secret (env or stored) before the body is parsed; a missing or invalid signature answers `401` with no job enqueued and no DB write (tests: tampered body, missing header, wrong secret)
- [ ] a valid delivery answers `202` and is enqueued by event name; deliveries for inactive installations are acknowledged and dropped, except the `installation` events that may change the active set
- [ ] the route is exempt from session and CSRF checks; payload bodies are never logged for private repos and only at `debug` for public ones; handlers receive the parsed payload and log only event, action and ids
- [ ] Reachable via: `apps/server/src/app.ts` mounts `POST /webhooks/github`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Applying issue events (owned by "Apply issue, sub-issue, dependency, comment and label webhooks"); installation events (owned by "Apply installation, repository and authorization webhooks").

**Scope hint** `apps/server/src/webhooks/`, `apps/server/src/app.ts` · ~250 changed lines · Expected files: 6 reviewable

### Apply issue, sub-issue, dependency, comment and label webhooks

```meta
id: M8.2
parent: M8
labels: [feat, area:sync, safety-critical]
depends: [M8.1, M3.6, M3.2]
```

**Summary** Handle `issues`, `sub_issues`, `issue_dependencies`, `issue_comment` and `label` deliveries: removals apply directly, everything else enqueues a debounced GraphQL refetch of the affected issues, following the SPEC §8.2 removal rules.

**Design references** SPEC §6.2, §8.2, D-11, §5.5 (payload fields never read; transfers as delete plus new), FR-42, CLAUDE.md `### Risk review` (webhooks)

**Current state** the sync stores whole repos; no single-issue refetch exists; the webhook route enqueues deliveries by event name.

**Acceptance criteria**
- [ ] a single-issue refetch by node id with the SPEC §5.3 selection updates the issue, its labels, assignees, refs and edges
- [ ] `issues` `closed`: the issue is removed and its ref becomes `CLOSED`, keeping edges where it blocks; `deleted`, `transferred`, and a refetch that finds the issue no longer readable: the ref and every edge mentioning it are deleted and every synced issue on the other side is refetched; a refetch that finds it closed follows the `closed` rule
- [ ] `issues` with any other action refetches the issue; `sub_issues` refetches parent and sub-issue; `issue_dependencies` refetches the blocked and the blocking issue; payload fields are never read
- [ ] `issue_comment` drops the issue's cached details
- [ ] `label` `edited` updates and `deleted` removes that label in the repo; other `label` actions do nothing
- [ ] refetches are debounced 5 s per issue and deduplicated through job keys
- [ ] integration tests with signed fixtures for each event, delivered through the webhook route
- [ ] Reachable via: the webhook route enqueues these handlers by event name
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Signature checks and payload logging (owned by "Verify and acknowledge GitHub webhook deliveries"); repository and installation events (owned by "Apply installation, repository and authorization webhooks").

**Scope hint** `apps/server/src/webhooks/handlers/`, `apps/server/src/sync/refetch.ts`, `apps/server/src/github/queries/` · ~380 changed lines (excluding fixtures) · Expected files: 9 reviewable

### Apply installation, repository and authorization webhooks

```meta
id: M8.3
parent: M8
labels: [feat, area:sync, area:auth, area:db, safety-critical]
depends: [M8.1, M3.4]
```

**Summary** Handle `installation`, `installation_repositories`, `repository` and `github_app_authorization` deliveries by calling the existing discovery, purge and access functions, setting an installation's suspended flag, and revoking a user's tokens and sessions.

**Design references** SPEC §6.2, FR-3, FR-7, FR-8, §8.2 (purging), D-7, §5.5 (`github_app_authorization` actions), CLAUDE.md `### Risk review` (cross-user isolation, tokens)

**Current state** access is computed at sign-in and hourly; discovery and purging exist in `apps/server/src/sync/discovery.ts` and run when the active set changes; installations are recorded from access computation only.

**Acceptance criteria**
- [ ] `installation` `created` records it and recomputes the active set (which runs discovery when it becomes active); `deleted` purges it and its repos; `suspend`/`unsuspend` set and clear its `suspended` flag, and `unsuspend` enqueues a reconciliation of its repos
- [ ] `installation_repositories` `added` runs discovery for the installation; `removed` purges those repos
- [ ] `repository` `archived`/`deleted` purge the repo; `renamed`/`transferred` update owner and name, then recompute access; `unarchived` marks it `pending`; `privatized`/`publicized` update the flag and recompute access
- [ ] `installation` and `installation_repositories` deliveries recompute access for every user with a live session, then the active set (FR-3, FR-8)
- [ ] after `installation_repositories` `removed` or a recompute that drops a repo, the affected user no longer sees that repo's issues through `GET /api/issues` (integration test)
- [ ] every `github_app_authorization` delivery deletes that user's tokens and sessions (FR-7)
- [ ] purges never delete boards or saved views (test)
- [ ] integration tests with signed fixtures for each event, delivered through the webhook route
- [ ] Reachable via: the webhook route enqueues these handlers by event name
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Skipping jobs of a suspended installation (owned by "Pause background sync for suspended or low-budget installations"); issue-level events (owned by "Apply issue, sub-issue, dependency, comment and label webhooks").

**Scope hint** `apps/server/src/webhooks/handlers/`, `apps/server/src/access/`, `apps/server/src/sync/discovery.ts` · ~350 changed lines (excluding fixtures) · Expected files: 8 reviewable

### Reconcile ready repositories by polling with ETags

```meta
id: M8.4
parent: M8
labels: [feat, area:sync]
depends: [M8.2]
```

**Summary** Every reconciliation interval, poll each ready repo's issues updated since `reconcile_since` with a conditional first page, remove closed issues and refetch open ones in batches through GraphQL.

**Design references** SPEC §6.3, FR-51, §7.5 (`CROSSBOARD_RECONCILE_INTERVAL_MIN`), §8.1 (`reconcile_since`, `rest_etag`, `last_reconciled_at`)

**Current state** single-issue refetch and removal exist in `apps/server/src/sync/refetch.ts`.

**Acceptance criteria**
- [ ] every `CROSSBOARD_RECONCILE_INTERVAL_MIN` minutes each ready repo is polled with `GET /repos/{o}/{r}/issues?state=all&since=<reconcile_since>&sort=updated&direction=asc&per_page=100`, following pagination
- [ ] the first page sends `If-None-Match: <rest_etag>`; a `304` ends the round for that repo; the ETag is stored for the first page only and cleared whenever `reconcile_since` changes
- [ ] pull requests are ignored; closed issues are removed as in SPEC §8.2; open ones are refetched by node id in batches of up to 50 via `nodes(ids: [...])`
- [ ] `reconcile_since` advances to the newest `updated_at` seen, stored as GitHub's string; `last_reconciled_at` records each completed round
- [ ] an integration test covers a `304` round, a changed issue, a closed issue and a pull request
- [ ] Reachable via: `apps/server/src/index.ts` schedules the reconciliation job
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** The manual refresh trigger (owned by "Show sync status, manual refresh and per-repo state").

**Scope hint** `apps/server/src/sync/reconcile.ts`, `apps/server/src/github/queries/`, `apps/server/src/index.ts` · ~280 changed lines · Expected files: 5 reviewable

### Run the daily full resync and prune orphaned references

```meta
id: M8.5
parent: M8
labels: [feat, area:sync]
depends: [M8.2]
```

**Summary** Re-run the initial sync once every 24 hours per repo, staggered, and delete `issue_refs` rows no longer referenced by any issue or dependency.

**Design references** SPEC §6.3 (daily full resync), §8.2, D-12, §5.5

**Current state** the initial sync runs only for `pending` repos.

**Acceptance criteria**
- [ ] each ready repo is fully resynced once every 24 hours, with start times spread over the day rather than all at once
- [ ] the resync prunes issues deleted or transferred without a webhook, and picks up relation changes that did not change `updatedAt`
- [ ] after a resync, `issue_refs` rows referenced by no issue parent and no `issue_deps` row are deleted
- [ ] Reachable via: `apps/server/src/index.ts` schedules the daily resync
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** none

**Scope hint** `apps/server/src/sync/`, `apps/server/src/index.ts` · ~180 changed lines · Expected files: 4 reviewable

### Pause background sync for suspended or low-budget installations

```meta
id: M8.6
parent: M8
labels: [feat, area:sync]
depends: [M8.3, M8.4, M8.5]
```

**Summary** Background jobs (discovery, sync, reconciliation, resync, refetches) never run for a suspended installation, and wait until the reset for an installation below 10% of its budget, while interactive detail fetches continue until 2%.

**Design references** SPEC §6.2 (`suspend`/`unsuspend`), §6.5, §6.1, FR-42

**Current state** jobs are marked background or interactive; the client tracks each installation's budget; the `suspended` flag is set by webhooks; nothing acts on either.

**Acceptance criteria**
- [ ] the rule lives in `apps/server/src/jobs/` and applies to every job marked background, whatever item added it
- [ ] a background job for a suspended installation is dropped; `unsuspend` re-enqueues work through the reconciliation its handler already enqueues
- [ ] a background job for an installation below 10% remaining is deferred until that installation's reset time, then runs
- [ ] interactive detail fetches are not paused by this rule and keep their 2% cut-off
- [ ] a pause, a drop and a resume are logged at `info` with installation and reason
- [ ] tests with a faked budget and a suspended installation cover drop, deferral, resume and the unaffected detail fetch
- [ ] Reachable via: the jobs interface started in `apps/server/src/index.ts` applies the rule
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** none

**Scope hint** `apps/server/src/jobs/`, `apps/server/src/sync/` · ~170 changed lines · Expected files: 4 reviewable

### Show sync status, manual refresh and per-repo state

```meta
id: M8.7
parent: M8
labels: [feat, area:server, area:web]
depends: [M8.4]
```

**Summary** Add `GET /api/sync` and `POST /api/sync/refresh`, the top bar's "Synced <time>" with a Refresh button, and per-repo sync state and per-installation budget on the settings page.

**Design references** FR-45, FR-46, SPEC §7.4 (sync routes), §6.3, §9.1, §10.1 (Sync status and Refresh, Settings page, Toast), D-20

**Current state** `/settings` lists installations only; the top bar has an empty sync-status slot; the shared time component exists.

**Acceptance criteria**
- [ ] `GET /api/sync` returns, for the session user's accessible repos only, each repo's state (`pending`, `syncing`, `ready`, `error` with message, `skipped` with reason) and last synced time, plus each active installation's remaining budget and reset time ("unknown" until the first call after a restart)
- [ ] the top bar shows "Synced <time>" with the shared time component, the oldest `last_synced_at` (the later of last full sync and last reconciliation) among the user's ready repos
- [ ] the Refresh Button calls `POST /api/sync/refresh`, which enqueues a reconciliation of the user's accessible repos at most once per 60 s per user (tracked in memory) and answers `429` with the remaining seconds otherwise, shown as a Toast
- [ ] `/settings` shows per-repo state Badges in a Table and per-installation budgets in Cards, with loading, empty and error states (component tests)
- [ ] a second user never sees another user's repos in `GET /api/sync` (integration test)
- [ ] Reachable via: `apps/server/src/app.ts` mounts the sync routes; the top bar and `apps/web/src/routes/settings.tsx`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** none

**Scope hint** `apps/server/src/api/sync.ts`, `apps/server/src/app.ts`, `apps/web/src/components/top-bar/`, `apps/web/src/routes/settings.tsx` · ~320 changed lines · Expected files: 8 reviewable

## M9 — Release

```epic
id: M9
milestone: M9
labels: [area:docs, area:ci]
depends: [M8]
```

**Done when** README with self-host guide and screenshots; repo made public; v0.1.0 tagged; image published to `ghcr.io/mdg-labs/crossboard` by a release workflow (D-5)

**Summary** Document self-hosting, add the release workflow that publishes the multi-arch image to GHCR on a version tag, and make the repository public with v0.1.0.

**Design references** D-1, D-5, D-16, SPEC §7.1 (packaging), §7.5, §4.8, SPEC §11 M9

**Goal** Anyone can read how to run Crossboard, pull `ghcr.io/mdg-labs/crossboard:0.1.0`, and set it up from the README alone.

**Out of scope** Hosted multi-tenant operation (SPEC §9.2).

### Write the README with a self-host guide and screenshots

```meta
id: M9.1
parent: M9
labels: [docs, area:docs]
depends: [M6.4, M7.4, M8.7]
```

**Summary** Replace the planning README with what Crossboard does, screenshots, and a self-host guide covering the container, configuration, first-run setup, installing the App and running without webhooks.

**Design references** SPEC §1, §2, §4.1, §4.8, §7.1 (packaging), §7.5, FR-51, D-1, D-3, D-5, D-14, D-16

**Current state** `README.md` says "Status: planning" and links the spec.

**Acceptance criteria**
- [ ] the README explains the product in a few lines with screenshots of the list, a board and the detail panel stored under `docs/images/`, taken from the e2e fake GitHub's fixtures so they show no private data
- [ ] the self-host guide covers: pulling `ghcr.io/mdg-labs/crossboard`, the `docker-compose.yml` example, every SPEC §7.5 variable, the `/setup` flow with the setup token from the log, installing the App on accounts and orgs, env credentials instead of setup, `CROSSBOARD_WEBHOOKS=false` for instances without a public URL, the `/data` volume and backups of `crossboard.db`, and what changing `CROSSBOARD_APP_SECRET` invalidates
- [ ] it states the limits: github.com only, open issues only, read-only, desktop-first
- [ ] no secret or token-shaped example value appears; placeholders read like `<your app secret>`
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** The release workflow (owned by "Publish the image to GHCR from a release workflow").

**Scope hint** `README.md`, `docs/images/` · ~200 changed lines · Expected files: 1 reviewable

### Publish the image to GHCR from a release workflow

```meta
id: M9.2
parent: M9
labels: [chore, area:ci, safety-critical]
depends: [M1.6, M8.7]
```

**Summary** Add `.github/workflows/release.yml`, which on a pushed `v*.*.*` tag builds the image for `linux/amd64` and `linux/arm64` and pushes `:<version>` and `:latest` to `ghcr.io/mdg-labs/crossboard` (D-16), and set the workspace version to 0.1.0.

**Design references** D-16, D-5, SPEC §7.1 (packaging), §7.6 (CI), `.claude/workflow.json` `act.neverRun`

**Current state** `ci.yml` builds the image and runs the end-to-end tests without publishing anything.

**Acceptance criteria**
- [ ] `release.yml` triggers only on tags matching `v*.*.*` and runs on `[self-hosted, runners01]`
- [ ] it runs `pnpm gate`, then builds both platforms with `docker buildx` and pushes `ghcr.io/mdg-labs/crossboard:<version>` (the tag without `v`) and `:latest`
- [ ] permissions are `contents: read` and `packages: write` only; it logs in with `GITHUB_TOKEN`; actions are pinned to a full commit SHA
- [ ] the image carries `org.opencontainers.image.source` pointing at the repository, so the package links to it
- [ ] the package versions are 0.1.0 and `/api/health` reports it
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Pushing the tag, making the repository public and the package's visibility (owned by "Make the repository public and release v0.1.0").

**Scope hint** `.github/workflows/release.yml`, `package.json`, `apps/server/package.json`, `apps/web/package.json`, `packages/query/package.json` · ~90 changed lines · Expected files: 5 reviewable

### Make the repository public and release v0.1.0

```meta
id: M9.3
parent: M9
labels: [chore, area:ci, maintainer-only]
depends: [M9.1, M9.2]
```

**Summary** The maintainer promotes everything to `main`, makes the repository public, tags v0.1.0, and makes the published GHCR package public (D-5).

**Design references** D-5, D-16, D-1, `.claude/rules/mdg-security.md` (disclosure after going public)

**Current state** the repository is private.

**Acceptance criteria**
- [ ] every SPEC §11 milestone before this one is on `main` through a merged pull request
- [ ] the repository is public; private vulnerability reporting is enabled
- [ ] tag `v0.1.0` on `main` ran the release workflow, and `ghcr.io/mdg-labs/crossboard:0.1.0` and `:latest` exist for both platforms
- [ ] the GHCR package is public and linked to the repository; an anonymous `docker pull ghcr.io/mdg-labs/crossboard:0.1.0` succeeds
- [ ] the checks of workflow.json for the touched paths pass

**Out of scope** Changes to the release workflow (owned by "Publish the image to GHCR from a release workflow").

**Scope hint** no repository files; GitHub repository and package settings, one tag · ~0 changed lines · Expected files: 0 reviewable
