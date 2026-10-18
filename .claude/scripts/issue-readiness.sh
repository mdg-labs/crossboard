#!/usr/bin/env bash
# Mechanical readiness check for an issue, before orchestrate dispatches it.
#
# The orchestrator must not investigate code itself (its context stays small),
# but it has to know when an issue is too thin or too old to hand to an
# executor: untriaged issues fail verification far more often and let more
# defects through to review. This script only reads the issue text. An issue
# it rejects goes to an issue-refiner subagent, which does the investigation.
#
# Usage: .claude/scripts/issue-readiness.sh <issue-number>
# Prints READY or NOT-READY plus one reason per line; paths the body names
# that do not exist in this checkout are listed as warnings (new files are
# legitimate, so they never make an issue NOT-READY on their own).
# Exit: 0 ready, 1 not ready, 2 usage or gh failure.
#
# Repo-specific stale terms come from .claude/workflow.json
# `readiness.stale`: [{ "pattern": ERE, "reason": text, "exempt": ERE }].
# A line matching `exempt` (one that cites the decision or negates the term)
# states the current design rather than a stale assumption.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=workflow-config.sh
source "$HERE/workflow-config.sh"

die() { printf '%s\n' "$*" >&2; exit 2; }

[[ $# -eq 1 && $1 =~ ^[0-9]+$ ]] || die "usage: $0 <issue-number>"
n=$1

json=$("$HERE/gh-rest.sh" issue-view "$n") || die "issue-readiness: could not read #$n"
body=$(jq -r '.body // ""' <<<"$json")
labels=$(jq -r '[.labels[].name] | join(" ")' <<<"$json")

has_label() { [[ " $labels " == *" $1 "* ]]; }

if has_label epic; then
  printf '#%s READY\n- epic: not dispatched itself\n' "$n"
  exit 0
fi

reasons=()
section() { grep -qE "^##[[:space:]]+$1" <<<"$body"; }

section 'Original report' || reasons+=("no '## Original report' — never triaged (synced or hand-written)")
section 'Acceptance criteria' || reasons+=("no '## Acceptance criteria'")
if has_label feat || has_label bug || has_label chore; then
  section 'Out of scope' || reasons+=("no '## Out of scope'")
fi
# A dependency bump changes no capability, so it has nothing to wire.
if [[ $(wf_get '.readiness.requireReachableVia') != false ]] && ! has_label dependencies \
  && { has_label feat || has_label bug; }; then
  # Only the criteria count: the original report quoting the phrase does
  # not put the wiring requirement into what the executor must satisfy.
  criteria=$(awk '/^##[[:space:]]+Acceptance criteria/ {on=1; next} /^##[[:space:]]/ {on=0} on' <<<"$body")
  grep -qiE 'Reachable via' <<<"$criteria" || reasons+=("no 'Reachable via:' criterion — nothing says where the capability must be wired")
fi

stale=$(wf_get_json '.readiness.stale' '[]') || die "issue-readiness: could not read readiness.stale from $WF_CONFIG"
while IFS=$'\t' read -r pattern reason exempt; do
  [[ -n $pattern ]] || continue
  exempt=${exempt:-'\bno\b|\bnot\b|never|retired|removed'}
  if grep -iE -- "$pattern" <<<"$body" | grep -qviE -- "$exempt"; then
    reasons+=("stale: $reason")
  fi
done < <(jq -r '.[] | [.pattern, .reason, (.exempt // "")] | @tsv' <<<"$stale")

root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
# Any backticked token that looks like a repo-relative path: no spaces, at
# least one slash, not a URL.
# shellcheck disable=SC2016 # the backticks are literal Markdown, not a substitution
path_re='`[A-Za-z0-9._-]+/[^` ]*`'
missing=()
while IFS= read -r p; do
  [[ $p == *://* ]] && continue
  p=${p%%[*{<…:#]*}
  p=${p%/}
  [[ -z $p || -e "$root/$p" ]] || missing+=("$p")
done < <(grep -oE "$path_re" <<<"$body" | tr -d '`' | sort -u)

if ((${#reasons[@]})); then
  printf '#%s NOT-READY\n' "$n"
  printf -- '- %s\n' "${reasons[@]}"
  status=1
else
  printf '#%s READY\n' "$n"
  status=0
fi
if ((${#missing[@]})); then
  printf -- '- warning: path not in this checkout: %s\n' "${missing[@]}"
fi
exit "$status"
