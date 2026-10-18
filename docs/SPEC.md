# Crossboard — Product & Technical Spec (v1)

Status: Draft · Owner: @mdguggenbichler · Last updated: 2026-10-18

## 1. Summary

Crossboard is a web app that shows **all open GitHub issues across every repository** a user can reach (personal repos and repos of their organizations) in one place. It focuses on three things GitHub itself makes hard across repos:

1. **Dependencies:** which issue is blocked by which, and which issue blocks which, including cross-repo relationships.
2. **Custom Kanban boards** whose columns are defined by label / filter queries, with sub-issues collapsible.
3. **One filter language** (GitHub's issue search syntax) across everything.

v1 is **read-only** against GitHub. Every issue, label, repo and user links back to GitHub.

Crossboard is intended to become **open source** and self-hostable first, with a possible **hosted cloud version** later. v1 must not paint us into a corner for multi-tenant use (see §9).

## 2. Goals and non-goals

### Goals (v1)
- Aggregate open issues from all repos the user has installed the Crossboard GitHub App on (user account + orgs).
- Show labels (with GitHub colors), assignees, issue type, milestone, repo, parent / sub-issues, blocked-by / blocking.
- Filter with GitHub-style query syntax, including combinations.
- Let the user create, edit and delete custom Kanban boards.
- Detail view with rendered body and comments (read-only).
- Deep links to GitHub everywhere.
- Stay well within GitHub rate limits (see §6).
- Be as simple as possible to run: one container, one SQLite file.

### Non-goals (v1)
- Pull requests (not fetched, not shown).
- Writing anything to GitHub: no label changes, no status changes, no comments, no body edits. (Label/state changes are a v2 candidate, see §12.)
- GitHub Projects (v2) fields and views.
- Notifications, email, mobile apps.
- Multi-tenant hosting (design for it, don't build it).

## 3. Users and core use cases

Primary user: a developer or maintainer who works across many repos and orgs and wants one overview.

- **U1** "Show me every open issue assigned to me across all orgs." → `assignee:@me`
- **U2** "What is blocked, and by what?" → `is:blocked`, dependency badges, detail view.
- **U3** "Give me a board for `area:frontend` with columns `status:todo`, `status:in-progress`, `status:review`."
- **U4** "On this board, show epics with their sub-issues folded underneath."
- **U5** "Open the issue on GitHub" from anywhere in one click.

## 4. Functional requirements

### 4.1 Authentication & installation
- **FR-1** Sign in with GitHub via the Crossboard **GitHub App** (user-to-server OAuth web flow). No separate account system.
- **FR-2** After sign-in, show which accounts/orgs have the app installed and link to the installation page to add more orgs or repos.
- **FR-3** Only repos covered by an installation **and** accessible to the signed-in user are shown.
- **FR-4** Sign out invalidates the session. Tokens are stored encrypted at rest (§9.3).

### 4.2 Issue list view
- **FR-5** Default view: table/list of all open issues matching the active filter (default `is:open`).
- **FR-6** Columns: repo (`owner/name`), number, title, issue type, labels, assignees, milestone, dependency badges (`blocked by N`, `blocks N`), sub-issue progress (`3/5`), updated.
- **FR-7** Sort by updated, created, repo, title. Default: updated desc.
- **FR-8** Clicking a row opens the detail view; a separate icon opens the issue on GitHub.
- **FR-9** Clicking a label, assignee or repo adds the corresponding qualifier to the filter.

### 4.3 Filter language
GitHub-compatible subset, parsed and evaluated **locally** against the cache (no GitHub search API calls). Unknown qualifiers produce a visible, non-fatal warning.

| Qualifier | Example | Notes |
|---|---|---|
| state | `is:open`, `is:closed` | v1 only syncs open issues; `is:closed` returns empty with a hint |
| label | `label:bug`, `label:"good first issue"` | case-insensitive name match |
| label OR | `label:bug,security` | comma = OR (GitHub semantics) |
| label AND | `label:bug label:p1` | repeated = AND |
| negation | `-label:wontfix`, `-assignee:alice` | `-` prefix on any qualifier |
| no | `no:label`, `no:assignee`, `no:milestone` | |
| assignee | `assignee:alice`, `assignee:@me` | |
| author | `author:alice` | |
| repo / org / user | `repo:mdg-labs/crossboard`, `org:mdg-labs`, `user:mdguggenbichler` | |
| type | `type:Bug` | GitHub issue types |
| milestone | `milestone:"v1.0"` | |
| sub-issues | `has:sub-issues`, `has:parent`, `parent:mdg-labs/crossboard#12` | |
| dependencies (Crossboard extension) | `is:blocked`, `is:blocking`, `blocked-by:owner/repo#N`, `blocking:owner/repo#N` | `is:blocked` = has ≥1 **open** blocker |
| free text | `login crash` | matches title (and body if cached) |
| boolean | `label:bug AND (assignee:alice OR assignee:bob)` | `AND`, `OR`, parentheses; implicit AND between terms |

- **FR-10** The parser is a standalone, unit-tested module (`packages/query` or `src/query`), shared by frontend and backend.
- **FR-11** The filter is reflected in the URL (`?q=`) so views are shareable/bookmarkable.
- **FR-12** Autocomplete for qualifiers, label names, assignee logins and repo names from cached data.
- **FR-13** Saved filters ("views") can be named and stored per user.

### 4.4 Dependencies (blocked by / blocking)
- **FR-14** Each issue shows `blocked by` and `blocking` lists, sourced from GitHub's native issue dependencies.
- **FR-15** Cross-repo dependencies are supported. If the other issue is in a repo Crossboard can't read, show a stub (`owner/repo#N`, link only, "not accessible").
- **FR-16** Closed blockers are shown struck-through and don't count toward `is:blocked`.
- **FR-17** Cards and rows show a red "blocked" badge when `is:blocked` is true.
- **FR-18 (nice-to-have v1)** Detail view shows a small dependency graph (1 hop up/down).

### 4.5 Kanban boards
- **FR-19** A user can create any number of boards. Each board has: name, **base filter** (applies to all columns), ordered **columns**, sub-issue mode.
- **FR-20** Each column has a name and a **column filter** (usually a label, e.g. `label:"status: in progress"`, but any filter expression is allowed).
- **FR-21** Card placement: an issue matching the base filter is placed in the **first** column whose filter matches. An optional **"Other"** column (toggle) collects issues that match no column.
- **FR-22** Sub-issue mode per board:
  - **Collapsed** (default): sub-issues that would land on the board are not shown as separate cards; they appear nested inside the parent card behind an expand toggle with a progress count. A parent not matching the base filter is not pulled in; its sub-issues then show as normal cards.
  - **Expanded**: sub-issues are shown as their own cards; parent cards still show progress.
  - Each parent card can be expanded/collapsed individually; the per-card state is remembered locally.
- **FR-23** Cards show: repo, `#number`, title, labels, assignee avatars, type, blocked badge, sub-issue progress.
- **FR-24** Within a column, cards are sorted by a board-level sort (default: updated desc). No manual ordering in v1 (no writes, no local rank).
- **FR-25** Boards can additionally be narrowed by an ad-hoc filter bar without changing the saved board.
- **FR-26** Boards are stored in Crossboard's DB, per user. Export/import as JSON.
- **FR-27** No drag & drop in v1 (it would imply a write). See §12.

### 4.6 Detail view
- **FR-28** Opens as a side panel (list and board) and as its own route `/i/:owner/:repo/:number`.
- **FR-29** Shows title, state, repo, number, author, created/updated, type, milestone, labels, assignees, parent issue, sub-issues (with state), blocked by, blocking, rendered body, comments (author, time, rendered body), reactions summary optional.
- **FR-30** Markdown is rendered using GitHub's rendered HTML (`bodyHTML` from GraphQL), **sanitized** server-side before sending to the browser.
- **FR-31** Body and comments are fetched **lazily** on open and cached (§6).
- **FR-32** "Open on GitHub" button; every referenced issue, user, label and repo links to GitHub.

### 4.7 Sync status
- **FR-33** Header shows last sync time and a manual "Refresh" button (rate-limited, see §6).
- **FR-34** Settings page shows per-installation sync state and the current GitHub rate limit budget.

## 5. GitHub integration

### 5.1 Why a GitHub App
- Fine-grained permissions per installation; org owners approve once.
- Built-in **webhooks** per installation, which is the main tool against rate limits.
- User-to-server tokens act as the user, so visibility is always the intersection of "installed" and "user can see".
- Required permissions (v1): **Issues: read**, **Metadata: read**. Account permission: none. No PR permissions.
- Webhook events: `issues`, `issue_comment`, `label`, `sub_issues`, `issue_dependencies`, `installation`, `installation_repositories`, `repository` (rename/transfer/delete/visibility). Verify event names against current GitHub docs during implementation.

### 5.2 Self-hosting: one GitHub App per deployment
Every self-hosted instance registers its own GitHub App. To make this painless:
- **FR-35** First-run setup page uses the **GitHub App manifest flow** to create the app in one click (pre-filled name, permissions, events, callback and webhook URLs) and stores the returned credentials.
- **FR-36** Alternatively, credentials can be provided via env vars (`GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`).
- **FR-37** Instances without a public URL (e.g. on a laptop) work without webhooks by falling back to polling (§6.3).

### 5.3 Data fetched
Via GraphQL, per repository, open issues paginated 100 at a time:
`id, number, title, state, url, createdAt, updatedAt, author{login}, issueType{name,color}, milestone{title,url}, labels(first:50){name,color}, assignees(first:20){login,avatarUrl}, parent{id,number,repository{nameWithOwner}}, subIssuesSummary{total,completed}, subIssues(first:50){id,number,state,repository{nameWithOwner}}, blockedBy(first:50){id,number,state,title,url,repository{nameWithOwner}}, blocking(first:50){...same}`

Field names must be verified against the current GraphQL schema (issue dependencies and sub-issues are recent additions). Connections exceeding the `first:` limit get follow-up paginated queries.

Lazily, per issue on detail view: `bodyHTML`, `comments(first:100){author, createdAt, bodyHTML, url}`.

Repo list: `GET /user/installations` and `GET /user/installations/{id}/repositories` (REST, ETag-cached).

## 6. Rate limiting strategy

Budget reference: user-to-server tokens get 5,000 REST requests/hour and 5,000 GraphQL points/hour (higher for some org plans). Secondary limits (concurrency, points per minute) also apply.

### 6.1 Initial sync
- GraphQL, one query per repo page of 100 open issues. Typical cost: 1–2 points per page.
- Only repos with `hasIssuesEnabled` and `issues(states:OPEN).totalCount > 0` are paged. One cheap batched query (aliases, ~25 repos per query) gets these counts first.
- Concurrency: max 2 in-flight GraphQL requests per token. Respect `Retry-After` and `x-ratelimit-reset`.

### 6.2 Staying fresh: webhooks (primary)
- Webhook payloads are applied directly to the cache (upsert issue, remove on close/transfer/delete).
- For events whose payloads lack dependency or sub-issue details, re-fetch **that single issue** via GraphQL (debounced 5 s, deduplicated).
- Webhook signature (`X-Hub-Signature-256`) is verified; invalid requests are rejected.

### 6.3 Reconciliation: polling (safety net and no-webhook fallback)
- Every 15 min (configurable; 2 min when webhooks are disabled): per repo, `GET /repos/{o}/{r}/issues?state=all&since=<lastSync>&per_page=100` **with `If-None-Match`**. A `304 Not Modified` does not count against the rate limit.
- Changed issues are re-fetched via GraphQL in batches (`nodes(ids:[...])`).
- Issues returned by REST that are PRs (`pull_request` key present) are ignored.

### 6.4 Lazy detail data
- Body/comments fetched on detail open, cached with the issue's `updatedAt` as cache key; invalidated by webhooks or when `updatedAt` changes.

### 6.5 Guardrails
- A central GitHub client wraps all calls: tracks remaining budget, pauses background sync below 10% remaining, never blocks interactive detail fetches unless below 2%.
- Manual "Refresh" is limited to once per 60 s per user.
- All sync activity is logged with cost.

## 7. Architecture

Kept intentionally small: **one process, one container, one database file.**

```
Browser (React SPA)
   │  JSON over HTTP (cookie session)
   ▼
Server (Node.js + TypeScript, Hono)
   ├─ auth        GitHub App OAuth, sessions
   ├─ api         /api/issues, /api/boards, /api/views, /api/issue/:id
   ├─ webhooks    /webhooks/github
   ├─ sync        initial sync, reconciliation scheduler (in-process)
   ├─ github      rate-limit-aware client (GraphQL + REST, ETag cache)
   └─ query       filter parser/evaluator (shared with frontend)
   ▼
SQLite (via Drizzle ORM)
```

### 7.1 Stack
- **Language:** TypeScript everywhere.
- **Server:** Node.js 22 LTS, Hono, `@octokit/graphql` + `@octokit/rest` (or `octokit`), `@octokit/webhooks`.
- **DB:** SQLite with Drizzle ORM (keeps a path to Postgres for cloud, §9).
- **Frontend:** React + Vite, TanStack Query for data fetching, Tailwind CSS. Built into static files served by the same server.
- **Filtering location:** the server evaluates filters against SQLite-loaded data and returns results; the shared parser also runs in the browser for validation/autocomplete. (For a single user with a few thousand issues, an in-memory evaluation per request is fine.)
- **Testing:** Vitest (parser, placement logic, sync), Playwright for a few end-to-end smoke tests.
- **Packaging:** single `Dockerfile`, `docker-compose.yml` example, data volume for the SQLite file. Deployable on Coolify or any Docker host.
- **Repo layout:** a simple monorepo with pnpm workspaces: `apps/server`, `apps/web`, `packages/query`.

## 8. Data model (sketch)

```
users            id, github_id, login, avatar_url, created_at
user_tokens      user_id, access_token_enc, refresh_token_enc, expires_at
installations    id (github), account_login, account_type, created_at
repos            id (github node id), installation_id, owner, name, private, has_issues, last_synced_at, etag
user_repo_access user_id, repo_id                      -- who may see which repo
issues           id (node id), repo_id, number, title, state, url, author_login,
                 type_name, type_color, milestone_title, milestone_url,
                 parent_id, sub_total, sub_completed,
                 created_at, updated_at, synced_at
labels           id, repo_id, name, color
issue_labels     issue_id, label_id
issue_assignees  issue_id, login, avatar_url
issue_deps       blocked_issue_ref, blocking_issue_ref, -- refs as owner/repo#n + node id if known
                 blocking_state
issue_details    issue_id, body_html, comments_json, fetched_for_updated_at
boards           id, user_id, name, base_filter, sub_issue_mode, show_other, sort, created_at
board_columns    id, board_id, position, name, filter
saved_views      id, user_id, name, filter
```

Issue data is stored **once per repo** (not per user) and access is gated via `user_repo_access`. This is what makes the cloud version possible without remodeling.

## 9. Self-host first, cloud-ready

### 9.1 Decisions that keep cloud open
- Data is keyed by installation/repo, visibility via `user_repo_access` (never "all issues in the DB").
- Every API query is scoped by the session user. Add an integration test that a second user cannot see a repo they lack access to.
- DB access only through Drizzle; no SQLite-specific SQL outside the migrations folder.
- Background jobs go through a small `jobs` interface (in-process for v1), so they can later move to a queue.
- Config only via env vars (12-factor).

### 9.2 Not in v1, needed for cloud
- Postgres, horizontal scaling, job queue, billing, per-tenant limits, a public multi-tenant GitHub App, privacy policy/ToS.

### 9.3 Security
- Encrypt user tokens at rest (AES-256-GCM, key from `APP_SECRET`).
- Refresh expiring user tokens automatically (GitHub App user tokens expire after 8 h by default).
- HTTP-only, `SameSite=Lax`, secure cookies; CSRF protection on state-changing routes.
- Sanitize all rendered HTML (body, comments) server-side (e.g. `sanitize-html` with a GitHub-like allowlist); strict CSP.
- Never log tokens or webhook payload bodies of private repos at info level.

## 10. UX notes
- Layout: top bar (filter input, board/view switcher, sync status), main area (list or board), right side panel (detail).
- Keyboard: `/` focuses filter, `j/k` move selection, `enter` opens detail, `o` opens on GitHub, `esc` closes panel.
- Light/dark mode following the system.
- Empty states explain how to install the app on more orgs.

## 11. Milestones

| # | Milestone | Done when |
|---|---|---|
| M1 | Skeleton | Monorepo, Docker image, CI (lint, typecheck, test), health endpoint |
| M2 | Auth + install | Sign in via GitHub App, manifest-flow setup page, installations listed |
| M3 | Initial sync | All open issues of installed repos in SQLite incl. labels, assignees, sub-issues, dependencies |
| M4 | Query engine | Parser + evaluator with the full §4.3 table, ≥90% branch coverage |
| M5 | List view | Filterable list, URL state, autocomplete, saved views |
| M6 | Detail view | Lazy body/comments, sanitized, deep links, dependency lists |
| M7 | Boards | CRUD, column filters, placement rules, collapsed/expanded sub-issues |
| M8 | Freshness | Webhooks applied, polling reconciliation with ETags, rate-limit guardrails, sync status UI |
| M9 | Release prep | README with self-host guide, LICENSE, screenshots, v0.1.0 tag |

## 12. Future (v2+) candidates
- **Writes:** drag & drop between label-based columns changes labels (remove the source column's label, add the target's), close/reopen issues. Requires **Issues: write** and a clear rule for columns defined by complex filters (only columns with a single `label:` qualifier become drop targets).
- Pull requests linked to issues.
- Dependency graph view across a whole board.
- Hosted cloud version (§9.2).
- GitHub Projects fields as columns.

## 13. Open questions
1. License for the open-source release (proposed: MIT, or AGPL-3.0 if a hosted cloud version should be protected).
2. Should boards be shareable between users of the same instance in v1, or strictly personal?
3. Should closed issues be syncable later (e.g. "closed in last 14 days" column)?
