---
name: dev-diff
description: Fast-forwards the local production branch from origin (without switching away from the current branch) and reports how the integration branch differs from it — commits ahead each way, and the files that differ, counted the way CodeRabbit counts them against its per-PR file cap. Branch names and the cap come from .claude/workflow.json. Use for "how far ahead is dev", "diff main and dev", "how many files differ", "how big is the next promotion".
argument-hint: (no arguments)
allowed-tools:
  - Bash(.claude/skills/dev-diff/dev-diff.sh)
---

# dev-diff

Read-only reporting for repos that land on an integration branch and promote it to production through one PR (`landing: dev-cherry-pick`).

`dev-diff.sh`:

- Fast-forwards the local production branch and reports how the integration branch differs from it.
- Scopes the count to what CodeRabbit actually reviews. It reads the exclusions under `.coderabbit.yaml`'s `reviews.path_filters`, and headlines the count that remains, since that is what the file cap applies to.
- Takes the branch names (`branches.integration` / `.production`) and the cap (`promotionBudget`) from `.claude/workflow.json`.
- Makes no commits and opens no PR. It never leaves the maintainer on a different branch than the one they started on.

## Hard constraints

- **No ref changes.** Never `checkout`, `reset --hard`, `merge`, or anything `--force`. The script only fetches, fast-forwards the production branch and diffs; it never touches the integration branch's ref.
- **The script is the whole report.** Don't re-run the git commands it already ran, and don't add your own `git diff` or `git log` calls on top of it.
- **PyYAML.** It needs `python3` with PyYAML to read `.coderabbit.yaml`. Without them it refuses rather than over-count.

## `--list` mode

`dev-diff.sh --list` is for scripts, not for this skill's report.

- It prints only the reviewable paths of the promotion diff, one per line, after the same fetch, fast-forward and exclusion logic.
- Errors and notices go to stderr, with the same non-zero exits as a normal run.
- With no local integration branch it prints nothing and exits 0.

`orchestrate` uses it to budget the cap.

## Steps

1. Run `.claude/skills/dev-diff/dev-diff.sh` (no arguments).
2. If it exits non-zero, report the exact error lines it printed and stop. Don't attempt a fix yourself. The causes are:
   - an unclean working tree;
   - the production branch has diverged from origin;
   - the production branch is checked out in another worktree.
3. If it printed "No local '<branch>' branch exists", report that and stop.
4. Otherwise, relay its output **verbatim** as the whole answer. Headline the `FILES REVIEWABLE BY CODERABBIT` and `PRs needed at N-file cap` lines, since scoping a promotion depends on them. Don't re-derive or narrate.
