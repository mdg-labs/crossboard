#!/usr/bin/env bash
# Fast-forwards the local production branch from origin (without switching
# branches) and reports how the integration branch differs from it — the diff
# the next promotion PR will carry. Read-only w.r.t. the integration branch:
# never touches its ref. Branch names and the file cap come from
# .claude/workflow.json (branches.integration / .production, promotionBudget);
# they default to dev, main and 150 (CodeRabbit Essentials' per-PR file limit).
#
# With --list, prints only the paths CodeRabbit would review, one per line, on
# stdout; every other line (errors, notices) goes to stderr.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=workflow-config.sh
source "$HERE/../../scripts/workflow-config.sh"
INT=$(wf_get .branches.integration); INT=${INT:-dev}
PROD=$(wf_get .branches.production); PROD=${PROD:-main}
CAP=$(wf_get .promotionBudget); CAP=${CAP:-150}

list_only=0
case "${1-}" in
    "") ;;
    --list)
        if [[ $# -gt 1 ]]; then
            echo "usage: dev-diff.sh [--list]" >&2
            exit 2
        fi
        list_only=1
        ;;
    *)
        echo "usage: dev-diff.sh [--list]" >&2
        exit 2
        ;;
esac

if [[ "$list_only" -eq 1 ]]; then
    exec 3>&1 1>&2
fi

start_branch="$(git rev-parse --abbrev-ref HEAD)"

if [[ -n "$(git status --porcelain)" ]]; then
    echo "ERROR: working tree not clean on '$start_branch'. Aborting without touching refs."
    exit 1
fi

error_file="$(mktemp)"
trap 'rm -f "$error_file"' EXIT

git fetch origin --quiet

if [[ "$start_branch" == "$PROD" ]]; then
    if ! git pull --ff-only origin "$PROD" --quiet 2>"$error_file"; then
        echo "ERROR: local $PROD did not fast-forward from origin/$PROD (diverged)."
        cat "$error_file"
        exit 1
    fi
else
    if ! git fetch origin "$PROD:$PROD" --quiet 2>"$error_file"; then
        # A branch checked out in another worktree can't be updated by a
        # fetch; that is not divergence, and saying so would mislead.
        if grep -q 'checked out at' "$error_file"; then
            echo "ERROR: local $PROD is checked out in another worktree, so it can't be fast-forwarded from here."
        else
            echo "ERROR: local $PROD did not fast-forward from origin/$PROD (diverged)."
        fi
        cat "$error_file"
        exit 1
    fi
fi

if ! git rev-parse --verify "$INT" >/dev/null 2>&1; then
    echo "No local '$INT' branch exists — nothing to compare (origin/$INT is not a stand-in)."
    exit 0
fi

local_int="$(git rev-parse "$INT")"
origin_int="$(git rev-parse "origin/$INT" 2>/dev/null || echo "")"
if [[ -z "$origin_int" ]]; then
    int_sync="origin/$INT not found"
elif [[ "$local_int" == "$origin_int" ]]; then
    int_sync="in sync with origin/$INT"
else
    int_sync="DIFFERS from origin/$INT"
fi

counts="$(git rev-list --left-right --count "$PROD...$INT")"
prod_only="$(cut -f1 <<<"$counts")"
int_only="$(cut -f2 <<<"$counts")"

files="$(git diff --name-only "$PROD...$INT")"
if [[ -z "$files" ]]; then
    file_count=0
else
    file_count="$(wc -l <<<"$files" | tr -d ' ')"
fi

# CodeRabbit's own path_filters (.coderabbit.yaml, reviews.path_filters)
# decide what it actually reviews — pull the exclude patterns (entries
# starting with "!") from there instead of hardcoding them, so this stays
# correct if that config changes. The file cap is CodeRabbit's, so the
# PR-scoping count must exclude what CodeRabbit itself never looks at
# (generated code, recorded spike evidence, etc.) — otherwise the count
# includes files that don't count against the cap.
exclude_specs=()
if [[ -f .coderabbit.yaml ]]; then
    if ! command -v python3 >/dev/null 2>&1; then
        echo "ERROR: .coderabbit.yaml exists but python3 is unavailable to parse its path_filters." >&2
        echo "Refusing to report a FILES REVIEWABLE count without them — it would silently include excluded paths." >&2
        exit 1
    fi
    if ! patterns_output="$(python3 -c "
import yaml, sys
with open('.coderabbit.yaml') as f:
    cfg = yaml.safe_load(f) or {}
for p in (cfg.get('reviews') or {}).get('path_filters') or []:
    if isinstance(p, str) and p.startswith('!'):
        print(p[1:])
" 2>"$error_file")"; then
        echo "ERROR: failed to parse .coderabbit.yaml's path_filters (missing PyYAML or invalid YAML)." >&2
        cat "$error_file" >&2
        exit 1
    fi
    # glob magic: CodeRabbit's patterns are globs where "**/" also matches
    # no directory at all; a plain ":!**/x/**" would miss a top-level x/.
    while IFS= read -r pattern; do
        [[ -n "$pattern" ]] && exclude_specs+=(":(glob,exclude)$pattern")
    done <<<"$patterns_output"
fi

if [[ "${#exclude_specs[@]}" -gt 0 ]]; then
    reviewable_files="$(git diff --name-only "$PROD...$INT" -- . "${exclude_specs[@]}")"
else
    reviewable_files="$files"
fi
if [[ -z "$reviewable_files" ]]; then
    reviewable_count=0
else
    reviewable_count="$(wc -l <<<"$reviewable_files" | tr -d ' ')"
fi
pr_count=$(( (reviewable_count + CAP - 1) / CAP ))

if [[ "$list_only" -eq 1 ]]; then
    if [[ -n "$reviewable_files" ]]; then
        echo "$reviewable_files" >&3
    fi
    exit 0
fi

echo "started-on: $start_branch"
echo "local $INT: $int_sync"
echo "$INT ahead of $PROD: $int_only commits"
echo "$PROD ahead of $INT: $prod_only commits"
echo "FILES REVIEWABLE BY CODERABBIT: $reviewable_count"
echo "PRs needed at $CAP-file cap: $pr_count"
echo "(files differing, raw total incl. excluded paths: $file_count)"

if [[ "$reviewable_count" -gt 0 ]]; then
    echo
    echo "--- by top-level path (reviewable only) ---"
    cut -d/ -f1 <<<"$reviewable_files" | sort | uniq -c | sort -rn
    echo
    echo "--- reviewable files ---"
    echo "$reviewable_files"
fi

excluded_count=$(( file_count - reviewable_count ))
if [[ "$excluded_count" -gt 0 ]]; then
    echo
    echo "--- excluded by .coderabbit.yaml path_filters ($excluded_count files, not shown) ---"
fi
