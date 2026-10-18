---
name: open-pr
description: Opens (or updates) the promotion pull request from the integration branch to the production branch (.claude/workflow.json branches), titled for everything it implements — never "release"/"promote" framing — with a description generated from the commits and items since production last moved. Use when the maintainer says "open a PR to main", "promote dev", "release dev to main", or similar. Never touches the production branch and never merges. Only for repos with landing dev-cherry-pick; pr-per-unit repos get their PRs from orchestrate.
argument-hint: (no arguments)
allowed-tools:
  - Read
  - Write
  - Bash(git fetch *)
  - Bash(git status)
  - Bash(git branch *)
  - Bash(git log *)
  - Bash(git diff *)
  - Bash(git rev-list *)
  - Bash(git rev-parse *)
  - Bash(git merge-tree *)
  - Bash(git merge --no-ff *)
  - Bash(git merge --abort)
  - Bash(git push origin *)
  - Bash(.claude/scripts/gh-rest.sh *)
  - Bash(.claude/skills/dev-diff/dev-diff.sh*)
  - Bash(gh run list *)
  - Bash(gh run view *)
  - Bash(timeout * gh run watch *)
  - AskUserQuestion
---

# open-pr

Opens the **integration → production** promotion pull request. That PR is the
*only* way the production branch moves. This skill prepares and files it, or
updates one that is already open. It never merges anything and never touches
the production branch itself. Merging is gated by required checks and is the
maintainer's call.

Read `.claude/workflow.json` first. Below, `INT` = `branches.integration`,
`PROD` = `branches.production`, `REPO` = `repo`. If `landing` is
`pr-per-unit`, stop and say so: that repo's PRs come from `orchestrate`, one
per unit.

## Hard constraints

- **Base is always `PROD`, head is always `INT`.** Never the reverse.
- **Never merge.** Don't approve or request review on the maintainer's
  behalf.
- **Never push on the maintainer's behalf, with one exception.**
  - If local `INT` is ahead of `origin/INT`, stop and say so. Don't push to
    make the PR "complete".
  - The one push this skill makes is step 4's back-merge of `PROD` into `INT`.
    That is a merge commit that brings no content, needed because a ruleset
    usually only merges a branch that is up to date, and every promotion
    leaves `PROD` one merge commit ahead.
- **No attribution lines** in the PR title or body: no `Co-Authored-By`, no
  session link, no "Generated with".
- **Invoke-only.** Opening a PR is a visible, shared-state action. Being asked
  to run this skill *is* that request, so it needs no extra confirmation once
  invoked.

## Steps

1. `git fetch origin` for current refs.
2. Compare `git rev-parse INT` with `git rev-parse origin/INT`. If they
   differ, local `INT` has unpushed commits. Stop and tell the maintainer to
   push first, rather than pushing it yourself.
3. Run `git rev-list --left-right --count origin/PROD...origin/INT`. If `INT`
   is 0 commits ahead, there is nothing to promote: report that and stop.
4. **Bring `INT` up to date with `PROD`, only when it is behind.**
   - Run `git rev-list --count origin/INT..origin/PROD`. If it prints `0`,
     skip this whole step.
   - **Only a merge that brings no content is made here.** Every change on
     `PROD` came from `INT`, so merging `PROD` back must leave `INT`'s tree
     exactly as it is.
     - `git merge-tree --write-tree origin/INT origin/PROD` must succeed and
       print the same tree as `git rev-parse origin/INT^{tree}`.
     - If it conflicts or prints a different tree, `PROD` holds something
       `INT` lacks (a hotfix or a hand edit). Stop, show
       `git log --oneline origin/INT..origin/PROD` and
       `git diff origin/INT origin/PROD --stat`, and leave it to the
       maintainer. Never resolve a conflict or merge real content here.
   - The current branch must be `INT`, with a clean working tree. Otherwise
     stop and say so. Never switch branches or stash the maintainer's work.
   - Run `git merge --no-ff origin/PROD -m "Merge branch 'PROD' into INT"`.
     If it fails anyway, run `git merge --abort` and stop.
   - Run `git push origin INT`. Never force. If the push is rejected (`INT`
     moved meanwhile), stop and report it.
   - **Wait for CI on the merge commit before going on.**
     - Find the runs for the exact pushed SHA with
       `gh run list --repo REPO --branch INT --commit $(git rev-parse INT) --json databaseId,workflowName,status,conclusion`.
     - The runs can take a few seconds to appear. Retry a bounded number of
       times (at most ~10, a few seconds apart), never in an open-ended loop.
     - Wait on each run with
       `timeout 3600 gh run watch <id> --repo REPO --exit-status`, as a
       **background** Bash command, and end the turn. Its exit re-invokes
       you. Never poll with `sleep` in the foreground.
   - **CI must pass.** If a run fails, is cancelled or times out, stop and
     don't create or update the PR. Report the run URL and the failing jobs
     (`gh run view <id> --repo REPO --log-failed`, bounded and filtered).
     The merge brought no content, so a red run means `INT` itself is red.
     That is the thing to fix first.
5. **Check the review budget,** when `promotionBudget` is set. Run
   `.claude/skills/dev-diff/dev-diff.sh`. If `FILES REVIEWABLE BY CODERABBIT`
   is above the cap, stop: don't create or update the PR. The cap is hard.
   CodeRabbit is the only PR reviewer and will not review the whole PR, and
   there is no other review path. Report the count and the cap; the
   maintainer brings `INT` back under it before promoting.
6. **Look for an existing open promotion PR** with
   `.claude/scripts/gh-rest.sh pr-list --base PROD --head INT --state open --jq '.[] | {number,title,url}'`.
   If one exists, go through steps 7 and 8 as usual, then in step 9
   **update** it instead of creating a duplicate.
7. **Gather the promotion's contents:**
   - The commit list: `git log --oneline origin/PROD..origin/INT`.
   - The trailers: `git log origin/PROD..origin/INT --format=%B`, to pull
     every `Fixes #n` trailer. For each one, get the item's title and
     labels with `.claude/scripts/gh-rest.sh issue-view <n> --jq '{title,labels:[.labels[].name]}'`.
     On a Kaneo repo these are the GitHub mirrors, read-only.
   - A `Refs: GHSA-…` trailer is listed by id only, never with a
     description: the advisory is not published until the maintainer does so
     after the merge.
   - The files and areas touched: `git diff --stat origin/PROD...origin/INT`.
   - **Risk content:** cross-check the touched paths against CLAUDE.md's
     `### Area → paths`. Call out risk content explicitly, never bury it:
     items labelled `labels.risk`, and paths matching `riskPaths`.
   - **Release:** if CLAUDE.md says how a release is cut (a version file, a
     tag), say whether merging this promotion triggers one.
   - **CI on the exact commit being promoted:**
     `gh run list --repo REPO --branch INT --commit $(git rev-parse origin/INT) --json workflowName,status,conclusion,headSha`.
     If no run exists for that SHA, or one isn't green, say so plainly. Don't
     fall back to an older or unrelated run to make the PR look ready.
8. **Draft the title and body.**
   - **The title describes what changed**, never that a promotion is
     happening. GitHub already shows this is a promotion PR. Never
     `chore(release): promote dev to main`, "Release x.y.z", or any other
     "release" or "promote" framing.
     - It names **everything the PR implements**, as one Conventional
       Commits-style line: the shared type and scope, then each piece of work
       in a few words. Example:
       `feat(api): share quotas, audit log export and session revocation`.
     - Never title it after one commit or one item. Group closely related
       commits under one phrase so the line stays readable. When the work
       spans several areas, use the type that fits most of it and leave the
       scope out.
     - Re-check the title against the full commit list before filing. Every
       item in `## Issues closed`, and every commit with no item, must fall
       under some phrase in it.
   - **The body** goes in a scratchpad temp file:
     - `## Summary`: one or two sentences on what this promotion contains.
     - `## Issues closed`: a bulleted `Fixes #n — <title>` list.
     - `## Changes by area`: bulleted, grouped by area.
     - `## Risk-flagged`: only when it applies. Name the items and what makes
       them so.
     - `## Release`: only when merging triggers one.
     - `## CI status`: the run results from step 7, and the reviewable-file
       count from step 5.
9. **File it:**
   `.claude/scripts/gh-rest.sh pr-create --base PROD --head INT --title "…" --body-file <tmp>`.
   To update an existing PR instead:
   `.claude/scripts/gh-rest.sh pr-edit <n> --title "…" --body-file <tmp>`.
10. **Report** the PR URL, the closed-item list and the CI status, then stop:
    no merge, no review request, no further action. The next step is the
    review round: `/pr-review <PR number>`. A promotion PR gets exactly one
    review round. After its fixes are pushed, the merge gate is the
    required checks on the new head, not a second review.
