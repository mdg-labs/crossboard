#!/usr/bin/env bash
# Lists the earlier commits touching the given paths that fixed a security
# defect, so an executor or verifier sees the guards earlier security fixes
# added before it edits the same files.
#
# A commit counts when either holds:
#   - its subject names a CVE or GHSA id, or says security/harden, or its
#     `Refs:` trailer names a GHSA id (an advisory fix) — works on any tracker;
#   - on a GitHub-tracked repo, its `Fixes #n` trailer names an issue that
#     carries the `security` label.
# Subject and trailers are matched separately, so a passing mention in a body
# does not count.
#
# Usage: .claude/scripts/security-history.sh <path>...
# Run from inside the checkout whose history is read (a path is relative to
# it). Prints one line per commit, newest first:
#   <sha> <subject>[ (fixes #n: <issue title>)]
# at most SECURITY_HISTORY_MAX lines (default 10), then a line saying how many
# more there are. Prints nothing and exits 0 when there are none. Exit 2 on a
# usage error or when git or GitHub cannot be read: an unreadable history is
# an error, never "no history".
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=workflow-config.sh
source "$HERE/workflow-config.sh"
REPO=$(wf_repo)
MAX=${SECURITY_HISTORY_MAX:-10}
MAX_LINE=200

die() { printf 'security-history: %s\n' "$*" >&2; exit 2; }

[[ $# -ge 1 ]] || die "usage: $0 <path>..."
[[ $MAX =~ ^[1-9][0-9]*$ ]] || die "SECURITY_HISTORY_MAX must be a positive integer"

declare -A title=()
if [[ $(wf_get .tracker.type) == github ]]; then
  issues=$("$HERE/gh-rest.sh" issue-list --state all --label security \
    --jq '.[] | [.number, .title] | @tsv') \
    || die "could not list the issues labelled security"
  while IFS=$'\t' read -r number issue_title; do
    [[ -n $number ]] && title[$number]=$issue_title
  done <<<"$issues"
fi

history=$(git log --no-merges --format='%x1e%h%x1f%s%x1f%(trailers:key=Refs,valueonly,unfold,separator=%x20)%x1f%b' -- "$@") \
  || die "could not read the git history of: $*"

cve='cve-[0-9]{4}-[0-9]+'
ghsa='ghsa-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}'
security='(^|[^a-z0-9_])security([^a-z0-9_]|$)'
harden='(^|[^a-z0-9_])harden'

# A trailer may name this repository explicitly (`Fixes owner/repo#n`), the
# form a commit in a sibling repository uses to close an issue here.
fixes_re="^[Ff]ixes[[:space:]]+(${REPO//./\\.})?#([0-9]+)[[:space:]]*$"

lines=()
while IFS= read -r -d $'\x1e' record; do
  [[ -n $record ]] || continue
  IFS=$'\x1f' read -r -d '' sha subject refs body <<<"$record" || true
  s=${subject,,}
  r=${refs,,}
  linked=""
  if (( ${#title[@]} )); then
    while IFS= read -r body_line; do
      [[ $body_line =~ $fixes_re ]] || continue
      number=${BASH_REMATCH[2]}
      [[ -n ${title[$number]:-} ]] || continue
      linked=" (fixes #$number: ${title[$number]})"
      break
    done <<<"$body"
  fi
  if [[ -n $linked || $s =~ $cve || $s =~ $ghsa || $s =~ $security || $s =~ $harden || $r =~ $ghsa ]]; then
    line="$sha $subject$linked"
    lines+=("${line:0:MAX_LINE}")
  fi
done <<<"$history"$'\x1e'

(( ${#lines[@]} > 0 )) || exit 0

printf '%s\n' "${lines[@]:0:MAX}"
if (( ${#lines[@]} > MAX )); then
  printf '... and %d more\n' $(( ${#lines[@]} - MAX ))
fi
