# Template tokens

What the orchestrator fills each `{{…}}` token in the dispatch templates
(`executor-prompt.md`, `verifier-prompt.md`, `refiner-prompt.md`) with, and
where the value comes from.

- **`{{IF X:}}…{{END IF}}`** — keep the block when `X` holds, otherwise drop it
  whole.
- **`{{FOR EACH ITEM}}…{{END FOR}}`** — repeat the block per item.
- **Unknown or empty `{{IF}}`** — a token whose source is absent drops its
  `{{IF}}` block. It is never filled with a guess or a placeholder.

The templates the agents fill themselves (`execution-report.md`,
`verification-comment.md`, `refiner-verdict.md`) carry free-form `{{…}}`
fields that are theirs to complete. Leave those untouched.

## Repo and run

| Token | Value |
|-------|-------|
| `PROJECT_NAME` | The repo name from `workflow.json` `repo` (the part after `/`), or the name `### Project` gives |
| `PROJECT_BLURB` | CLAUDE.md `### Project`, verbatim |
| `REPO` | `workflow.json` `repo` |
| `INTEGRATION_BRANCH` / `PRODUCTION_BRANCH` | `branches.integration` / `branches.production` |
| `BASE_BRANCH` | The branch the clone was made from (step 5): `INT`, `PROD`, or a stacked dependency's PR branch |
| `PR_LANDING` | `landing == "pr-per-unit"` |
| `MACHINE_STATE` | The step-0 machine-check output, verbatim |
| `HAZARDS` | CLAUDE.md `### Hazards`, verbatim. Drop the block when it is absent |
| `IMPLEMENTATION_RULES` | CLAUDE.md `### Implementation rules`, verbatim |
| `RISK_REVIEW` | CLAUDE.md `### Risk review`, verbatim, or the template's fallback text |
| `ENTRY_POINTS` | CLAUDE.md `### Entry points`, as a comma-separated list |
| `THREAT_MODEL` | `threatModel`. Drop the block when it is null |
| `ACT`, `ACT_TIMEOUT` | `act` is set in workflow.json and the unit's scope can touch `.github/workflows/**` or `.github/actions/**`; `ACT_TIMEOUT` is `act.timeout` (default 1800) |
| `CHECKS` | Each `checks` entry whose `paths` the unit's scope can touch, as `- <paths>: \`<run>\``, then `- Before handing off: \`<gate>\``. A cross-repo landing uses its entry's `gate` |
| `KNOWN_ESCAPES_PATH` | `<TOOLS_ROOT>/.claude/known-escapes.md` |
| `TEMPLATES_DIR` | `<TOOLS_ROOT>/.claude/skills/orchestrate/templates` |
| `STALE_TERMS` | `readiness.stale`, one line each: `<reason> (matches /<pattern>/)` |
| `DOCS`, `DOCS_PATHS`, `DOCS_GUIDE`, `DOCS_BUILD` | `docs` (when the scope touches `docs.paths`), `docs.paths`, `docs.guide`, `docs.build` |
| `BOOTSTRAPPED`, `BOOTSTRAP` | Holds when step 5 ran `bootstrap`, the command itself |
| `SIGNOFF_FLAG` | `signoff.mode == "flag"`, or `hook` mode in a clone without the hooks path |
| `SIGNOFF_HOOK` | `signoff.mode == "hook"`, and the clone has the hooks path |

## Unit and workspace

| Token | Value |
|-------|-------|
| `UNIT_ID` | `<ref>-a<attempt>`, or bundle refs joined with `+` (`57+58-a1`, `RO-12-a1`) |
| `WORKSPACE_PATH` | The unit's scratch clone (absolute) |
| `TOOLS_ROOT` | `WORKSPACE_PATH`, or `REAL` for a cross-repo landing or the refiner's clone |
| `CROSS_REPO`, `LANDING_REPO` | The item lands in a `landingRepos` entry, and that entry's `repo` |
| `UNIT_ENV` | `unitEnvironment` is set |
| `UNIT_ENV_VAR` | `unitEnvironment.idVar` |
| `UNIT_ID_ENV` | `UNIT_ID` with `+` replaced by `-` |
| `UNIT_ENV_TEARDOWN`, `UNIT_ENV_LEFTOVER_CHECK` | `unitEnvironment.teardown` / `.leftoverCheck`, with `{UNIT}` replaced by `UNIT_ID_ENV` |
| `SECURITY_HISTORY` | The step-5a output, verbatim, or the "unavailable" line |
| `ATTEMPT` | The attempt number, starting at 1 |
| `MODE`, `OUT_DIR` | Refiner only: `apply` or `draft`, and its output directory |

## Items

| Token | Value |
|-------|-------|
| `ITEM_COUNT`, `ITEM_LIST` | The count, then one line per item as the template describes |
| `ITEM_REF`, `ITEM_TITLE` | The item's display ref (GitHub `#n`; Kaneo `<KEY>-<n> (#<mirror>)`) and its title |
| `ITEM_BODY`, `ITEM_COMMENTS` | Verbatim from step 1. For an advisory, the description and "No comments on this item." |
| `SCOPE_PATHS`, `EXTRA_SHARED_FILES` | The step-3 scope, and always-shared files cleared for this item |
| `EPIC`, `EPIC_REF`, `EPIC_TITLE` | Refiner only: the items share an epic, and its ref and title |
| `RISK`, `RISK_REASON` | The item is risk-flagged (step 3), and why: the label, or the matching `riskPaths` glob |
| `SPIKE` | The item carries the spike type label |
| `ALREADY_RESOLVED_POSSIBLE` | A bundle member whose criteria an earlier member may already meet |
| `SHA` | Verifier only: this item's commit, from the execution report |
| `TRAILER` | `Fixes #<n>`, `Fixes <repo>#<n>` (cross-repo), or `Refs: <GHSA-id>` |
| `TRAILER_FORM` | The same, as the verifier should expect it |
| `ADVISORY`, `ADVISORY_ID` | The unit is an advisory, and its GHSA id |

## Tracker (from `.claude/trackers/<type>.md` → "In dispatch prompts")

| Token | Value |
|-------|-------|
| `CLAIM`, `HAND_OFF`, `ROLLUP` | Executor status calls for this item. `ROLLUP` is dropped for Kaneo and for items without an epic |
| `CLAIM_MAY_FAIL` | The tracker is Kaneo (an MCP call can fail) |
| `POST_VERDICT`, `SET_PASS`, `SET_FAIL` | Verifier calls for this item |
| `TRACKER_WRITES` | The executor or verifier sentence from the mapping |
| `TRACKER_TOOL_LOAD` | Kaneo: `select:<P>update_task_status,<P>create_task_comment`. Dropped for GitHub |
| `TRACKER_READS`, `BODY_EDIT` | Refiner only: the read forms, and the one body-edit call |

## Fix rounds

| Token | Value |
|-------|-------|
| `FIX_ROUND`, `FIX_ROUND_SAME_WORKSPACE`, `FIX_ROUND_FRESH_CLONE` | Step 9's case |
| `PREVIOUS_SHA`, `PRIOR_COMMIT_PATH`, `PRIOR_ATTEMPT_PATH` | The rejected commit, and the clone it can be read in |
| `VERIFIER_BLOCKING_FINDINGS`, `PREVIOUS_BLOCKING_FINDINGS` | The previous verdict's blocking findings, verbatim (never notes) |
