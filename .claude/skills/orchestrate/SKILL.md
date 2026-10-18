---
name: orchestrate
description: Given tracked items — GitHub issue numbers, Kaneo ticket refs, an epic with sub-items — or a private security advisory id (`--advisory GHSA-…`), autonomously implement and verify the work — sonnet task-executor agents in isolated scratch clones (one per item, or one per bundle of small, correlated items), one independent task-verifier per attempt, landing only after a PASS — pushed to the integration branch, or opened as a pull request per unit, as the repo's workflow.json says. Parallelizes items with disjoint file scope, serializes overlapping ones. Never touches the production branch directly. Use when asked to "work on #n", "implement epic #n", "orchestrate RO-12", "run the orchestrator", or "orchestrate …".
argument-hint: <item-ref>... [--advisory <GHSA-id>]... [--discord]
allowed-tools:
  - Read
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - Bash
  - TaskStop
---

# orchestrate

Turns tracked items — single items, or an epic with sub-items — into landed,
verified commits, with no human in the loop except at a genuine blocker (a
maintainer-only step, a verification failure that stops narrowing, an
external unmet dependency, a budget stop).

**You (the current session) are the orchestrator.** You spawn
`issue-refiner`, `task-executor` and `task-verifier` subagents and drive the
loop yourself — this skill is not itself a subagent. Follow the steps in
order. An epic takes a while; give the user a short progress update at the
start of each wave and after each landing, rather than going quiet.

## What this skill reads, and what it never assumes

Everything repo-specific comes from two places in the real repo. Read both at
the start of every run, and fill dispatches from what you read — never from
memory of another repo:

- **`.claude/workflow.json`** (schema: `.claude/workflow.schema.json`):
  - `repo`, `tracker`, `branches.integration` / `.production`, `landing`
  - `promotionBudget`, `gate`, `checks`, `bootstrap`, `signoff`
  - `models`, `limits`, `largeDiff`, `act`, `pr`
  - `labels.risk`, `riskPaths`, `labels.maintainerOnly`
  - `landingRepos`, `unitEnvironment`, `docs`, `threatModel`, `readiness`

  A missing optional field takes the default the schema states.
- **`CLAUDE.md` → `## Agent workflow`**, whose fixed subsections are copied
  verbatim into dispatches:
  - `### Project`
  - `### Design docs`
  - `### Area → paths`
  - `### Always-shared files`
  - `### Entry points`
  - `### Hazards`
  - `### Implementation rules`
  - `### Risk review`
  - `### Machine check`

  A subsection the repo lacks is omitted from the dispatch, never invented.

The tracker is reached only as `.claude/trackers/README.md` and the mapping
for `tracker.type` (`github.md` or `kaneo.md`) describe. Read both now. Every
"resolve", "set status", "comment", "create" below means the operation done the
way that mapping says. Scripts live in `.claude/scripts/`. Templates live
next to this file in `templates/`: `TEMPLATES_DIR` in a dispatch is that
directory's absolute path in the **workspace** the agent works in (every
clone carries the vendored `.claude/`), or in `TOOLS_ROOT` for a cross-repo
landing.

**Only suggest skills this repo has.** A repo vendors a profile, and a light
repo has no `open-pr`, `pr-review`, `dev-diff` or `security-audit`. Before
naming any skill to the maintainer (`/open-pr`, `/pr-review`, …), check that
`.claude/skills/<name>/` exists. When it doesn't, describe the step itself
instead, e.g. "open the `INT` → `PROD` pull request when you're happy with
what landed".

Shorthand below:

- `INT` = `branches.integration`
- `PROD` = `branches.production`
- `REAL` = the real repo's absolute path
- `S` = `<scratchpad>/orchestrate`, under this session's scratchpad directory

## 0. Preflight, then resolve the target

**The real repo must be safe to land in.** In `REAL`:

```
git -C REAL status --porcelain
git -C REAL fetch origin
git -C REAL rev-parse --abbrev-ref HEAD
git -C REAL rev-list --left-right --count origin/INT...INT
```

It must be on `INT`, clean, and not behind `origin/INT`. Run
`git -C REAL merge --ff-only origin/INT` when it is only behind. If local
`INT` is *ahead* — the maintainer's own unpushed commits — record those SHAs
as `PRE_RUN_LOCAL`. You will never push them (step 8). Otherwise, stop and
say what is wrong. Never stash, reset or switch the maintainer's work.

**Machine check.** One Bash call: `command -v` for every tool named in
`checks[].requires`, plus every command under `### Machine check`, if the repo
has one. When `act` is set, add `command -v act flock` and
`timeout 20 docker info --format '{{.ServerVersion}}'`. Also run the
`unitEnvironment.leftoverCheck`, if any, to report
leftovers from an earlier run. Report leftovers to the user; never remove
them. Keep the output verbatim as `MACHINE_STATE`. A tool missing here is
named in every dispatch and never installed.

**Resolve each argument** with the tracker mapping's *Resolve* section:

- **GitHub:** `#n` and issue URLs. Ranges like `#114 - #130` mean every
  number in between.
- **Kaneo:** `<KEY>-<n>`, task URLs, or the mirror `#n`.

Then:

- **Epic** (GitHub label `epic`; Kaneo subtask edges): the target set is
  its open sub-items. Drop any already `implemented`, `done` or closed.
- **Otherwise**: just the item.
- For every item, resolve its **trailer number** `#n` now. On GitHub this
  is the issue itself. On Kaneo it is the mirror, found read-only as
  `kaneo.md` says. **Never create an issue to get a number.** An item with no
  resolvable number is left out and reported.
- If an item doesn't exist or the call fails, stop and say so — never guess.

Call the resulting set **T**. For each member record its tracker id
(number or CUID), display ref, trailer number, title, status, labels, and
epic.

## 0a. Advisory targets

For each `--advisory <GHSA-id>`:

```
.claude/scripts/gh-rest.sh advisory-get <GHSA-id> --jq '{ghsa_id,summary,description,severity,state}'
```

If the call fails, stop and say so; never guess an id. The advisory's
`description` is its body, and it is the only thing about it that reaches an
agent. It joins **T** as an **advisory unit**. Its unit id is `adv-` plus the
id's three groups joined with `-` (`adv-abcd-efgh-ijkl`).

An advisory unit differs from an item in exactly these ways:

- **Nothing is written to the tracker or any public GitHub surface.** That
  rules out an issue, comment, label, status call, epic rollup, pushed branch,
  pull request, or any text naming it, beyond the `Refs:` trailer of its
  landing commit. Verdicts and the run log stay in this session and the
  report.
- **It has no comments, relationships or epic.** It always lands in the real
  repo.
- **The readiness gate is read by hand** from the description. It needs
  acceptance criteria and an out-of-scope section. A description without them
  is reported and left out of T. The maintainer fixes it with `gh-rest.sh
  advisory-update`; a refiner never touches an advisory.
- **Its file scope** comes from the paths the description names. If it names
  none, the scope is the whole repo.
- **It is never bundled.** The promotion budget applies unchanged.
- **The commit message is neutral** and ends in `Refs: <GHSA-id>` instead of a
  `Fixes` line. It says what the code now does and nothing about how it used to
  fail. The same holds for every comment, test name and fixture the diff adds.
- **The verifier is always Opus** and posts nothing.
- **Under `landing: pr-per-unit`**, opening a PR would publish the fix before
  release. The unit lands on a local branch in `REAL` instead, named
  `<pr.branchPrefix>adv-…`. That branch is never pushed, and the report
  tells the maintainer to land it through the advisory's private fork.

## 1. Pull each item's full body, comments, and relationships

For every item in T, read the body and the **comments** (two calls on
GitHub). Then read the native relationships: blocked-by, blocking, parent,
sub-items.

**Comments are authoritative over the body where they disagree.** Scope
corrections, reassigned halves, replaced acceptance criteria and earlier
verification findings all arrive as comments. Fold what you learn into your
own decisions (scope, ordering, whether it still belongs in T) and into the
dispatch; never assume the agent will rediscover it.

For each blocker `d` of an item, check its **status, not its open/closed
state**. An item stays open long after its fix landed on `INT`, because it
closes only when the trailer reaches `PROD`.

- `d` is `implemented`, `done` or closed → **satisfied**.
- `d` is in T → an **intra-run ordering edge**.
- `d` is neither → **external blocker.** Remove the item from T and report
  `<ref> is blocked by open <d>, which is outside this run — orchestrate <d>
  first, or include it explicitly`.

On Kaneo, a `Depends on: <KEY>-<n>` line in a description counts as a blocker
too.

Also read the design context each item cites. You are about to judge its
scope, and the docs are where scope lives.

## 1a. Resolve each item's landing repository

Only when `workflow.json` has `landingRepos`. Look for a line
`Lands in: <owner/repo>` in each item's body:

- **No such line:** the item lands in `REAL`. `TOOLS_ROOT` is the scratch
  clone itself.
- **A repo listed in `landingRepos`:** the landing clone is
  `$(realpath -- "${<pathEnv>:-REAL/<defaultPath>}")`. It must be a git clone
  whose `origin` names that repo, on its `INT`, clean, and exactly at
  `origin/INT` after `fetch` + `merge --ff-only`. A fast-forward also succeeds
  when local is *ahead*, and those unverified commits would be pushed with
  the run's work. If any of that fails, leave the item out and report why.
  `TOOLS_ROOT` for its agents is `REAL`, read-only: it holds `CLAUDE.md`, the
  scripts, the templates and `known-escapes.md`.
  - The trailer becomes `Fixes <tracking repo>#<n>`.
  - The gate becomes that entry's `gate`.
  - With `postVerdict: false`, the verifier posts nothing and returns its
    verdict to you only.
- **Any other value:** leave the item out and report it.

The item, its status and its epic stay in this repo's tracker either way. The
landing repository's scripts are never used.

## 1b. Readiness gate — refine thin or stale items before anything else

Items that reached an executor without triage failed verification far more
often and let more defects through to review. Check every item in T:

- **GitHub:** `.claude/scripts/issue-readiness.sh <n>`. This is mechanical
  and reads only the issue text. It reports `NOT-READY` with reasons; path
  warnings alone never block.
- **Kaneo:** apply the same checklist to the description yourself. It needs:
  - `## Original report`
  - `## Acceptance criteria` with checkable items
  - `## Out of scope` on a feat, bug or chore
  - a `Reachable via:` criterion on a feat or bug that delivers a runtime
    capability
  - no match for `readiness.stale`

**You do not investigate or rewrite a NOT-READY item yourself.** That is code
reading your context must not carry through the rest of the run. Dispatch one
`issue-refiner` per epic (or per item without one), all in one message.
Use `TEMPLATES_DIR/refiner-prompt.md` with `MODE = apply`, filling:

- `WORKSPACE_PATH`: a fresh clone made with
  `git clone --quiet --branch INT REAL S/refine-<unit>`
- `OUT_DIR`: `S/refine-<unit>-out`
- `BODY_EDIT` and `TRACKER_READS`: from the tracker mapping
- `STALE_TERMS`: from `readiness.stale`

```
Agent({
  subagent_type: "issue-refiner",
  model: <models.refiner: "opus" | "sonnet"; auto → opus when any item is risk-flagged, else sonnet>,
  description: "Refine <refs>",
  prompt: <the filled template>
})
```

Read **only the verdicts**:

- `refined`: the refiner already applied the new body. Wire the
  relationships it lists natively, set the item `ready`, re-read it (step 1)
  and continue.
- `split-proposed`: `AskUserQuestion` with the one-line-per-part proposal.
  On approval:
  1. Apply `OUT_DIR/<id>.md` to the original item (part A, keeps its id).
  2. Create each `OUT_DIR/<id>-NEW-*.md` as a new item with the listed
     labels and relationships (same epic).
  3. Replace every `<NEW-…>` placeholder with the real ref.
  4. Set each part `ready` and put it in T.

  On Kaneo, resolve each new part's mirror `#n` once the sync has created it,
  re-checking once. The refiner already wrote the bodies — don't rewrite
  them.
- `already-done` / `obsolete`: `AskUserQuestion` with the evidence, then drop
  the item from T. Never cancel or close it yourself.
- `needs-decision`: `AskUserQuestion` with the refiner's question and
  recommended default. Record the answer as a comment on the item, then
  treat it as `refined` after a second refiner pass.

Delete each refiner clone when its verdicts are in, as in step 8's cleanup.
An item still NOT-READY after one refine pass is reported and left out of T —
never dispatched thin.

## 2. Pull out maintainer-only items — they never go through an agent

Only when `labels.maintainerOnly` is set. For each item carrying that label:

1. Read it yourself. Stage whatever files it describes in `REAL`, and print
   the exact commands for the maintainer, each line prefixed `! `.
2. Do **not** commit and do **not** close it. Report it as "prepared,
   awaiting maintainer" and remove it from T. Its dependents stay blocked
   until the maintainer confirms and you're re-invoked.

## 3. Determine each remaining item's file scope

For each item, derive the set of paths it will touch:

- **Backticked paths** in the body, especially its `## Scope hint`.
- **Fallback:** its area label, via `CLAUDE.md`'s `### Area → paths` table. A
  docs item with no area scopes to the docs directory that table names.
- **Always-shared files** (`### Always-shared files`) are their own scope
  entries whenever an item plausibly touches them.
- **Entry points are in scope.** An item's `Reachable via:` criterion names
  where its capability must be reachable from. Add every such entry-point
  file (`### Entry points`) to the item's scope as its own entry, so lanes
  serialize on it. Leaving the entry point out of scope is what turns
  finished features into later "wire it in" items.
- **Can't confidently bound it** → its scope is **the whole repo**, which
  serializes it against everything.
- **Risk.** An item is **risk-flagged** when it carries `labels.risk` or its
  scope matches any `riskPaths` glob. Record which, as `RISK_REASON`.
- **Cross-repo items.** Scopes are relative to the item's landing
  repository. Scopes in different landing repositories never intersect.

## 4. Batch into waves, then bundles, then lanes

**Waves** (dependency order):

- Wave 1 = items with no unresolved same-run dependency.
- Wave 2 = items whose same-run dependencies are all in wave 1.
- And so on.

### Bundles

One `task-executor` per **bundle**; a bundle is usually one item. Only two
shapes qualify:

- **Correlated:** their scopes intersect, so lanes would serialize them
  anyway.
- **Small and adjacent:** each is a one-sitting change sharing an area, with
  nothing open in its thread that needs a decision.

A dependency edge between two members is a reason to bundle: order the parent
first, delete that edge, and re-layer the waves. When a later member's
criteria may already be met by an earlier one, fill the executor's
`ALREADY_RESOLVED_POSSIBLE` block for it.

**Never bundle:**

- an advisory unit with anything;
- items with different landing repositories;
- an item scoped "the whole repo";
- an item whose thread carries a verification FAIL, or that is entering a
  fix round;
- a risk-flagged item — it gets its own agent, its own verifier and its own
  line in the report;
- a spike.

A bundle holds at most `limits.bundle` items (default 3). Its scope is the
union of its members' scopes. Every commit stays one item.

### Lanes within a wave

Process the wave's units in ref order; a bundle is one unit, ordered by its
lowest member. Place each unit in the first lane whose accumulated scope
doesn't intersect its own; otherwise start a new lane. Lanes run in parallel,
at most `limits.lanes` at once (default 3); units within a lane run serially.

### Promotion-diff budget — a hard rule

Only when `promotionBudget` is set. **The `INT → PROD` reviewable diff never
grows past the cap.** CodeRabbit (Essentials plan) reviews at most 150 files
per pull request, counted after `.coderabbit.yaml`'s `path_filters`. `INT`
only reaches `PROD` through one promotion PR (`open-pr`, then `pr-review`). A diff past the cap
forces a split promotion, and that leaves the two branches with duplicate
history. Items landing in another repository (step 1a) are not counted.

**Check before every action, not once per run.** Re-run the check
immediately before **each**:

- dispatch: the first, the next unit in a lane, a fix round, a rebase re-run,
  an item pulled in by step 11;
- landing (step 8).

Other lanes land in between, so an earlier check is never still valid.

**The check:**

1. `R` = the output of `.claude/skills/dev-diff/dev-diff.sh --list`, the
   reviewable paths of the current `PROD...INT` diff.
   - First confirm local `INT` exists (`git rev-parse --verify INT`).
   - If it is missing or the script exits non-zero, stop and report it.
     Never treat a failed comparison as an empty `R`.
2. **In flight** = each unit dispatched but not yet landed.
   - **Every count here is a CodeRabbit-reviewable count, never a raw file
     count.**
   - If the unit has committed, its files are
     `git -C <workspace> diff --name-only origin/INT..HEAD -- . <excludes>`,
     with one `':(glob,exclude)<pattern>'` per `!`-prefixed `path_filters`
     entry.
   - If it has not committed yet, use its estimate (item 3).
3. **Estimate high, never low.** For an item not yet committed, `E` is the
   **larger** of:
   - its `Expected files:` line;
   - one file per backticked file path in its scope, four per backticked
     directory, plus every entry point and always-shared file in its scope.

   Multiply the result by 1.5 and round up. A new package directory counts as
   at least six. An item that commits fixture trees, generated data or
   per-variant directories and has no `Expected files:` line is
   **unbounded**: don't guess. Ask the maintainer before dispatching it. A
   path already in `R` counts as zero growth only when named by its exact
   file path.
4. `P` = |R| + files of in-flight units not in `R` + `E` of every
   not-yet-dispatched item still in T. Print
   `INT→PROD reviewable: |R| now, P projected (cap C, drop at ⌊0.9·C⌋)`.

**Acting on it:**

- **P ≥ 0.9·cap:** drop items from T until it is below, starting with the
  last in wave order.
  - Only items **not in flight** are dropped. Never shrink, consolidate or
    exclude code, tests or fixtures to fit.
  - **Never put a file-count limit in an executor dispatch.** It pushes code
    into files where it does not belong. The budget is managed only by which
    items are admitted.
  - A dropped item goes back to `ready` if you touched its status, and is
    listed in the report as "dropped for the budget".
- **A dispatch would push P to the threshold:** don't dispatch it; drop it.
- **A landing would take |R ∪ the commit's reviewable files| past the cap:**
  do not land. Stop the run, leave the commit in its clone, and tell the
  maintainer a promotion is needed first.
- **|R| is already at the threshold when the run starts:** dispatch nothing,
  and tell the maintainer to promote first (`/open-pr` if this repo has it,
  otherwise the `INT` → `PROD` pull request).
- There is no exception. CodeRabbit is the only PR reviewer, so a promotion
  past the cap could not be reviewed at all.

Print the plan before dispatching: waves, bundles and why, lanes and why,
risk-flagged items, and the budget line. If T has more than
`limits.confirmAbove` items (default 12), state the count and confirm it with
`AskUserQuestion` first.

## 5. Per dispatch unit: isolated scratch clone

Never work in `REAL`; never share a clone between concurrent units.

```
mkdir -p S
git clone --quiet --branch <base> <landing clone> S/<unit-id>-a1
```

**`<base>`:**

- **Normally:** `INT` of the landing clone.
- **Under `landing: pr-per-unit`:** `PROD`, or the branch of an unmerged
  dependency's PR (step 8B).

Make the clone at dispatch time, not at planning time, so the next unit in a
lane starts from its predecessor's landing.

**`<unit-id>`:** the item's number or ref (`57-a1`, `RO-12-a1`), or bundle
members joined with `+` (`57+58-a1`). When `unitEnvironment` is set, its id is
the unit id with `+` replaced by `-`, so parallel lanes never collide.

Then, in the clone:

- **Signoff:** with `signoff.mode == hook`,
  `git -C <clone> config core.hooksPath <signoff.hooksPath>`, if that path
  exists in the clone. A clone without it signs with `-s`: fill the
  template's `SIGNOFF_FLAG`.
- **Bootstrap:** run `bootstrap` once, if set (e.g. a dependency install),
  bounded with a timeout. Fill `BOOTSTRAPPED`.
- **PR landing:** `git -C <clone> switch -c <pr.branchPrefix><unit-id>`. The
  default prefix is `agent/`.

A **verification-FAIL retry** reuses the same clone so the executor can
amend. Only a **rebase retry** (step 8), or a fix round after a bundled
attempt, re-clones fresh.

## Status — exactly one, always

Each item has exactly one status (`trackers/README.md`). An advisory unit has
none. The usual moves:

- the executor sets `in-progress`, then `in-review`;
- the verifier sets `implemented` or back to `in-progress`;
- `done`/`closed` is the tracker automation's, never yours.

Your moves:

- **Claim backstop** (step 6).
- **Abandonment:** an item leaving your hands still open (executor
  `blocked`, escalated, dropped for the budget) goes back to `ready`.
- **Epic rollup:**
  - **GitHub:** `.claude/scripts/epic-status.sh <epic>`, run by agents (the
    `ROLLUP` token). You run it too after any status move of your own.
  - **Kaneo:** yours alone. After every status change of a sub-item, compute
    the epic's status from its children's columns, as in the README's table,
    and set it. Never `done`.

## 5a. Security history of each unit's paths

For each unit, inside its landing clone, once per unit, with every path of
the unit's scope as an argument:

```
<TOOLS_ROOT>/.claude/scripts/security-history.sh <each path of the unit's scope>
```

Keep its output verbatim as `SECURITY_HISTORY` for steps 6 and 7.

- **Empty output** means there is none: the dispatches omit the block.
- **A non-zero exit** means the history could not be read. Say so in both
  dispatches ("Security history unavailable: <message>") instead of omitting
  it.

An advisory unit gets the history too, since it is public.

## 6. Dispatch `task-executor`

**Run the budget check (step 4) first**, before every dispatch.

Read `TEMPLATES_DIR/executor-prompt.md` and fill every `{{…}}` token. `templates/TOKENS.md` says where each one comes from; read it once per run.

**Once per dispatch:**

- `PROJECT_NAME`, `PROJECT_BLURB`
- workspace, unit id, `TOOLS_ROOT`, `TEMPLATES_DIR`, `MACHINE_STATE`
- `HAZARDS`, `IMPLEMENTATION_RULES` (verbatim from CLAUDE.md)
- `UNIT_ENV` (from `unitEnvironment`, with `{UNIT}` replaced)
- `CHECKS`: the `checks` entries the unit's scope can touch, plus `gate` (or
  the landing repo's gate)
- `KNOWN_ESCAPES_PATH` = `<TOOLS_ROOT>/.claude/known-escapes.md`
- `SECURITY_HISTORY`, `DOCS` (when the scope touches `docs.paths`)
- `TRACKER_WRITES` and `TRACKER_TOOL_LOAD` (tracker mapping)
- `SIGNOFF_FLAG` / `SIGNOFF_HOOK`
- `BASE_BRANCH`

**Once per item, in bundle order:**

- ref, title, body, **comment thread**, scope
- `CLAIM`, `ROLLUP`, `HAND_OFF` (tracker mapping)
- `TRAILER`:
  - `Fixes #<n>`
  - `Fixes <repo>#<n>` for a cross-repo landing
  - `Refs: <GHSA-id>` for an advisory
- risk/spike flags

**On a fix round:** the rejected SHA and the verifier's **blocking** findings
verbatim.

```
Agent({
  subagent_type: "task-executor",
  model: "sonnet",
  description: "Implement <unit-id>",
  prompt: <the filled template>
})
```

**The filled template is the prompt, inline and in full.** Never write it to a
file and send a short prompt that points the agent at that file. This holds
for every dispatch: refiner, executor, verifier and fix rounds. A script may
fill the template, but its output goes into `prompt` verbatim, however long.

**All lane-head dispatches for a wave go in one assistant message**, so they
run concurrently.

**Claim the unit's first item yourself, right after dispatching it** (not an
advisory unit). Run the tracker's `in-progress` move, then the epic rollup.
The executor's own claim is instructional, not guaranteed, and a model can
defer it until it is about to commit. Repeating it is harmless. For a
bundle's later items, the executor's own per-item claim is what covers them.

A bundle produces **one commit per item**, each with only that item's files
and its own trailer. Blocked is per item: a bundle that committed item 1 and
blocked on item 2 hands you a real commit for item 1. An `already-resolved`
item has no commit. Report it with its evidence and escalate it as in step 9;
never close it.

If an item comes back `blocked`: report the reason, set it back to `ready`,
leave it open, and continue with the rest of T that doesn't depend on it.

### Waiting: end the turn, don't schedule anything

Subagents re-invoke you when they finish. Once everything dispatchable is
out the door, say in one line what you're waiting on and **end your turn.**

- Never `ScheduleWakeup`, `Monitor` or `sleep`.
- Never re-dispatch because you haven't heard back.
- Never take over a running agent's work. To replace an agent:
  1. Stop it with `TaskStop` and confirm it stopped.
  2. Check what it already wrote (tracker statuses, commits in its clone).
  3. Only then dispatch the replacement.

When an agent hands back:

1. Check `ps -u "$USER" -o pid,ppid,etime,args` for anything it left running,
   and stop only that, by PID.
2. Route its findings (step 11).
3. Verify the unit (step 7).
4. Dispatch the next unit in its lane.

## 7. Dispatch `task-verifier`

Read `TEMPLATES_DIR/verifier-prompt.md` and fill it.

**Per item:**

- its details and comment thread
- its scope and flags
- **its own commit SHA**
- `TRAILER` and `TRAILER_FORM`
- `POST_VERDICT`, `SET_PASS` / `SET_FAIL` and `ROLLUP`, from the tracker
  mapping. Omit them for an advisory unit, or when the landing repo has
  `postVerdict: false`.

**Once per dispatch:**

- the same shared tokens as the executor
- `THREAT_MODEL` (from `threatModel`)
- `RISK_REVIEW` (from `### Risk review`)
- `ENTRY_POINTS` (from `### Entry points`)
- `PRODUCTION_BRANCH`

**On a fix round,** fill the `FIX_ROUND` block: the rejected SHA, where it can
be read, and the previous round's **blocking** findings verbatim.

```
Agent({
  subagent_type: "task-verifier",
  model: <see below>,
  description: "Verify <unit-id> attempt <n>",
  prompt: <the filled template>
})
```

**Model choice** (`models.verifier`):

- `auto` (the default): Opus when any item is risk-flagged or its diff is
  large; otherwise Sonnet.
- `opus`: always Opus.
- `sonnet`: always Sonnet.
- **An advisory unit's verifier is Opus** under every setting.
- **Large diff:** measure the unit's changed lines without generated code or
  lockfiles:
  `git -C <workspace> diff --numstat origin/<base>..HEAD -- . <excludes> | awk '{s+=$1+$2} END {print s}'`.
  Above `largeDiff.lines` (default 2000), the diff is large. Name every such
  item in the report, and any item that landed far above its estimate.

**A unit that changes GitHub Actions workflows proves them locally.** When
`act` is set and the unit's scope can touch `.github/workflows/**` or
`.github/actions/**`, fill `ACT` in both dispatches. The executor runs each
changed job with `.claude/scripts/act-run.sh` before committing, and the
verifier runs it again itself under layer 1. You never run a workflow
yourself, and never push a branch to make one run. This holds for an
advisory unit too, since act runs nothing outside the machine.

What act cannot show — a deploy, a release, a step that needs a secret, a
`schedule`, anything only true once it lands on `PROD` — never holds a unit
back. The verdict lists it under **Proves after landing**, and you carry
each entry into the report (step 12). With `act` null, fill nothing: the
verifier judges a workflow by reading it, plus `actionlint`.

**One verifier per unit per attempt; verdicts are per item.** All seven layers
run against each commit separately, with one comment and one status move per
item.

- **Only blocking findings fail an item.** Notes are recorded in the comment
  and go nowhere else.
- If a PASS comment's notes describe a concrete defect anyway, treat that
  note as a finding outside the item and route it in step 11.
- A mixed PASS/FAIL result is normal.
- Read the verifier's returned verdicts rather than re-deriving them from the
  tracker.

## 8. On PASS — land, sequentially, never in parallel

**Run the budget check (step 4) before every landing.**

Land one commit at a time, in bundle order, skipping members that FAILed.

**Invoking this skill is the maintainer's authorization** to commit to `INT`
and push it (dev-cherry-pick), or to push unit branches and open pull requests
(pr-per-unit). If a permission check denies one of those exact steps, report
the denial with the command and retry once the maintainer grants it; never
hand the work back to them.

- **Keep each `git commit` and `git push` a standalone plain command**, so the
  repo's allow rules match it.
- **No attribution lines, ever:** no `Co-Authored-By`, no session link, no
  "Generated with".

**Is this the epic's last open sub-item?** Decide by membership, not by
count. List the epic's sub-items whose status is neither `implemented`,
`done` nor closed. The verifier already set this item's own `implemented`, so
it is the last when that list is **empty**.

### 8A. `landing: dev-cherry-pick`

All of it runs in the landing clone (`REAL`, or a `landingRepos` clone with
`-C`). Use the commit's **full** SHA (`git -C <clone> rev-parse <sha>`); a
short SHA cannot be fetched.

```
git fetch <scratch clone> <full sha>
git cherry-pick -n FETCH_HEAD
```

- **Cherry-pick succeeds.** Commit with the executor's message.
  - **Signed-off-by:** delete every `Signed-off-by:` line from the message.
    - With `signoff.mode == hook`, the hook adds exactly one.
    - With `flag`, commit with `-s`.
    - Before pushing, confirm
      `git log -1 --format='%(trailers:key=Signed-off-by,valueonly)'` is
      non-empty whenever signoff is on. A sign-off left mid-message hides
      from git's trailer parser, so the hook skips adding one and the DCO
      check fails.
  - **Epic trailer:** add `Fixes #<epic>` only if this really is the epic's
    last open sub-item (`Fixes <repo>#<epic>` cross-repo).
  - You may change only the message, never the diff.

  ```
  git commit -F <message file>
  ```

  **Push**, after two guards:
  1. **Held-back commits.** Run `git log origin/INT..INT --oneline`. If it
     shows anything besides the commit you just landed, see what it is. If
     any of it is in `PRE_RUN_LOCAL` (the maintainer's own), or is a commit
     this run held back, **don't push**: report it as still local.
  2. **Fresh blockers.** If this item now has an open blocker that step 11
     filed against it during this run, hold the commit back and report it. A
     fresh dependency limits trust in the fix, whatever the item's labels.

  Otherwise:

  ```
  git push origin INT
  ```

  That is one push per landed item, which gives the maintainer live CI on
  `INT` as the run progresses. If the push is rejected, don't force it.
  Report it and stop touching that remote for the rest of the run.

  **Cleanup.** Delete the clone only at the end of one `&&` chain: fetch →
  cherry-pick → commit → push → `git fetch origin` → `origin/INT` equals
  `INT`. A failed step must never be followed by a delete. First, if
  `unitEnvironment` is set, run its teardown and leftover check. Then delete
  each clone with its own guarded command, using the full literal path:

  ```
  D=/abs/path/S/57-a1; test -d "$D/.git" && rm -rf -- "$D"
  ```

  Never use a loop-variable `rm`. Report a clone you couldn't delete; never
  reach for `sudo`.

- **For an advisory unit,** the trailer is only the executor's
  `Refs: <GHSA-id>`. Add no `Fixes` line for anything, and keep the message
  neutral.

- **Cherry-pick conflicts** (a wrong scope prediction):
  1. Run `git cherry-pick --abort`. This is a mechanical problem, not a
     rejected implementation, so it doesn't spend a fix attempt.
  2. Tear down the unit's environment and delete its clone.
  3. Re-clone fresh from the current `INT` and redispatch with a one-line
     "rebase re-run" note.

  Allow at most `limits.rebaseRetries` retries (default 2), then escalate as
  in step 9.

### 8B. `landing: pr-per-unit`

A unit's commits stay on its own branch, `<pr.branchPrefix><unit-id>`, in its
scratch clone. One PR per unit; a bundle's PR holds one commit per item and is
never squashed.

1. **Epic trailer.** If an item is its epic's last open sub-item, amend that
   item's commit **message only**:
   `git -C <clone> commit --amend -F <message + Fixes #<epic>>`. Use this
   only when it is the clone's tip; otherwise note `Fixes #<epic>` in the PR
   body for the maintainer.
2. **Sign-off.** Check it with the same check as 8A, on every commit.
3. **Base.**
   - `PROD`, unless the unit depends on an item whose PR is still open.
   - In that case, the dependency's PR branch. The clone was made from it in
     step 5, and the body says `Stacked on #<PR>; do not merge before it.`
     A stacked PR's trailers act only once it is merged up the stack.
4. **Push** the branch from the clone to the real remote:
   `git -C <clone> push <origin URL of REAL> HEAD:refs/heads/<branch>`.
   The clone's own `origin` is a local path.
5. **Open the PR:**
   `.claude/scripts/gh-rest.sh pr-create --base <base> --head <branch> --title <title> --body-file <file>`.
   - **Title:** the commit subject for a single item, or a summary naming
     every item for a bundle.
   - **Body:** a summary, each item with its `Fixes #<n>`, the checks run,
     and the verifier's PASS.
   - **A risk-flagged unit** opens its body with a bold
     **"Risk-flagged — read line by line before merging"** callout.
6. **Never merge.** No agent, including you, merges a PR. The maintainer
   does.
7. **Clean up only after the push.** Once the push is confirmed
   (`git ls-remote <origin URL> <branch>` shows the SHA), keep the clone if a
   later unit is stacked on it, and delete it with the guarded command
   otherwise.

For wave advancement, an item counts as landed when its PR is open. A
dependent unit stacks on that PR. If the push is rejected, don't force it;
report it and stop.

## 9. On FAIL — fix, then re-verify

**A fix round is always single-item.** A FAIL dissolves its unit.

- **After a single-item attempt:** dispatch a fresh `task-executor` in the
  **same clone**, using the `FIX_ROUND_SAME_WORKSPACE` template branch. Give
  it the rejected SHA and the **blocking** findings verbatim, never the
  notes. It amends.
- **After a bundled attempt:** re-clone fresh from the current base (its
  passing siblings have landed), using the `FIX_ROUND_FRESH_CLONE` branch.
  Point `PRIOR_ATTEMPT_PATH`/`PRIOR_COMMIT_PATH` at the old clone, read-only.
  This makes a normal new commit.

Then dispatch a fresh verifier against the new SHA, with `FIX_ROUND` filled.
It confirms each previous blocking finding is closed and reviews what
changed; it does not hunt for new findings in code an earlier round already
accepted. If a fix round still raises new blocking findings in unchanged
code, read them yourself before dispatching another round. A real data-loss
or security defect stays; anything else is a note, and you say so in the
report.

**After `limits.attempts` FAILs (default 3), keep going only while the
findings narrow.**

- **Narrowing:** each round's blocking findings are strictly narrower than
  the last (earlier ones closed, new ones smaller or edge cases). Dispatch
  the next round without asking.
- **Not narrowing:** the findings are the same or broader. Stop:
  1. Set the item back to `ready`.
  2. `AskUserQuestion` with the latest findings: keep trying, hand it to the
     maintainer, or skip it for now.
  3. Tear down its environment and delete its clone.

An advisory unit has no status to reset, and its findings are never posted.

## 10. Repeat until T is empty

Move to the next wave once every item in the current one has landed, been
skipped as blocked, or been escalated. That includes items step 11 pulled into
this run.

## 11. Route what the run surfaces — as it arrives, not at the end

Every executor report and every verdict can carry **Findings outside these
items**. Route each one **as soon as that report arrives**, before you
dispatch the next unit. Notes never qualify; they stay in the verification
comment.

1. **Is it real?** Check it yourself against the file, line or command it
   names: a defect with a concrete scenario, an untrue doc statement, or work
   a planned feature cannot do without. If it isn't real, drop it and list it
   under "dropped" in the report with a one-line reason.
2. **Is it already tracked?** Search the tracker.
   - If an open item's scope already covers it, file nothing. Note the ref,
     and comment on that item only if the finding adds a concrete detail it
     lacks.
   - If it is really a missing acceptance criterion of an open item nobody
     has started, add it there instead of filing a new item.
3. **Otherwise file it now**, in `triage`'s item shape: Original report,
   Summary, Acceptance criteria, Out of scope, Scope hint. Invoking this skill
   authorizes these writes; `triage`'s approval gate is for maintainer-driven
   planning. Then decide where it belongs:
   - **This run (the default).** Use this when the finding belongs to this
     run's scope (same area or paths as an item in T, or an item in T is not
     really right without it) **and** it can be done now (no maintainer-only
     step, no open dependency outside the run, no pending decision).
     1. Attach it to the same epic as the item it came from.
     2. Add the blocked-by edges ordering needs.
     3. Add it to T and place it in the waves, usually right after the item
        that surfaced it.
     4. Dispatch it like any other item, with its own commit and trailer.

     Closing an epic in this run is never a reason to defer a finding.
   - **Deferred.** Use this when it belongs to other work. Attach it to the
     open epic whose scope it falls under, with blocked-by edges to the open
     items it needs. If no open epic fits, file it without a parent and ask
     the maintainer where it belongs.
4. **A documented default that looks wrong** is always a `docs` item, routed
   the same way. Never make a silent doc edit.
5. **A decision only the maintainer can make:** ask with `AskUserQuestion`
   when it comes up, and put the answer on the item.

**Growth guard.** Ask the maintainer before pulling in more when either holds:

- pulled-in items would grow T by more than `limits.growth` (default 3)
  beyond its original size;
- a pulled-in item surfaces yet another pull-in.

Defer whatever they don't want in this run.

Never fold a finding into an unrelated landing commit: a pulled-in finding
gets its own item and its own commit.

**A finding an advisory unit surfaces is never filed publicly if it could be
exploited.** If `threatModel` rates it Critical or High, it goes into the
report for the maintainer to record as an advisory, and nothing is written
anywhere public. A Medium or lower one is routed as above.

## 12. Compose the report

First, **every item this run leaves open** (blocked, held, escalated,
dropped) gets **one short comment on the item: 1–3 lines**. Say why it is
open and what unblocks it, linking any tracking item. No tables and no
process write-up. An advisory unit gets none.

Then the report:

- **What landed:** item → commit SHA → one line. Say whether it reached
  `origin/INT`, or give the PR URL, what it is stacked on, and the merge
  order.
- **Risk-flagged commits landed this run.** Give them their own list, even if
  it is empty ("none this run"), so the maintainer knows which deserve a
  closer read.
- **Held back:** commits landed locally but not pushed, and why. This list
  also always appears ("none this run").
- **Advisory targets**, each by its GHSA id. Give the landed commit or local
  branch and whether it reached `origin/INT`, or why it did not. For every
  one that landed: once the fix reaches `PROD`, the maintainer publishes the
  advisory (`gh-rest.sh advisory-publish <id>`). Write "none this run" when
  there were none.
- **Proves after landing:** every entry the verdicts listed, each as the
  workflow, the job, the branch it runs on once landed, and what to watch
  for. Write "none this run" when there were none.
- **What's blocked and why:** prepared maintainer-only items, external
  dependencies, escalations, items left out at readiness.
- **Bundles and why.**
- **What step 11 routed:**
  - pulled into this run (item → commit)
  - deferred (item → epic)
  - added to an existing item
  - dropped, with why
- **Promotion budget**, when set: `INT→PROD reviewable: before → after`,
  next to step 4's projection. Re-run `dev-diff.sh --list` after the last
  landing. Name every item whose actual new reviewable files exceed its
  estimate by more than about 50%, every large-diff item, and every item
  dropped for the budget.
- **Leftovers step 0 found** (environments, processes).
- **What's still local, for the maintainer to read and push:** the
  held-back list. Everything else already reached the remote during the run.
- **Next step:** under `dev-cherry-pick`, once items landed on `INT`, the
  promotion. Name `/open-pr` only if `.claude/skills/open-pr/` exists;
  otherwise say "open the `INT` → `PROD` pull request when you're happy with
  what landed". Under `pr-per-unit`, the open PRs to review and merge.

## 13. Notify Discord — only when asked

**Only** if the invocation carries `--discord`, or the maintainer asked in
words for a Discord message for this run. Otherwise skip this step silently.

When asked, after T is exhausted (full or partial success), write step 12's
report as markdown to a temp file and run:

```
.claude/scripts/notify-discord.sh <path to the markdown file>
```

- **Advisory units.** Send nothing about them beyond a count. Leave them out
  of the file's landed, blocked and findings sections entirely, including
  their id, summary, paths, SHA and subject. Add one line instead:
  `1 private advisory fixed` (or `N private advisories fixed`), and
  `1 private advisory not fixed` for one that didn't land, with no reason.
- **The webhook.** The script owns it (`DISCORD_WEBHOOK` in
  `~/.claude/.env`), along with the escaping and the length cap; you never
  read the secret.
- **On failure:** tell the user in one line, and retry at most once.

Then give the user the step-12 report as your final message.

## Non-negotiables

- **The promotion diff never passes the cap** when a budget is set. The check
  runs before every dispatch and every landing. At 90% of the cap, items not
  yet dispatched are dropped, last in wave order first. Estimates err high.
  There is no "proceed anyway" and no one-off exception.
- **Landing follows `landing`.**
  - **dev-cherry-pick:** commits land on local `INT` and are pushed at once,
    except a commit held back by a fresh blocker or sitting above the
    maintainer's own unpushed commits.
  - **pr-per-unit:** one PR per unit, stacked when dependent, never merged by
    an agent.
  - Either way, `PROD` is never pushed to.
- **No agent closes an item, sets `done`, or merges a pull request.** Closing
  happens via a commit's trailer reaching `PROD`.
- **Exactly one status per item**, only through the tracker mapping's
  operations. On Kaneo, the epic rollup is yours.
- **Never invent an item number** in a trailer, and never put a
  tracker-internal id (CUID, `<KEY>-<n>`) in a commit message.
- **No attribution lines** in any commit, PR or comment.
- **Parallel lanes never share a scratch clone.** Only you touch the real
  repo, only at landing, one commit at a time.
- **One commit per item, always.**
- **Never bundle a fix round, a risk-flagged item or an advisory.**
- **Only blocking findings fail an item or reach a fix round.** A fix round's
  verifier checks closure and the change, not the whole item afresh. Fix
  rounds continue past the attempt cap only while findings narrow.
- **Surfaced findings are filed and routed as they arrive.** By default they
  are pulled into this run when they belong to its scope.
- **Every written artifact uses its template:** dispatch prompts, the
  executor's report, the verifier's comment.
- **Every dispatch prompt is passed inline in full**, never as a pointer to a
  file holding it.
- **Never poll or self-schedule while agents run.** Never take over a
  running agent's work; stop it with `TaskStop` first.
- **A clone is deleted only at the end of a successful landing chain,** with
  a guarded command on its literal path.
- **An advisory unit writes nothing to the tracker or a public GitHub
  surface.** Its commit message is neutral and carries `Refs: <GHSA-id>` and
  no `Fixes`. Its verifier is Opus and posts nothing. Discord, when asked for,
  gets a count only.
- **Discord is opt-in:** a message goes out only when the run was started
  with `--discord` or the maintainer asked for one.
