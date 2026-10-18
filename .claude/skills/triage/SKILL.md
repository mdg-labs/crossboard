---
name: triage
description: Turn a report into ready, well-scoped tracked items. Given an existing item (#n, <KEY>-n, or a URL), investigate the code read-only and enrich it in place. Given a stated problem or feature with no item, run a local planning pass and, after approval, create a single item or an epic with sub-items. Also seeds a roadmap phase as an epic, and turns a Dependabot alert (number, CVE or GHSA) into a security item. Works with GitHub issues or Kaneo, per .claude/workflow.json. Never edits repo files; stops at ready for orchestrate. Use when asked to triage, investigate, ticket, plan, break down, or file something.
argument-hint: <item-ref> | dependabot <alert-number | CVE | GHSA> | seed <phase> | <free-form report or feature>
allowed-tools:
  - Read
  - Grep
  - Glob
  - AskUserQuestion
  - Bash
  - Write
---

# triage

Turns a raw report, an idea or an alert into **complete, current, correctly
scoped** tracked items in `ready`. It also enriches existing items the same
way. `orchestrate` implements what this skill leaves `ready`. Its readiness gate
and `issue-refiner` expect exactly the item shapes in
`templates/item-shapes.md`.

## Hard constraint: read-only against the repo

- **No repo writes.** You never edit, create or delete a repo file, and you
  never run a mutating git command.
- **Temporary files** (item bodies, plan drafts) go in this session's
  scratchpad directory. That is the only place `Write` is used.
- **Reading upstream source.** Cloning one is allowed only when an item truly
  depends on its behaviour:
  `git clone --depth 1 <url> ../reference/<name>`. Never clone speculatively.
  Read it for behaviour and intent, never to transcribe code.
- **Read-only checks.** You may run read-only checks (a single test, a query)
  to confirm a hypothesis.
- **Code or doc changes are out of scope.** If a request needs one, stop and
  say so: that is `orchestrate`'s job.

## What this skill reads

- **`.claude/workflow.json`:**
  - `repo`, `tracker`, `branches`, `maintainer`
  - `labels`, `riskPaths`, `checks`, `gate`, `promotionBudget`
- **CLAUDE.md `## Agent workflow`:**
  - `### Design docs`: where specs live, which wins on conflict, decision and
    default numbering
  - `### Area → paths`
  - `### Entry points`
  - `### Implementation rules`
- **`.claude/trackers/README.md` plus the mapping for `tracker.type`.** Every
  "read", "search", "create", "edit", "link" and "set status" below is done
  the way the mapping says. On GitHub, everything goes through
  `.claude/scripts/gh-rest.sh`, never a `gh` call of your own. On
  Kaneo, GitHub issues are read-only.
- **`templates/item-shapes.md`** and **`templates/titles.md`**, next to this
  file.

## Pick the mode

| Input | Mode |
|-------|------|
| `#n`, `<KEY>-n`, an issue or task URL, "triage #n" | **A — Enrich** |
| A problem, bug report or feature described with no item | **B — Plan and create** |
| "seed phase N", a roadmap item or section | **C — Seed** (Mode B, epic-shaped) |
| A Dependabot alert number or URL, a CVE or GHSA id, "is there a ticket for <package>?" | **D — Dependency alert** |

When nothing usable was given, ask one `AskUserQuestion`.

## Investigate — proportional to the item

Scale the investigation to the item; a typo fix needs none of it.

1. **Read the design docs** CLAUDE.md maps for this area, and cite their
   sections. A settled decision the report conflicts with goes under
   `## Constraints`. A documented default the report shows is wrong: the item
   proposes the change, and its acceptance criteria include updating the doc.
2. **Read the code.** Grep it, then `git log`, `git blame` and `git show` on
   what you find. **Check the integration branch before describing anything as
   still to build**, and record what exists in `## Current state`.
3. **Search the tracker** for related and duplicate items, closed ones
   included. On GitHub:
   `.claude/scripts/gh-rest.sh issue-search "<terms>" --state all`. This
   matches every term against title and body; it is not a relevance search,
   so try more than one wording.
4. **Read an upstream project** only when the item depends on its behaviour.
   Add `## Upstream / reference context` with the version or commit you read.

**Never invent behaviour, fields, endpoints or ids.** What the docs and code
don't settle becomes an open question.

**Open questions** always carry a recommended default and a one-line
rationale, citing the documented default when one exists. Prefer applying the
default to asking. Ask the maintainer only when no reasonable default exists
or the choice is theirs to make.

## Fewer, complete items

- **Extend before you add.** If an open item that nobody has started (`new`,
  `backlog`, `ready`) already covers the work, add to it. Report which item
  absorbed it.
- **A decision and its code are one item.** File a separate `docs` item only
  when no code follows, or when the maintainer must decide first. In that
  case, create the code item too, blocked by the decision item.
- **Size gate: ~800 changed lines.** Count without generated code or
  lockfiles. Anything larger is split into parts that each ship on their own
  **and each carry their own wiring** (their own `Reachable via`). Splits are
  vertical slices, never a "package" item plus a later "wire it in" item.
  Escaped defects scale with size, so this is a hard gate.
- **Every runtime change is reachable.** A feat or bug that changes runtime
  behaviour gets `Reachable via: <entry point> → <capability>` among its
  acceptance criteria, with the entry-point file (`### Entry points`) in its
  Scope hint.
- **Every item has a home.** It is either an epic or a sub-item of an open
  epic. On GitHub it also takes the epic's milestone, if the epic has one. If
  no epic fits, say so in the handoff; never invent one silently.
- **Risk.** An item carrying `labels.risk`, or whose scope matches
  `riskPaths`, names in its acceptance criteria the failure scenario its test
  reproduces.

## Labels

- **Type, exactly one:** `feat`, `bug`, `chore`, `docs`, `spike`. The readiness
  gate is keyed on these names.
- **Area:** one or more from `labels.areas`, matching the paths the item
  touches (`### Area → paths`).
- **Extras, as warranted:**
  - `epic`
  - `blocked`, only for an external blocker that can't be a native link
  - `security`
  - `regression`
  - `dependencies`
  - the repo's `labels.risk`, `labels.maintainerOnly` and `labels.extra`
- **Maintainer-applied labels are proposed, never applied.** These are
  `labels.maintainerOnly` and every `labels.extra` entry with
  `maintainerApplied`. Name them in the proposal for the maintainer to add.
  `gh-rest.sh` refuses to add them.
- **Never create a new label name, and never set a status label.** A new
  label name goes in the proposal's open questions for approval. Status moves
  only through the tracker mapping.

## Relationships — native, never prose

Membership (epic → sub-item) and dependencies (blocked-by) are native tracker
links:

- **GitHub:** `gh-rest.sh add-sub-issue` / `add-blocked-by`.
- **Kaneo:** `create_task_relation` with `subtask` / `blocks`.

Never write "Part of #N" or "Depends on #N" in a body. **Create first, link
second,** then read the links back to verify them. A body that mentions an item
you are about to create uses a placeholder (`<NEW-B>`), patched to the real
ref before you finish. No placeholder is ever left behind.

## Mode A — Enrich an existing item

1. **Resolve it** and read its body and every comment. Comments override the
   body where they disagree.
2. **Status guard:**

   | Status | Action |
   |--------|--------|
   | `new` / `backlog` / `ready` | Enrich |
   | `in-progress` / `in-review` | Enrich only if the user explicitly asked; never change its status |
   | `implemented` / `done` / closed | **Stop.** If the defect came back, go to **Regression** below; otherwise propose a new item that references this one |
3. **Investigate** (above).
4. **Rewrite the title and body** per `titles.md` and `item-shapes.md`.
   - Keep the original text verbatim under `## Original report`: the existing
     body plus the comments that changed scope, quoted with their dates.
   - A body that already has `## Original report` keeps it unchanged. A
     legacy `## Report` heading is renamed, with its content kept verbatim.
5. **Splitting or rescoping?** If the result splits the item or changes what
   it delivers, stop and use Mode B's proposal and approval for that change.
   Otherwise write directly:
   - **GitHub:** `gh-rest.sh issue-edit <n> --title … --body-file … --add-label … [--milestone …]`
   - **Kaneo:** `update_task` with only the changed fields, then labels per the
     mapping.
6. **Wire the relationships** it needs.
7. **Set `ready`.** Skip this if it is already further along or closed.
8. **Report:** the URL, what changed, the defaults applied, and open questions.

**Findings go in the body, never in a comment.** Comments are for verification
verdicts and decisions.

### Regression

When an item that is `implemented`, `done` or closed recurs:

- Never reopen or edit the old item.
- Create a **new** bug with the `regression` label and a `## Regression`
  section (`item-shapes.md`), referencing the old item and its fixing commit.
- This goes through Mode B's approval.

## Mode B — Plan, then create

### Phase 1 — plan locally, write nothing to the tracker

1. **Investigate** (above), and search for duplicates. If an open item covers
   it, switch to Mode A on that item instead. That still means enriching an
   existing item, so tell the user.
2. **Decide the shape:**
   - **One item:** a single change, in one area, under ~800 lines.
   - **An epic with sub-items:** more than one area, over ~800 lines, or parts
     that can land independently. Each sub-item is independently
     implementable and verifiable, and carries its own `Reachable via`.
3. **Draft every body in full** (`item-shapes.md`) into the scratchpad.
4. **Post the proposal in chat:**

   ```markdown
   ## Proposed items — <feature or change>

   **Mode:** create | regression | seed <phase>
   **Duplicates checked:** <none found | #n — why this is not a duplicate>

   | # | Title | Type · areas · extras | ~Lines · files | Blocked by | Summary |
   |---|-------|------------------------|----------------|------------|---------|
   | E | <epic title> | epic · … | — | — | <goal> |
   | 1 | <title> | feat · area:api | ~300 · 6 | — | <one line> |
   | 2 | <title> | feat · area:web | ~250 · 5 | 1 | <one line> |

   **Suggested order:** 1 → 2 → …
   **Lands under:** <epic, milestone — or "new epic E">
   **New labels needing approval:** <none | names>
   **Open questions:** <each with its recommended default — or "none">

   Full bodies: <scratchpad path>
   ```

   - **Five or more items:** also save the proposal next to the bodies.
   - **More than ~12 items:** the count and every title must be part of the
     approval question.
5. **Ask for approval** with `AskUserQuestion`:
   - **Approve:** go to Phase 2.
   - **Revise:** the user says what to change. Update the plan, re-post it,
     and ask again.
   - **Cancel:** stop, and write nothing.

   Never create anything in the same turn as the proposal without that
   answer. An instruction like "just ticket it" upfront does not skip it.

### Phase 2 — create (after approval only)

1. **Kaneo only:** `whoami` once, so every created task can be assigned to
   the operator.
2. **Create the epic first, if there is one, then each sub-item.**
   - **GitHub:** `gh-rest.sh issue-create --title … --body-file … --label …
     [--milestone …]`. The workflow stamps `status:new`.
   - **Kaneo:** `create_task` in `backlog`, assigned to the operator.
3. **Wire the links:** sub-items under their epic, then blocked-by edges.
   Patch every `<NEW-…>` placeholder with the real ref.
4. **Verify by re-reading each created item.** Check its body (no
   placeholders left), labels, links and assignee.
5. **Set `ready` last, on every item.** An orchestrator must never pick up a
   half-wired item.
6. **Handoff:** each item's ref and URL in suggested order (on Kaneo, also its
   GitHub mirror `#n` once the sync has created it), then the open questions,
   then the next step: `orchestrate <epic or first item>`.

### Mode C — Seed a phase or roadmap item

Mode B, shaped as an epic:

- **Title:** `Phase <N> — <deliverable>`.
- **Body:** the epic's `## Original report` quotes the phase's deliverable and
  "done when" text verbatim from the doc.
- **Sub-items:** one per independently landable part.
- **Ordering:** when the roadmap is sequential, the epic is blocked by the
  previous phase's epic.

## Mode D — Dependency alert

1. **Read the alert.** Use `gh-rest.sh alert-get <n>`, or for a CVE or GHSA,
   `gh-rest.sh alert-list --jq '…'` filtered on
   `security_advisory.cve_id` / `ghsa_id`.
   - **Record:** the package and ecosystem, the manifest path and scope, the
     vulnerable range, the first patched version, GHSA, CVE, severity and
     alert URL.
   - **Fixed or dismissed alert:** stop, and file no item.
   - **No read access:** ask the user for the fields; never guess.
2. **Collect sibling alerts.** Several open alerts for the same advisory (one
   per manifest) become **one** item listing every alert.
3. **Check for duplicates.** Search for the package name, the GHSA id and the
   CVE id, each with `--state all`, and read each hit, since search matching
   is loose.
   - **An open item covers it,** whatever its status short of done: report it
     and file nothing. Say so if it lacks this alert number; edit it only on
     request.
   - **Only done or closed items cover it:** file a new item that references
     them ("Previously fixed in").
4. **Write the body** in the **Dependency alert** shape: type `bug`, labels
   `security` and `dependencies`, plus the manifest's area. Title per
   `titles.md`.
   - **No approval needed:** an alert item is filed directly, because the
     alert is the report.
   - **Kaneo priority:** critical → urgent, high → high, medium → medium,
     low → low.
5. **Create it,** then set it `ready`.
6. **Report:** the alert, the duplicate check, and the new item.
7. **"Is there a ticket for X?"** is a search-only question: answer it and
   create nothing.

**Never dismiss an alert**, through any API or UI. An alert closes only when
the patched version reaches the default branch. If the bump can't land, the
item says so and stays open.

## Security reports that are not alerts

A report of an exploitable defect in this repo's own code is never filed
publicly before it is fixed.

- **Judge it** against the repo's `threatModel`, if it has one.
- **Critical or high:** run `.claude/scripts/security-route.sh`.
  - **`advisories`:** propose a **private security advisory** instead of an
    item (`gh-rest.sh advisory-create … --dry-run` first). Ask the
    maintainer.
  - **`issues`:** the repository is private and has no advisories. File an
    ordinary item labelled `security`, through the usual approval. Its title
    and body are neutral, with no exploit payload. Never propose an advisory.
  - **The script fails:** ask the maintainer; never guess.
- **Medium or lower,** or hardening: an ordinary item with the `security`
  label.

## Items filed by orchestrate

`orchestrate` files the findings it surfaces mid-run in these same shapes,
without this skill's approval step. Invoking orchestrate authorizes those
writes. This skill's approval gate is for maintainer-driven planning.

## Forbidden

- **Repo writes:** any repo file edit or mutating git command.
- **Skipping approval:** creating items in Mode B or C without an explicit
  Approve, or in the same turn as the proposal.
- **Wrong statuses:** setting any status other than `ready`; closing,
  reopening or cancelling an item.
- **Touching finished items:** reopening or editing an `implemented`, `done`
  or closed item.
- **Prose links:** writing membership or dependencies in a body; leaving a
  placeholder behind.
- **Labels:** creating a new label name without approval; an item without
  exactly one type label.
- **Invention:** invented behaviour, fields, endpoints or ids; an open
  question without a recommended default.
- **Secrets:** secrets or token-shaped strings in any body.
- **Kaneo:** any GitHub write. **GitHub:** a `gh` call of your own, outside `.claude/scripts/`.
- **Alerts:** dismissing a Dependabot alert.
