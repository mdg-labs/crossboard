# Known escapes

Defect patterns that passed a `task-verifier` PASS and were later confirmed
real in review (CodeRabbit on a promotion or unit PR). `task-executor` checks
its change against this list before committing; `task-verifier` checks each
commit against it under layers 6 and 7. `pr-review` appends a line whenever it
fixes a confirmed finding whose pattern is not here yet.

One line per pattern: **category** — what goes wrong — where it was seen.
Keep it to patterns, not individual bugs; merge a new instance into an
existing line by adding its PR number.

## Runtime and packaging

- **Process lifecycle** — a server that runs as the container's PID 1 registers no SIGTERM/SIGINT handler, so a stop is a SIGKILL after the grace period with requests undrained and the database left open — PR 68
- **Process lifecycle** — shutdown deadlines chained one after another (a job grace timer started only once the connection drain ends), so the total stop time reaches the orchestrator's SIGKILL — PR 76

## Auth and tokens

- **Over-broad error class** — a destructive step (deleting a user's tokens and sessions) taken on any 4xx instead of the one upstream error code that means the credential is dead, so a misconfigured secret or a rate limit signs users out — PR 76
- **Non-idempotent retry** — a generic transient-failure retry applied to a single-use credential exchange (OAuth code, refresh token, manifest code), so a lost answer replays a consumed credential and the retry fails or signs the user out — PR 84

## GitHub integration

- **Status-only failure detection** — a limit or failure recognised only by HTTP status, while GraphQL reports it in a `200` body (`errors[].type`, e.g. `RATE_LIMITED`), so the documented wait or handling never runs — PR 84

## CI and packaging

- **Moving tag regression** — a moving image tag (`nightly`) pushed from a run without checking the run's commit is still the branch tip, so a re-run of an older run moves the tag back — PR 76
- **Lost diagnostics** — a test-harness container started with `--rm`, so one that crashes at startup is gone before its logs are read — PR 76
- **Unpinned coupled version** — a dependency whose version must equal one pinned elsewhere in CI (the Playwright client vs the `run-server` image) declared with a range, so a lockfile refresh breaks every run — PR 76

## Web

- **Offset paging duplicates** — pages fetched by offset over a list whose order can change between requests are concatenated as they arrive, so a row that moved comes back twice with the same React key — PR 88
- **Span-only text edit** — a filter term removed by its AST span alone, while the span excludes the parentheses around it, so the edit leaves `()` and the result no longer parses — PR 91
- **Early resource release** — a blob URL revoked in the same task as the `click()` that starts its download, so browsers that start the download afterwards fail it — PR 91
- **Copied helper** — a module-private helper (the API error mapper) copied verbatim into each new client module instead of exported once, so the copies can drift — PR 91

## Tests

- **Vacuous assertion** — a fixture keyed by a literal id (`[1]`) that matches the intended row only by insertion order, so a reorder makes the case pass without testing what it names — PR 91

## Threat model

- **Coverage gap** — an attacker capability or entry point named in the threat model (a replayed delivery, pull-request code on CI) that no invariant in §4 or residual in §5 answers — PR 68
