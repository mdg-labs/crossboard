# Crossboard — Product & Technical Spec (v1)

Status: Settled for v1 · Owner: @mdguggenbichler · Last updated: 2026-10-18

This spec is the single source of truth for v1. Requirements are numbered `FR-n`, decisions `D-n` (§13). Anything this document does not allow is out of scope; when something is genuinely undecided, it is listed in §14 instead of being left implicit. An implementer who finds a gap stops and asks rather than choosing silently.

## 1. Summary

Crossboard is a web app that shows **all open GitHub issues across every repository** a user can reach through the Crossboard GitHub App (personal repos and repos of their organizations) in one place. It focuses on three things GitHub itself makes hard across repos:

1. **Dependencies:** which issue is blocked by which, and which issue blocks which, including cross-repo relationships.
2. **Custom Kanban boards** whose columns are defined by filter queries, with sub-issues collapsible under their parent.
3. **One filter language** (GitHub's issue search syntax) across everything.

v1 is **read-only** against GitHub. Every issue, label, repo and user links back to GitHub.

Crossboard is **self-hosted** in v1 (one container, one SQLite file) and becomes open source at v0.1.0 (D-5). A hosted cloud version may follow later; v1 must not paint us into a corner for multi-tenant use (§9).

## 2. Goals and non-goals

### Goals (v1)
- Aggregate open issues from all repos covered by an **active** installation of the instance's GitHub App (§4.1) that the signed-in user can access.
- Show labels (with GitHub colors), assignees, issue type, milestone, repo, parent / sub-issues, blocked-by / blocking.
- Filter with GitHub-style query syntax, including boolean combinations (§4.3).
- Let the user create, edit, delete, export and import personal Kanban boards.
- Detail view with rendered body, comments, relations and a small dependency graph (read-only).
- Deep links to GitHub everywhere.
- Stay well within GitHub rate limits (§6).
- Be as simple as possible to run: one container, one SQLite file.

### Non-goals (v1)
- Pull requests (not fetched, not shown).
- Closed issues (not synced; see §12).
- Archived repositories (not synced, D-7).
- Writing anything to GitHub: no label changes, no status changes, no comments, no body edits, no drag & drop (§12).
- GitHub Projects (v2) fields and views.
- GitHub Enterprise Server or any host other than github.com (D-14).
- Notifications, email, mobile apps, mobile layouts, internationalization (English only, D-13).
- Reactions.
- Multi-tenant hosting (design for it, don't build it).

## 3. Users and core use cases

Primary user: a developer or maintainer who works across many repos and orgs and wants one overview. An instance serves one person or a small team whose GitHub logins or orgs are allow-listed (D-3).

- **U1** "Show me every open issue assigned to me across all orgs." → `assignee:@me`
- **U2** "What is blocked, and by what?" → `is:blocked`, dependency badges, detail view and graph.
- **U3** "Give me a board for `label:area:frontend` with columns `label:status:todo`, `label:status:in-progress`, `label:status:review`."
- **U4** "On this board, show epics with their sub-issues folded underneath."
- **U5** "Open the issue on GitHub" from anywhere in one click.

## 4. Functional requirements

### 4.1 Access, authentication and installation

**Who may use an instance (D-3).** The instance's GitHub App is registered as **public**, because a private GitHub App can only be installed on the account that owns it, and a user typically needs their personal account plus several orgs. Being public means anyone could install the App or try to sign in, so the instance restricts both:

- **FR-1 Allowlist.** `CROSSBOARD_ALLOWED_USERS` (comma-separated GitHub logins) and `CROSSBOARD_ALLOWED_ORGS` (comma-separated org logins). At least one of them must be non-empty, or the server refuses to start. Matching is case-insensitive.
- **FR-2 Allowed user.** A GitHub user is *allowed* if their login is in `CROSSBOARD_ALLOWED_USERS`, or if `GET /user/installations` (with their user token) returns an installation whose account login is in `CROSSBOARD_ALLOWED_ORGS`. Sign-in by anyone else is rejected after the OAuth callback with a page that says the account is not allowed on this instance; no session, token or user row is stored for them.
- **FR-3 Active installation.** An installation is *active* when its account login is in either allowlist, or when at least one allowed user's computed access includes it. Only active installations are synced. Installations by anyone else are recorded (id, account, created) and otherwise ignored; their webhooks are acknowledged with `202` and dropped. The active set is recomputed after every `installation` webhook and after every access computation (FR-8); an installation that becomes active gets repository discovery (§5.3) enqueued, and one that stops being active is purged (§8.2). An org installation whose account is not allow-listed therefore becomes active only once an allowed user who can access it has signed in.

**Sign-in.**
- **FR-4** Sign in with GitHub via the instance's GitHub App (user-to-server OAuth web flow). No separate account system, no passwords. The OAuth `state` parameter is a random value stored in a short-lived (10 min) HTTP-only cookie and verified on callback.
- **FR-5** Sessions are server-side rows (`sessions`), referenced by an HTTP-only, `Secure` (except on `http://localhost`), `SameSite=Lax` cookie `crossboard_session` holding a random 32-byte token; only its SHA-256 hash is stored. Sessions expire after 30 days of inactivity (sliding; `last_seen_at` updated at most once per hour).
- **FR-6** Sign-out deletes the session. When a user has no remaining sessions, their stored tokens are deleted too. A daily job deletes expired sessions and then the tokens of users left without a session.
- **FR-7** User tokens (access + refresh) are stored encrypted (§9.3). Access tokens expire after 8 h; before every use, an access token with less than 5 min left is refreshed first. Refresh tokens last 6 months and rotate on every refresh. A failed refresh (revoked or expired) deletes the user's tokens and sessions. A `github_app_authorization` webhook for a user (any action) does the same.

**User access.**
- **FR-8** A user's access is the set of `(installation, repo)` pairs returned by `GET /user/installations` and `GET /user/installations/{id}/repositories` with their user token. It is stored in `user_installations` and `user_repo_access` and recomputed: at sign-in; on `installation` and `installation_repositories` webhooks (for every user with a live session); on `repository` `privatized`/`publicized`/`transferred` webhooks; and every 60 min for users with a live session. Users without a live session keep their last computed access, but it is never used, because every API call requires a session.
- **FR-9** Only repos in the session user's `user_repo_access` are ever returned by any API (§9.1).
- **FR-10** After sign-in, the settings page shows which accounts/orgs have the App installed (from `user_installations`), whether each is active, and a link to `https://github.com/apps/<slug>/installations/new` to add more orgs or repos.
- **FR-10a** Any SPA route requested without a session redirects to `/auth/login?return=<path>`; after sign-in the user lands on that path (only same-origin relative paths are honoured). This covers GitHub sending a user to the App's `setup_url` (`/settings`) after installing.

### 4.2 Issue list view
- **FR-11** Default route `/`: a virtualized list of all open issues matching the active filter (default `is:open`), with a total count.
- **FR-12** Columns: repo (`owner/name`), number, title, issue type (colored pill, §5.4), labels (GitHub colors), assignee avatars, milestone, dependency badges (`blocked by N`, `blocks N`, where N counts open readable relations plus not-accessible ones, FR-24; a badge with N = 0 is hidden), sub-issue progress (`completed/total`, only when total > 0), updated (relative time, absolute in a tooltip).
- **FR-13** Sort options: `updated-desc` (default), `updated-asc`, `created-desc`, `created-asc`, `repo-asc` (then number asc), `title-asc`. Sorting and paging happen on the server (§7.4); the list loads 100 rows per page as the user scrolls.
- **FR-14** Clicking a row opens the detail panel; a separate icon opens the issue on GitHub in a new tab.
- **FR-15** Clicking a label, assignee or repo appends the corresponding qualifier (`label:"x"`, `assignee:x`, `repo:o/r`) to the filter. Labels are matched by name across repos; the same name may have different colors in different repos, and each pill shows its own repo's color. A label whose name contains a double quote cannot be expressed in the filter language; clicking it does nothing.
- **FR-16** The list shows explicit loading (skeleton rows), empty ("No open issues match this filter", plus the install link when the user has no active installations), and error states (message plus retry).

### 4.3 Filter language
A GitHub-compatible subset, parsed and evaluated **locally** against the cache (no GitHub search API calls). The parser and evaluator live only in `packages/query` (FR-21).

**Syntax.**
- Terms are separated by whitespace; adjacent terms are combined with implicit `AND`.
- `AND`, `OR` (uppercase only; lowercase `and`/`or` are free text) and parentheses. `AND` binds tighter than `OR`; implicit AND has the same precedence as explicit `AND`. At most 5 parentheses may be open at once.
- A qualifier is `name:value`. Qualifier names are case-insensitive. Values are matched case-insensitively and exactly (not as substrings), except free text.
- Values containing spaces use double quotes: `label:"good first issue"`. There is no escape sequence; a value cannot contain a double quote.
- `-` before any qualifier negates it (`-label:wontfix`, `-is:blocked`, `-no:label`). `-` before a parenthesized group or free text (including `-#123`) is a syntax error.
- A comma inside a value means OR for every qualifier that takes a value: `label:bug,security`, `assignee:alice,@me`, `repo:o/a,o/b` (D-10). `label:"a b",c` is valid. An empty value (`label:`) or an empty element (`label:a,`) is a syntax error.
- Issue references (`parent:`, `blocked-by:`, `blocking:`) must have the form `owner/repo#N`; anything else is a syntax error.
- A known qualifier with an unknown value (`is:draft`, `no:foo`, `has:foo`) is treated like an unknown qualifier (FR-17).
- Repeated qualifiers are ANDed (`label:bug label:p1` = both labels).

**Qualifiers.**

| Qualifier | Example | Semantics |
|---|---|---|
| state | `is:open`, `is:closed` | All cached issues are open. `is:open` matches everything; `is:closed` matches nothing and adds the hint "Crossboard only syncs open issues". |
| kind | `is:issue`, `is:pr` | `is:issue` matches everything; `is:pr` matches nothing with the hint "Pull requests are not shown". |
| label | `label:bug` | Has a label with that name. |
| no | `no:label`, `no:assignee`, `no:milestone`, `no:type`, `no:parent` | Has none of that. |
| has | `has:sub-issues`, `has:parent`, `has:dependencies` | `has:sub-issues`: sub-issue total > 0. `has:parent`: parent set. `has:dependencies`: blocked by or blocking anything. |
| assignee | `assignee:alice`, `assignee:@me` | `@me` is the session user's login. |
| author | `author:alice`, `author:@me` | Author login; deleted authors are `ghost`. |
| repo | `repo:mdg-labs/crossboard` | `owner/name` only; a bare name is a syntax error. |
| org / user | `org:mdg-labs`, `user:mdguggenbichler` | Both match the repo owner login, whatever the owner type. |
| type | `type:Bug` | Issue type name. |
| milestone | `milestone:"v1.0"` | Milestone title (matches every repo with that title). |
| parent | `parent:mdg-labs/crossboard#12` | Direct parent is that issue. |
| dependencies | `is:blocked`, `is:blocking`, `blocked-by:owner/repo#N`, `blocking:owner/repo#N` | Crossboard extensions; semantics in §4.4. |
| free text | `login crash`, `"login crash"` | Case-insensitive substring of the **title** only (D-9). A quoted phrase must match as a whole. A term of the form `#123` matches issue number 123. |

**Errors and warnings.**
- **FR-17** Unknown qualifiers (and `sort:`, `in:`, `reason:` etc.) are ignored: they match everything and produce a visible, non-fatal warning naming the qualifier. The hints of `is:closed` and `is:pr` are warnings too. A warning is `{ message, start, end }` (character offsets into the query, end exclusive).
- **FR-18** Syntax errors (unbalanced parentheses or quotes, dangling `AND`/`OR`, negated group or free text, bare repo name, malformed issue reference, empty value or element, more than 5 open parentheses) make the query invalid. The error is `{ message, start, end }`. The API answers `400` with it; the UI underlines the range and keeps showing the last valid results.
- **FR-19** The filter is reflected in the URL (`?q=`) so views are shareable and bookmarkable. Sort is reflected as `?sort=`.
- **FR-20** Autocomplete suggests qualifier names, and values for `label`, `assignee`, `author`, `repo`, `org`/`user`, `type` and `milestone`, from cached data of the user's accessible repos (`GET /api/suggest?field=<qualifier>&prefix=<text>`, where `field` is the qualifier name, `org` and `user` being equivalent, and `prefix` is the text after the last comma with quotes stripped; case-insensitive prefix match, at most 20 values). Suggestions appear after the `:` of a qualifier and after commas.
- **FR-21** `packages/query` exports `parse(query) → { ast, warnings } | { error }` (shapes per FR-17/FR-18) and `evaluate(ast, issue, context) → boolean`, where `issue` implements the `FilterableIssue` interface defined there and `context` carries `viewerLogin`. It has no runtime dependencies and runs unchanged in Node and the browser. The server evaluates filters; the browser uses the same parser only for validation, highlighting and autocomplete.
- **FR-22** Saved views: a user can name the current filter + sort and store it (`saved_views`, unique name per user, max 100 characters), rename it and delete it. A duplicate name answers `409`; an invalid filter answers `400` with the parse error. Views appear in the view/board switcher. They are strictly personal (D-2).

### 4.4 Dependencies (blocked by / blocking)
- **FR-23** Each issue shows `blocked by` and `blocking` lists, sourced from GitHub's native issue dependencies (`Issue.blockedBy` / `Issue.blocking`). Each entry shows `owner/repo#N`, title and state, and links to GitHub; entries for synced issues also open the detail panel.
- **FR-24** Cross-repo dependencies are supported. The number of *not-accessible* relations on a side is `max(0, total − readable)`, where `total` is GitHub's `issueDependenciesSummary.totalBlockedBy` / `totalBlocking` from the issue's last fetch (stored as `blocked_by_total` / `blocking_total`) and `readable` is the issue's `issue_deps` rows on that side. When it is above zero, the list ends with "+N not accessible" (no link, since the issue's identity is unknown).
- **FR-25** **`is:blocked`** is true when the issue has at least one readable blocker whose state is `OPEN`, or at least one not-accessible blocker (assumed open). **`is:blocking`** is true when the issue blocks at least one readable open issue or at least one not-accessible one. Closed blockers are shown struck-through and never count. `blocked-by:o/r#N` / `blocking:o/r#N` match a readable relation to that issue, whatever its state.
- **FR-26** Cards and rows show a red "blocked" badge when `is:blocked` is true.
- **FR-27** **Dependency graph** (D-6): the detail view shows an inline SVG with three columns: the issue's blockers on the left, the issue in the middle, the issues it blocks on the right (one hop each way). Nodes show `repo#N` and the title truncated to 40 characters; closed nodes are struck-through and greyed; edges are straight lines from each blocker to the issue and from the issue to each blocked issue. At most 15 nodes per side are drawn, then a "+N more" node; not-accessible relations are one "+N not accessible" node. Clicking a node opens that issue's detail (synced issues) or GitHub (others). It is rendered by hand-written SVG in `apps/web`, with no graph library. With no dependencies at all, the graph is omitted.

### 4.5 Kanban boards
- **FR-28** A user can create any number of boards. Each board has: name (1–100 chars), **base filter** (may be empty = all open issues), ordered **columns** (1–20), sort (same options as FR-13, default `updated-desc`), sub-issue mode (`collapsed` default, or `expanded`), and an "Other" column toggle (default off).
- **FR-29** Each column has a name (1–100 chars) and a **column filter** (any filter expression, usually `label:"status: in progress"`). Filters are validated with `packages/query` on save; an invalid filter blocks saving with the parse error.
- **FR-30** **Placement:** an issue matching the base filter (and the ad-hoc filter, FR-34) is placed in the **first** column, in column order, whose filter matches. If it matches none, it goes to "Other" when enabled (always shown last), otherwise it is not shown.
- **FR-31** **Sub-issue mode:**
  - **Collapsed:** an issue whose *nearest placed ancestor* exists is not shown as its own card; it is listed inside that ancestor's card, behind an expand toggle that shows `completed/total` progress. "Placed" means the issue was placed in some column by FR-30; an issue that is not placed never appears, nested or not. The ancestor chain is followed through `parent_id` across synced issues only, skipping ancestors that are synced but not placed; a parent that is not synced (closed, or in an inaccessible repo) ends the chain, and a chain that revisits an issue (cycle) ends before the repeat. Column header counts include only top-level cards. Nested sub-issues are listed under the nearest placed ancestor and can themselves be expanded. A nested sub-issue shows its own column name as a small tag. The progress count is GitHub's `subIssuesSummary` (all sub-issues, including closed and off-board ones).
  - **Expanded:** every placed issue is its own card; parent cards still show progress.
  - Each parent card can be expanded or collapsed individually. The per-card state is kept in the browser's `localStorage` (key `crossboard:board:<boardId>:expanded`) and survives reloads; if storage is unavailable, cards start collapsed.
- **FR-32** Cards show repo, `#number`, title, labels, assignee avatars, type, the blocked badge and sub-issue progress. Column headers show the card count. A column renders at most 200 cards, then a "Show N more" button.
- **FR-33** Within a column, cards follow the board's sort. No manual ordering in v1.
- **FR-34** A board can be narrowed by an ad-hoc filter bar (`?q=` on the board URL) without changing the saved board. Next to it, a repo picker (multi-select over the user's accessible repos, searched through `GET /api/suggest?field=repo`) sets the one top-level `repo:` term of the ad-hoc filter; with nothing picked, the term is absent and the board shows all repos (D-21).
- **FR-35** Boards are stored in Crossboard's DB and are **strictly personal** (D-2): only their owner can see or edit them; another user's board id answers `404`.
- **FR-36** **Export / import:** a board exports as JSON `{ "crossboard": "board", "version": 1, "name", "baseFilter", "sort", "subIssueMode", "showOther", "columns": [{ "name", "filter" }] }`. Import accepts at most 256 KB, validates the shape, enums, limits (FR-28, FR-29) and every filter, and answers `400` naming the first problem (including any `version` other than 1). It always creates a new board and never overwrites. Board names need not be unique.
- **FR-37** Boards are edited in a form: name, base filter, sort, sub-issue mode, Other toggle, and a column list with add, remove, rename, edit filter, and move up/down. No drag & drop (§12).
- **FR-38** Routes: `/b/:boardId` (board), `/b/:boardId/edit`, `/b/new`.

### 4.6 Detail view
- **FR-39** Opens as a right side panel over the list and boards, and as its own route `/i/:owner/:repo/:number`. Only synced (open, accessible) issues have a detail view; links to anything else go to GitHub.
- **FR-40** Shows: title, state, `owner/repo#number`, author, created/updated, type, milestone, labels, assignees, parent issue, sub-issues (each with state), blocked by, blocking, dependency graph (FR-27), rendered body, and comments (author, time, rendered body).
- **FR-41** Body and comment HTML come from GitHub's rendered HTML (`bodyHTML`), **sanitized** on the server (§9.3) before storage and delivery. The web app renders it inside a `markdown-body` container styled with `github-markdown-css` (light and dark).
- **FR-42** Body, comments and the sub-issue list are fetched **lazily** when the detail opens and cached in `issue_details`. The cache is valid while the issue's `updated_at` matches **and** the copy is younger than 10 minutes (private-repo image URLs in GitHub's HTML expire after a few minutes). A stale or missing copy is refetched on open: the details route waits for the fetch, while the panel shows the summary immediately and the body when it arrives. Concurrent requests for the same issue share one fetch. If the fetch fails, the route returns the stale copy with `stale: true` when one exists; otherwise `503` (budget below 2% or installation suspended, with the reset time when known) or `502` (GitHub error), and the panel shows the error with a retry button.
- **FR-43** Comments: the most recent 100 (`comments(last: 100)`), oldest first; when the issue has more, a "N earlier comments on GitHub" link precedes them. Sub-issues: the first 50; when there are more, "+N more on GitHub".
- **FR-44** An "Open on GitHub" button; every referenced issue, user, label and repo links to GitHub.

### 4.7 Sync status and settings
- **FR-45** The header shows "Synced <time>", where time is the oldest `last_synced_at` (the later of the last full sync and the last reconciliation) among the user's `ready` repos, and a "Refresh" button. Refresh enqueues a reconciliation (§6.3) of the user's accessible repos and is limited to once per 60 s per user, tracked in memory (`429` with the remaining seconds otherwise).
- **FR-46** The settings page (`/settings`) shows the user's installations (FR-10), per-repo sync state (`pending`, `syncing`, `ready`, `error` with message, `skipped` with reason), and each active installation's remaining GitHub budget and reset time. The budget is tracked in memory and shows "unknown" until the first GitHub call after a restart.

### 4.8 First-run setup
Nobody registers the GitHub App by hand. The setup page creates it from a **GitHub App manifest** with every permission, event and URL already filled in; the operator only confirms the name on GitHub and clicks "Create". Installing the App on accounts and orgs is the one other click each, through the link in FR-10. The env-var path (FR-50) exists for reusing an App that already exists, e.g. after moving an instance.
- **FR-47** When no GitHub App credentials exist (neither env vars nor stored config), the server generates a random setup token at every start, stores its hash (replacing any previous one), logs it at `warn` level, and serves only `/setup` (all other routes redirect there; `/api/health` stays available). A lost token is recovered by restarting.
- **FR-48** `/setup` asks for the setup token; a correct token sets a short-lived (30 min) HTTP-only cookie signed with an HMAC key derived from `CROSSBOARD_APP_SECRET`, which the remaining setup steps require instead of a session. It then asks for the GitHub account that should own the App (personal account, or an org login), and submits a **GitHub App manifest** to `https://github.com/settings/apps/new` (or `/organizations/<org>/settings/apps/new`). The manifest sets: `name` (default `Crossboard (<host>)`, editable), `url` and `redirect_url` from `CROSSBOARD_PUBLIC_URL`, `callback_urls: [<PUBLIC_URL>/auth/callback]`, `setup_url: <PUBLIC_URL>/settings`, `public: true`, `request_oauth_on_install: false`, `hook_attributes: { url: <PUBLIC_URL>/webhooks/github, active: <CROSSBOARD_WEBHOOKS> }`, `default_permissions: { issues: read, metadata: read }`, and `default_events` from §5.1.
- **FR-49** The manifest form carries a random `state`, also stored in the setup cookie. GitHub redirects back to `/setup/callback?code=…&state=…`; the server rejects a missing or mismatched `state`, then exchanges the code via `POST /app-manifests/{code}/conversions` (valid for 1 hour) and stores `id`, `slug`, `client_id`, `client_secret`, `webhook_secret` and `pem` encrypted in `app_config`. Setup is then closed (`/setup` answers `404`) until the stored credentials are deleted.
- **FR-50** Alternatively, credentials come from env vars (§7.5); when all of them are set they take precedence over stored config and the setup page is never served. A partial set is a startup error.
- **FR-51** Instances without a public URL (e.g. on a laptop) set `CROSSBOARD_WEBHOOKS=false` and rely on polling (§6.3). GitHub OAuth accepts `http://localhost` callback URLs.

## 5. GitHub integration

### 5.1 The GitHub App
- Fine-grained permissions per installation; org owners approve once.
- Webhooks per App, which are the main tool against rate limits.
- Permissions (v1): **Issues: read**, **Metadata: read**. No account permissions, no PR permissions, no write permissions anywhere.
- Subscribed events (`default_events`): `issues`, `issue_comment`, `label`, `sub_issues`, `issue_dependencies`, `repository`. GitHub delivers `installation`, `installation_repositories` and `github_app_authorization` to every App without a subscription.

### 5.2 Which token does what (D-4)
- **Installation access tokens** (from the App's private key, valid 1 h, cached until 5 min before expiry) are used for **all data fetching**: initial sync, reconciliation, webhook-triggered refetches and lazy detail fetches. Issue data is stored once per repo, independent of which user is signed in, and each installation has its own budget.
- **User access tokens** are used only for sign-in identity (`GET /user`) and computing access (FR-8). A detail fetch happens only after the session user's access to the repo has been checked against `user_repo_access`.

### 5.3 Data fetched
**Repository discovery** per active installation: `GET /installation/repositories` (installation token, paginated, ETag-cached). Then one batched GraphQL query per ~25 repos (aliases) for `isArchived`, `hasIssuesEnabled` and `issues(states: OPEN) { totalCount }`. Archived repos and repos with issues disabled are marked *skipped* with the reason; repos with zero open issues are marked `ready` without paging.

**Open issues** per repository via GraphQL, `issues(states: OPEN, first: 100, after: …)`, selecting:

```
id databaseId number title url createdAt updatedAt
author { login }
issueType { name color }
milestone { title url }
labels(first: 20) { totalCount nodes { id name color description } }
assignees(first: 10) { totalCount nodes { login avatarUrl } }
parent { id number title state url repository { nameWithOwner } }
subIssuesSummary { total completed }
issueDependenciesSummary { totalBlockedBy totalBlocking }
blockedBy(first: 20) { totalCount nodes { id number title state url repository { nameWithOwner } } }
blocking(first: 20)  { totalCount nodes { id number title state url repository { nameWithOwner } } }
```

When a connection's `totalCount` exceeds the page, follow-up queries page that connection for the affected issues. `issueType.color` is an enum (§5.4); `Label.color` is a hex string without `#`. The REST issue list is never used for issue data.

**Lazily, per issue** when the detail opens: `bodyHTML`, `comments(last: 100) { totalCount nodes { url createdAt author { login avatarUrl } bodyHTML } }`, `subIssues(first: 50) { totalCount nodes { id number title state url repository { nameWithOwner } } }`.

### 5.4 Issue type colors
GitHub returns issue-type colors as an enum. The web app maps them to fixed hex values (Primer): `GRAY #6e7781`, `BLUE #0969da`, `GREEN #1a7f37`, `YELLOW #9a6700`, `ORANGE #bc4c00`, `RED #d1242f`, `PINK #bf3989`, `PURPLE #8250df`. An unknown value renders as GRAY. Issue types are an organization feature; issues in personal repos have no type and show none.

### 5.5 GitHub behaviour to confirm before building on it
These are not stated by GitHub's documentation. Early in M3, once the maintainer's instance exists (D-15), the maintainer runs a spike (it needs a real installation) that checks each against real deliveries and queries and records the results in this section. It does not block other work: until a row is confirmed, the implementation uses its fallback.

| Behaviour | Fallback until confirmed |
|---|---|
| GraphQL dependency and sub-issue fields need no preview header | Send no header; the spike confirms |
| Fields carried by `issues` webhook payloads (type, sub-issue and dependency summaries) | Never read them: every relevant webhook triggers a GraphQL refetch (§6.2) |
| Whether a transferred issue keeps its node id | Treat as delete in the source repo + new issue in the destination |
| Whether `blockedBy`/`blocking` omit issues the installation can't read, and whether the summary totals include them | Compute "not accessible" as total minus readable entries (FR-24) |
| Whether adding or removing a dependency or sub-issue changes `updatedAt` | Assume it does not: the daily full resync (§6.3) is the safety net |
| Whether `totalBlockedBy`/`totalBlocking` include closed issues | Assume they do (closed relations stay in `issue_deps` with state `CLOSED`, so FR-24's subtraction stays consistent) |
| Actions of `github_app_authorization` | Act on every delivery of that event (FR-7) |
| Issue types on user-owned repos | `issueType` may be null anywhere |

## 6. Rate limiting strategy

Budget reference (installation tokens): 5,000 REST requests/hour and 5,000 GraphQL points/hour per installation, rising by 50/hour per repository beyond 20, up to 12,500. Secondary limits: at most 100 concurrent requests, 2,000 GraphQL points and 900 REST points per minute. Conditional REST requests answered `304 Not Modified` with an `Authorization` header do not count against the primary limit.

### 6.1 Initial sync
- Triggered when a repo becomes part of an active installation and has `sync_state = pending`: on installation, on repositories added, when an installation becomes active, and at startup for any pending repo.
- One GraphQL query per page of 100 open issues. The selection in §5.3 costs about 4 points per page (one request per nested connection per 100 issues); the client logs the actual `rateLimit { cost }` of each query.
- Concurrency: at most 2 in-flight GitHub requests per installation and 4 overall. On `403`/`429` with `retry-after` or `x-ratelimit-reset`, the client waits as told; other failures retry 3 times with exponential backoff (1 s, 4 s, 16 s), then mark the repo `error` with the message.
- A repo's issues are replaced atomically when its sync completes (open issues no longer returned are deleted).

### 6.2 Staying fresh: webhooks (primary)
- Every delivery is verified (`X-Hub-Signature-256`, constant-time compare) before parsing; invalid deliveries get `401` and have no effect. Valid deliveries are acknowledged with `202` immediately and processed by the jobs interface.
- Deliveries for inactive installations are dropped (FR-3).
- `issues` `closed`, `deleted`, `transferred`: remove the issue (§8.2). `issues` with any other action: refetch that issue via GraphQL.
- `sub_issues`: refetch the parent and the sub-issue. `issue_dependencies`: refetch the blocked and the blocking issue.
- `issue_comment`: drop the cached details of that issue.
- Milestones are not subscribed: a renamed milestone shows its old title until the issue is next refetched or the daily resync runs.
- `label` `edited`/`deleted`: update or remove that label in the repo. Other `label` actions: no effect.
- `repository` `archived`/`deleted`: purge the repo's data. `renamed`/`transferred`: update owner/name, then recompute access. `unarchived`: mark the repo `pending`. `privatized`/`publicized`: update the flag and recompute access.
- `installation` `created`: record; when active, discover repos. `deleted`: purge the installation and its repos. `suspend`/`unsuspend`: pause or resume syncing. `installation_repositories` `added`/`removed`: discover the added repos / purge the removed ones.
- Refetches are debounced 5 s per issue and deduplicated. A refetched issue that is no longer open or no longer readable is removed.

### 6.3 Reconciliation: polling (safety net and no-webhook fallback)
- Every `CROSSBOARD_RECONCILE_INTERVAL_MIN` minutes (default 15; 2 when `CROSSBOARD_WEBHOOKS=false`): for each ready repo, `GET /repos/{o}/{r}/issues?state=all&since=<reconcile_since>&sort=updated&direction=asc&per_page=100`, following pagination. The first page is sent with `If-None-Match: <rest_etag>`; a `304` costs nothing and ends the round for that repo. The ETag is stored for the first page only and cleared whenever `reconcile_since` changes, so `304`s happen exactly while nothing has changed.
- Returned items that are pull requests (`pull_request` key present) are ignored. Closed issues are removed. Open ones are refetched via GraphQL by their `node_id` in batches of up to 50 (`nodes(ids: [...])`) with the §5.3 selection. `reconcile_since` (GitHub's ISO 8601 string, stored as-is) is set to the start time of the repo's initial sync and then advances to the newest `updated_at` seen; `last_reconciled_at` records each completed round.
- Issues that became unreadable without a webhook (e.g. access removed) are not visible to this route; the daily resync prunes them.
- **Daily full resync:** once every 24 h per repo (staggered), the initial sync runs again. It prunes issues that were deleted or transferred without a webhook, and picks up dependency or sub-issue changes that did not change `updatedAt` (§5.5).

### 6.4 Lazy detail data
- Fetched on detail open (FR-42) with the installation token of the issue's repo.

### 6.5 Guardrails
- One central GitHub client wraps every call (REST and GraphQL): it attaches the right token, tracks each installation's remaining budget from response headers and `rateLimit`, and enforces the concurrency limits.
- Background work (sync, reconciliation, refetches) pauses for an installation below 10% remaining until its reset; interactive detail fetches continue until 2% remaining, then answer `503` with the reset time.
- Every GitHub call is logged at `debug` with installation, repo, cost and remaining budget; each completed sync of a repo is logged at `info` with page count and total cost.

## 7. Architecture

Kept intentionally small: **one process, one container, one database file.**

```
Browser (React SPA)
   │  JSON over HTTP (session cookie)
   ▼
Server (Node.js 24 + TypeScript, Hono)
   ├─ auth        GitHub App OAuth, sessions, first-run setup
   ├─ access      allowlist, user access computation, query scoping
   ├─ api         /api/* routes
   ├─ boards      card placement
   ├─ webhooks    /webhooks/github
   ├─ sync        initial sync, reconciliation, refetches
   ├─ jobs        in-process job queue and scheduler
   ├─ github      rate-limit-aware client (GraphQL + REST, ETag cache, token cache)
   ├─ security    encryption, HTML sanitizer, CSP
   └─ db          Drizzle schema, migrations
   ▼
SQLite (better-sqlite3, WAL)            packages/query: parser/evaluator, shared with the web app
```

### 7.1 Stack (D-8)
- **Language:** TypeScript (strict, `noUncheckedIndexedAccess`) everywhere, ES modules.
- **Runtime and tooling:** Node.js 24 LTS (pinned by `.nvmrc` and `engines`), pnpm 10 workspaces (`packageManager` field), no Turborepo.
- **Server:** Hono on `@hono/node-server`; Zod 4 with `@hono/zod-validator` for every request; `octokit` (App auth for installation tokens, GraphQL, REST) and `@octokit/webhooks` (signature verification); `pino` for JSON logs to stdout; `sanitize-html` for GitHub HTML.
- **DB:** SQLite through Drizzle ORM with `better-sqlite3`, WAL mode, foreign keys on. Migrations generated by `drizzle-kit` into `apps/server/src/db/migrations/` and applied automatically at startup.
- **Frontend:** React 19 + Vite, TanStack Router (code-based routes), TanStack Query, TanStack Virtual (list), Tailwind CSS 4, coss ui components on Base UI (D-20, component map in §10.1), `lucide-react` icons, Inter and Geist Mono bundled from npm font packages, `github-markdown-css`. Built into static files served by the server.
- **API typing:** the web app calls the server through Hono's typed RPC client (`hc<AppType>`); request and response shapes are the Zod schemas in `apps/server`.
- **Testing:** Vitest everywhere; `msw` fakes GitHub's REST, GraphQL and OAuth endpoints in server tests; Playwright end-to-end tests run against the built container with a fake GitHub server (§7.6). No test ever calls the real GitHub.
- **Lint and format:** ESLint flat config with `typescript-eslint` (strict), Prettier (default settings).
- **Packaging:** one multi-stage `Dockerfile` (Node 24 slim, non-root user, `/data` volume, port 3000, `HEALTHCHECK` on `/api/health`), an example `docker-compose.yml`. Deployable on Coolify or any Docker host. Images are built for `linux/amd64` and `linux/arm64`.

### 7.2 Repository layout

```
apps/server/            @crossboard/server
  src/index.ts          process entry: config, migrations, scheduler, HTTP listen
  src/app.ts            Hono app: middleware, route mounting, static SPA serving; exports AppType
  src/config/           env schema and loading (the only place that reads process.env)
  src/auth/             OAuth, sessions, setup/manifest flow
  src/access/           allowlist, access computation, scoping helpers
  src/api/              route modules: issues, boards, views, suggest, sync, me
  src/boards/           placement and sub-issue nesting (pure functions)
  src/issues/           loading the session user's accessible issues and mapping them to FilterableIssue
  src/webhooks/         route and event handlers
  src/sync/             initial sync, reconciliation, refetch
  src/jobs/             jobs interface and in-process implementation
  src/github/           GitHub client, rate-limit tracking, queries
  src/security/         encryption, sanitizer, CSP headers
  src/db/schema/        Drizzle schema
  src/db/migrations/    generated migrations
apps/web/               @crossboard/web
  src/routes/           TanStack Router routes
  src/components/
  src/lib/              API client, hooks
packages/query/         @crossboard/query (no runtime dependencies)
e2e/                    @crossboard/e2e: Playwright tests and the fake GitHub server
```

`pnpm-workspace.yaml` lists `apps/*`, `packages/*` and `e2e`. Every package has the scripts `lint`, `typecheck`, `test` (and `build` where it builds), except `e2e`, which has `test:e2e` instead of `test`: CI runs it against the built image (§7.6), and the root `test` does not. The root has `lint`, `typecheck`, `test`, `build`, `format:check` and `gate` (all of them in sequence); CI runs `pnpm gate` and the Docker build.

### 7.3 Jobs
The `jobs` interface has `enqueue(name, payload, { key?, delayMs? })` and `schedule(name, intervalMs)`. The v1 implementation is in-process: an async queue with per-installation concurrency (§6.1); a `key` deduplicates pending jobs (used for the 5 s refetch debounce). Jobs are not persisted. At startup the scheduler derives the work from DB state: repos `pending` or `syncing` are (re)synced; reconciliation and daily resync timers start.

### 7.4 HTTP API
All `/api/*` routes except `/api/health` and `/api/setup/*` (setup cookie instead, FR-48) require a session (`401` otherwise) and are scoped to the session user's access (FR-9). Errors are `{ "error": { "code", "message" } }`. State-changing routes (`POST`, `PATCH`, `DELETE`) are protected against CSRF (§9.3).

| Route | Purpose |
|---|---|
| `GET /api/health` | `{ status: "ok", version }`; no auth |
| `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` | Sign-in flow (FR-4–FR-6) |
| `GET /setup`, `POST /api/setup/token`, `POST /api/setup/manifest`, `GET /setup/callback` | First-run setup (FR-47–FR-49). `POST /api/setup/token` takes `{ token }` and sets the setup cookie (`401` on a wrong token); the other setup routes require that cookie (D-19) |
| `GET /api/me` | Session user, installations with active flag, install URL |
| `GET /api/issues?q=&sort=&offset=&limit=` | Filtered list: `{ items, total, warnings }`; `limit` ≤ 200, default 100 |
| `GET /api/issues/:owner/:repo/:number` | Summary with relations (parent, dependencies with states, sub-issue summary) |
| `GET /api/issues/:owner/:repo/:number/details` | Lazy body, comments, sub-issues (FR-42) |
| `GET /api/suggest?field=&prefix=` | Autocomplete values (FR-20), max 20 |
| `GET /api/views`, `POST /api/views`, `PATCH /api/views/:id`, `DELETE /api/views/:id` | Saved views |
| `GET /api/boards`, `POST /api/boards`, `GET /api/boards/:id`, `PATCH /api/boards/:id`, `DELETE /api/boards/:id` | Board CRUD |
| `GET /api/boards/:id/cards?q=` | `{ columns: [{ id, name, count, cards }], other?: { count, cards }, warnings }`, every placed card (no paging; the client renders 200 per column and reveals the rest with "Show N more"). A card is an issue item plus `children` (nested cards, collapsed mode only) and `columnName` on nested cards (FR-30–FR-32) |
| `GET /api/boards/:id/export`, `POST /api/boards/import` | FR-36 |
| `GET /api/sync`, `POST /api/sync/refresh` | Sync status and manual refresh (FR-45, FR-46) |
| `POST /webhooks/github` | Webhook intake; signature instead of session |

**Issue item** (list rows, cards, the summary route): `{ id, repo: { owner, name }, number, title, url, author, type: { name, color } | null, milestone: { title, url } | null, labels: [{ name, color }], assignees: [{ login, avatarUrl }], parent: { owner, repo, number } | null, subIssues: { total, completed }, blockedBy: { open, notAccessible }, blocking: { open, notAccessible }, isBlocked, createdAt, updatedAt }`, defined once as a Zod schema in `apps/server`. The summary route adds the full `blockedBy`/`blocking` lists (FR-23) and the parent's title and state.

Filtering: the server loads the user's accessible open issues (with labels, assignees and dependency states) from SQLite and evaluates the filter in memory. Target: p95 under 300 ms for `/api/issues` with 10,000 accessible issues; an integration test seeds 10,000 issues and asserts a single filtered request completes in under 1,000 ms.

### 7.5 Configuration
Configuration comes only from environment variables, validated at startup; an invalid or missing required value stops the process with a message naming the variable (never its value).

| Variable | Default | Meaning |
|---|---|---|
| `CROSSBOARD_PUBLIC_URL` | — (required) | Base URL users and GitHub reach the instance at, e.g. `https://crossboard.example.com` |
| `CROSSBOARD_APP_SECRET` | — (required, ≥ 32 chars) | Key material for encryption at rest (§9.3) |
| `CROSSBOARD_ALLOWED_USERS` | empty | Allowed GitHub logins (FR-1) |
| `CROSSBOARD_ALLOWED_ORGS` | empty | Allowed org logins (FR-1) |
| `CROSSBOARD_DATA_DIR` | `/data` | Directory of `crossboard.db` |
| `CROSSBOARD_WEBHOOKS` | `true` | Whether webhooks are expected (FR-51) |
| `CROSSBOARD_RECONCILE_INTERVAL_MIN` | `15` (`2` without webhooks) | Reconciliation interval (§6.3) |
| `PORT` | `3000` | HTTP port |
| `LOG_LEVEL` | `info` | pino level |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | — | App credentials instead of the setup flow; all or none (FR-50) |
| `CROSSBOARD_GITHUB_API_URL`, `CROSSBOARD_GITHUB_WEB_URL` | `https://api.github.com`, `https://github.com` | For tests against the fake GitHub only; not a supported way to use another host (D-14) |

### 7.6 Testing
- `packages/query`: unit tests for every row of the §4.3 table, precedence, comma OR, negation, quoting and every error class; at least 90% branch coverage.
- `apps/server`: unit tests for placement and nesting, sanitizer, encryption and config; integration tests against a temporary SQLite file with `msw` faking GitHub for sync, webhooks (signed fixtures), reconciliation, access computation and every API route, including the cross-user isolation tests of §9.1.
- `apps/web`: component tests (Vitest + Testing Library) for the list's keyboard navigation, the loading/empty/error states of each view, "Show N more" on board columns, filter error underlining and the dependency graph's layout limits.
- `e2e/`: a small fake GitHub server (OAuth, REST, GraphQL from fixtures) and Playwright smoke tests: sign in, list and filter, open detail, create a board, see placement.
- CI (`.github/workflows/ci.yml`, self-hosted `runners01`): on pushes to `dev` and `main` and on pull requests: install, `pnpm gate`, Docker build, Playwright against the built image.

## 8. Data model

All timestamps are integers in Unix milliseconds. GitHub objects use their GraphQL node id (`text`) as primary key unless noted; Crossboard's own rows use integer ids. Foreign keys cascade on delete unless noted.

### 8.1 Tables

```
app_config        key text PK, value_enc text, updated_at
                  -- GitHub App credentials from the setup flow, setup token hash
users             id int PK, github_id int unique, login text, name text null, avatar_url text,
                  created_at, last_login_at
user_tokens       user_id PK → users, access_token_enc, access_expires_at,
                  refresh_token_enc, refresh_expires_at, updated_at
sessions          token_hash text PK, user_id → users, created_at, last_seen_at, expires_at
installations     id int PK (GitHub installation id), account_login, account_id int,
                  account_type ('User'|'Organization'), suspended bool, created_at, updated_at
user_installations user_id → users, installation_id → installations, computed_at; PK(user_id, installation_id)
repos             id text PK, database_id int unique, installation_id → installations,
                  owner, name, private bool,
                  sync_state ('pending'|'syncing'|'ready'|'error'|'skipped'), sync_detail text null,
                  open_issue_count int, last_full_sync_at null, last_reconciled_at null,
                  reconcile_since text null (GitHub ISO string, the one non-ms timestamp),
                  rest_etag text null, created_at, updated_at; unique(owner, name)
user_repo_access  user_id → users, repo_id → repos, computed_at; PK(user_id, repo_id)
issues            id text PK, database_id int, repo_id → repos, number int, title, url,
                  author_login text null, type_name text null, type_color text null,
                  milestone_title text null, milestone_url text null,
                  parent_id text null, sub_total int, sub_completed int,
                  blocked_by_total int, blocking_total int,
                  created_at, updated_at, synced_at; unique(repo_id, number)
labels            id text PK, repo_id → repos, name, color, description null; unique(repo_id, name)
issue_labels      issue_id → issues, label_id → labels; PK(issue_id, label_id)
issue_assignees   issue_id → issues, login, avatar_url; PK(issue_id, login)
issue_refs        id text PK, repo_full_name, number int, title, state ('OPEN'|'CLOSED'), url, seen_at
                  -- every issue on either side of a dependency, and every parent,
                  -- synced or not (a synced issue in a dependency has a ref row too)
issue_deps        blocked_id text, blocking_id text, PK(blocked_id, blocking_id)
                  -- both ids point to issue_refs; no FK to issues
issue_details     issue_id PK → issues, body_html, comments_json, comments_total int,
                  sub_issues_json, fetched_for_updated_at, fetched_at
boards            id int PK, user_id → users, name, base_filter, sort, sub_issue_mode, show_other bool,
                  created_at, updated_at
board_columns     id int PK, board_id → boards, position int, name, filter; unique(board_id, position)
saved_views       id int PK, user_id → users, name, filter, sort, created_at, updated_at;
                  unique(user_id, name)
```

### 8.2 Rules
- Issue data is stored **once per repo** (not per user); visibility is always joined through `user_repo_access`. This is what makes the cloud version possible without remodeling.
- **Removing an issue** deletes its `issues` row (labels, assignees and details cascade) and its `issue_deps` rows where it is the blocked side. Then:
  - **closed:** its `issue_refs.state` becomes `CLOSED`; rows where it is the blocking side stay, so the issues it blocked show it struck-through and stop counting it (FR-25).
  - **deleted, transferred or no longer readable:** its ref and every remaining `issue_deps` row that mentions it are deleted, and every synced issue on the other side of those rows is refetched (so its totals and not-accessible count stay consistent).
- **Purging a repo** deletes its issues, labels and access rows. Purging an installation purges its repos. Boards and saved views are never deleted by sync.
- `issue_refs` rows no longer referenced by any issue or dependency are deleted by the daily resync.
- `user_tokens`, `app_config.value_enc` and secrets are encrypted (§9.3); nothing else is.

## 9. Self-host first, cloud-ready

### 9.1 Decisions that keep cloud open
- Data is keyed by installation and repo; visibility goes through `user_repo_access` (never "all issues in the DB").
- Every API query is scoped by the session user. Integration tests prove a second user cannot see a repo, issue, board or saved view they lack access to, through every route.
- DB access only through Drizzle; no SQLite-specific SQL outside the migrations folder.
- Background work goes through the `jobs` interface (in-process for v1), so it can later move to a queue.
- Configuration only via env vars (12-factor).

### 9.2 Not in v1, needed for cloud
- Postgres, horizontal scaling, a persistent job queue, billing, per-tenant limits, a shared multi-tenant GitHub App, privacy policy/ToS.

### 9.3 Security
- **Encryption at rest:** AES-256-GCM with a random 12-byte IV per value; the key is derived from `CROSSBOARD_APP_SECRET` with HKDF-SHA256 (info `crossboard-encryption-v1`). Values are stored as `v1:<iv>:<ciphertext>:<tag>` (base64url). Key rotation is not in v1; changing the secret invalidates stored tokens and setup credentials (users sign in again; setup must be redone unless env credentials are used).
- **Tokens** are never sent to the browser and never logged.
- **Cookies:** HTTP-only, `SameSite=Lax`, `Secure` except on `http://localhost`.
- **CSRF:** state-changing routes require a same-origin `Origin` header (Hono `csrf` middleware against `CROSSBOARD_PUBLIC_URL`) and a JSON content type. The webhook route is exempt and authenticated by its signature.
- **HTML sanitizing:** every GitHub `bodyHTML` goes through `sanitize-html` on the server with a GitHub-like allowlist: headings, paragraphs, lists, task-list checkboxes (`input type=checkbox disabled`), code/pre, blockquote, tables, `a` (`href` http/https/mailto only; `rel="noopener noreferrer nofollow"`, `target="_blank"` added), `img` (`src` https only), `details/summary`, `kbd`, `sup/sub`, `del`, `hr`, `br`, and `class` only for `markdown-*`, `highlight*`, `pl-*` and `task-list-item*`. Scripts, styles, iframes, forms, event-handler attributes and `style` attributes are removed.
- **CSP:** the SPA wraps its tree in Base UI's `CSPProvider` with `disableStyleElements` and ships that CSS in its own stylesheet, so no component needs inline `<style>` (D-20). `default-src 'self'; img-src 'self' https://avatars.githubusercontent.com https://*.githubusercontent.com https://github.com https://camo.githubusercontent.com data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com`. The SPA never injects HTML other than sanitized bodies.
- **Logging:** never log tokens, secrets, cookies or webhook payload bodies (at any level for private repos; at `debug` only for public ones).

## 10. UX notes
- Layout: top bar (filter input, view/board switcher, sync status and refresh, user menu), main area (list or board), right side panel (detail). Desktop-first, designed for widths ≥ 1024 px (D-13).
- Keyboard in the list: `/` focuses the filter, `j`/`k` move the selection, `Enter` opens detail, `o` opens on GitHub, `Esc` closes the panel. On boards: `/` and `Esc` only.
- Light/dark mode follows the system.
- Every view has explicit loading, empty and error states. Empty states explain how to install the App on more orgs.
- Times show relative ("3 h ago") with the absolute time in a tooltip, in the browser's time zone.

### 10.1 Component map (D-20)
Every UI element uses the coss ui component named here, from `apps/web/src/components/ui/`. An element this table does not cover is added to §14 before it is built, never styled by hand. The only hand-built UI is the dependency graph (FR-27, hand-written SVG), the `markdown-body` container (FR-41, `github-markdown-css`) and the filter's error highlight layer (FR-18, D-22).

| UI element | coss ui component |
|---|---|
| Top bar (§10 layout) | Toolbar, Group |
| Filter input with autocomplete (FR-20) | Autocomplete, Input Group |
| Filter error underline (FR-18) | hand-built text layer mirrored behind the Input Group (D-22) |
| Filter warnings (FR-17) | Alert |
| View/board switcher, saved views (FR-22) | Menu |
| Sort control (FR-13, FR-28) | Select |
| User menu, sign-out | Menu, Avatar |
| Sync status and Refresh (FR-45) | Button, Tooltip |
| Issue list (FR-11, FR-12), virtualized with TanStack Virtual | Table |
| Labels, issue type, dependency badges, "blocked" badge, sync state (FR-12, FR-26, FR-46) | Badge |
| Assignee and author avatars | Avatar |
| Absolute time on hover (§10) | Tooltip |
| Loading states (FR-16, every view) | Skeleton, Spinner |
| Empty states (FR-16, every view) | Empty |
| Error states with retry, "not allowed" page (FR-2) | Alert, Button, Empty |
| Detail side panel (FR-39) | Drawer, non-modal: the list or board behind it stays usable (D-22) |
| Detail sections: sub-issues, relations, comments (FR-40, FR-43) | Collapsible, Separator, Avatar |
| Board columns and cards (FR-32) | Card, Scroll Area |
| Board repo picker (FR-34) | Combobox |
| Nested sub-issues behind an expand toggle (FR-31) | Collapsible |
| Sub-issue progress (FR-12, FR-31) | Progress |
| "Show N more" (FR-32) | Button |
| Board form (FR-37) | Form, Field, Fieldset, Input, Select, Switch, Button |
| Delete board or view | Alert Dialog |
| Rename or save a view (FR-22) | Dialog, Form, Field, Input |
| Board import file picker (FR-36) | Button, Input |
| Transient errors and confirmations (`429` on Refresh, import errors) | Toast |
| Keyboard hints (§10) | Kbd |
| Settings page: installations, repo sync state, budgets (FR-10, FR-46) | Card, Table, Badge |
| First-run setup steps (FR-47–FR-49) | Card, Form, Field, Input, Button |

## 11. Milestones

| # | Milestone | Done when |
|---|---|---|
| M1 | Skeleton | Workspace with the three packages, config module, logging, DB with migration runner, `/api/health`, SPA shell served by the server, Dockerfile, CI running the gate, threat model written (`docs/THREAT_MODEL.md`, in the format of the vendored security-audit skill, so it can be enabled) |
| M2 | Auth + access | Setup flow (manifest and env), sign-in, sessions, allowlist, access computation, installations in settings |
| M3 | Initial sync | GitHub behaviour spike done (§5.5); all open issues of active installations' repos in SQLite, including labels, assignees, parent, sub-issue summary and dependencies; rate-limit-aware client |
| M4 | Query engine | Parser and evaluator for the full §4.3 table, ≥ 90% branch coverage |
| M5 | List view | Filterable, sortable, virtualized list; URL state; autocomplete; saved views |
| M6 | Detail view | Panel and route, lazy body/comments/sub-issues, sanitized, deep links, dependency lists and graph |
| M7 | Boards | CRUD, column filters, placement, collapsed/expanded sub-issues, ad-hoc filter, export/import |
| M8 | Freshness | Webhooks applied, polling reconciliation with ETags, daily resync, guardrails, sync status UI |
| M9 | Release | README with self-host guide and screenshots; repo made public; v0.1.0 tagged; image published to `ghcr.io/mdg-labs/crossboard` by a release workflow (D-5) |

M4 depends only on M1 and can run in parallel with M2 and M3.

## 12. Future (v2+) candidates
- **Writes:** drag & drop between label-based columns changes labels (remove the source column's label, add the target's), close/reopen issues. Requires **Issues: write** and a rule for columns defined by complex filters (only columns with a single `label:` qualifier become drop targets).
- Closed issues (e.g. a "closed in the last 14 days" column).
- Pull requests linked to issues.
- Dependency graph view across a whole board.
- Hosted cloud version (§9.2).
- GitHub Projects fields as columns.
- Sharing boards between users of the same instance.
- Reactions, mobile layout, internationalization.

## 13. Decisions
- **D-1 License:** MIT. See `LICENSE`. (2026-10-18)
- **D-2 Board visibility:** boards and saved views are strictly personal in v1; sharing between users of the same instance is a later candidate. (2026-10-18)
- **D-3 Instance access:** the App is public; an allowlist of users and orgs controls sign-in and which installations are synced; first-run setup is protected by a one-time token (§4.1, §4.8). (2026-10-18)
- **D-4 Tokens:** installation tokens fetch all data; user tokens are used only for identity and access computation (§5.2). (2026-10-18)
- **D-5 Release:** the repo stays private while building and goes public at M9 with v0.1.0 and an image on GHCR. (2026-10-18)
- **D-6 Dependency graph:** the one-hop graph in the detail view is part of v1 (FR-27). (2026-10-18)
- **D-7 Archived repositories** are not synced; archiving purges a repo's data. (2026-10-18)
- **D-8 Stack:** Node 24 LTS and the stack in §7.1, matching the other MDG Labs TypeScript repos. (2026-10-18)
- **D-9 Free text** matches titles only, because bodies are fetched lazily and matching them would make results depend on what was opened before. (2026-10-18)
- **D-10 Comma OR** applies to every qualifier that takes a value, not only `label:`. (2026-10-18)
- **D-11 Webhooks trigger refetches:** apart from removals, webhooks never update issue fields from their payload; they enqueue a GraphQL refetch (§6.2). (2026-10-18)
- **D-12 Daily full resync** per repo as the safety net for missed deletions and relation changes (§6.3). (2026-10-18)
- **D-13 Scope of the UI:** English only, desktop-first (≥ 1024 px), no reactions. (2026-10-18)
- **D-14 github.com only;** GitHub Enterprise Server is not supported in v1. (2026-10-18)
- **D-15 Maintainer instance from M3:** the first item of M3, done by the maintainer, deploys a private instance with a public URL and registers its App through `/setup`, so the §5.5 spike has a real installation and real webhook deliveries. (2026-10-18)
- **D-16 Release trigger:** pushing a tag `v*.*.*` runs the release workflow, which builds `linux/amd64` and `linux/arm64` and pushes `ghcr.io/mdg-labs/crossboard:<version>` and `:latest`. (2026-10-18)
- **D-17 Threat model format:** `docs/THREAT_MODEL.md` follows the threat-model format of the security-audit skill in mdg-labs/skills (`## 1. Assets` to `## 7. Disclosure split`); the M1 item that writes it carries that format in its own text, because the skill is vendored only once the file exists. (2026-10-18)
- **D-18 Read-only means no change to GitHub data:** the server never sends a GraphQL mutation or a REST call that changes GitHub data. The only non-`GET` calls are GraphQL queries (`POST /graphql`) and the credential exchanges: installation access tokens (`POST /app/installations/{id}/access_tokens`), the manifest conversion (FR-49), and the OAuth code exchange and token refresh (FR-4, FR-7). (2026-10-18)
- **D-19 Setup token route:** the setup token is submitted to `POST /api/setup/token` (§7.4). (2026-10-18)
- **D-20 UI components:** the web app is composed from coss ui (Base UI and Tailwind CSS 4), added with the shadcn CLI into `apps/web/src/components/ui/` and treated as vendored code; it replaces the Radix UI primitives. Each UI element uses the component the §10.1 map names; the frontend is not designed by hand. Inter and Geist Mono are bundled from npm font packages, never loaded from a CDN; Base UI's inline style elements are disabled so the CSP of §9.3 stays unchanged. Agents use the `coss` skill (`.agents/skills/coss`). (2026-10-18)
- **D-21 Board repo picker:** boards get a repo picker that edits the ad-hoc filter's `repo:` term, defaulting to all repos (FR-34); it is not saved with the board, since a board's base filter can already hold `repo:` terms. (2026-10-18)
- **D-22 Detail panel and filter error:** the detail Drawer is non-modal, so `j`/`k`, `/` and clicks keep working on the list or board behind it; if coss's Drawer cannot be non-modal, that is a §14 question, not a hand-built panel. The filter's error range (FR-18) is underlined by a text layer mirrored behind the Input Group, the third hand-built UI element. (2026-10-18)

## 14. Open questions
None. New questions are added here with a recommended default and resolved into §13.
