---
description: Commits, trailers, staging, pushing and the checks before them — for every change in this repo
---

# Git and commits

Branch names, the gate and the per-path checks come from `.claude/workflow.json`
(`branches`, `gate`, `checks`).

## Commits

- **Subject:** a Conventional Commit, `<type>(<scope>): <imperative summary>`,
  72 characters or fewer.
- **Body:** explains *why*, and describes the current design, never the review
  history.
- **Trailer:** a commit that completes a tracked item ends with `Fixes #<n>`,
  where `<n>` is the item's GitHub issue number. On a Kaneo repo that is the
  task's GitHub mirror. One item per commit. A private advisory fix ends with
  `Refs: GHSA-…` and nothing else. See `.claude/trackers/README.md`.
- **Never in a commit:** `[#n]` in the subject, a tracker-internal id (a Kaneo
  CUID, `<KEY>-<n>`), or an invented number.
- **No attribution.** No `Co-Authored-By`, no session link, no "Generated with"
  line, in any commit or pull request.
- **Sign-off:** follows `signoff`. With a hook it is added automatically; never
  write a `Signed-off-by:` line by hand.

## Staging

Stage explicit paths only. Never `git add -A`, `git add .` or `git commit -a`.

## Before committing and pushing

- **Before a commit,** run every `checks` entry whose paths the change touches.
- **Before a push,** run the full `gate`.
- **A check that can't run here** is reported as such, never skipped
  silently.
- **Never weaken, skip or quarantine a test** to get a change through.

## Pushing

- **Push only when the user asks,** or when a skill they invoked says that
  invoking it authorizes that push.
- **Never push to `branches.production`.** It moves only through a merged pull
  request.
- **Never force-push.**
- **Never amend or rebase a commit that is already pushed.**
- **Never merge a pull request.** The maintainer merges.
