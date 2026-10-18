#!/usr/bin/env bash
# Fails on a direct GitHub call anywhere under .claude/ or scripts/ outside
# the vendored scripts: a `gh issue`/`gh pr`/`gh repo view`/… subcommand,
# `gh api graphql`, a search, or `--paginate`. Those infer the repository
# from the working directory (wrong or missing in orchestrate's scratch
# clones, whose `origin` is a local path) and skip the scripts' error
# handling. Every GitHub call goes through gh-rest.sh instead.
#
# The vendored scripts themselves (.claude/scripts/*.sh) may use GraphQL and
# `--paginate`: they are scoped to workflow.json's repo and tested. Orchestrate
# no longer runs in Claude Code cloud sessions, whose egress proxy refused
# both, which is what this check was first written for.
#
# Vendored to .claude/scripts/; the repo root is two levels up. Run it from
# the repo's lint target and CI.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$HERE/../.." && pwd)
# Two allowlists in the same format: the one vendored with these scripts,
# covering the vendored skills and agents, and the repo's own, for its own
# files. Either may be absent.
allowlists=("$HERE/gh-rest-allowlist.txt" "$root/.claude/gh-rest-allowlist.local.txt")

# Each pattern is an extended regex checked one line at a time.
patterns=(
  'gh +issue +(view|list|edit|create|comment|close|reopen)\>'
  'gh +pr +(view|list|create|edit|comment|merge|checks|status)\>'
  'gh +repo +view\>'
  'gh +label +list\>'
  'gh +release +list\>'
  'gh +api +graphql\>'   # allowed in .claude/scripts/*.sh (see script_only)
  'gh +api +search/'
  'gh +search\>'
  '\-\-search\>'
  '\-\-paginate\>'
)

# Allowlist lines are "<repo-relative file>::<substring>" — a file whose
# flagged line also contains that exact substring is prose that *forbids*
# the command ("Never `gh issue close`" and its siblings), not a live call. This is deliberately narrow: a new
# reintroduction of a forbidden pattern anywhere else in that same file
# still fails, because the substring has to actually be present on the
# flagged line.
declare -a allow_file=() allow_substr=()
for allowlist in "${allowlists[@]}"; do
  [[ -f $allowlist ]] || continue
  while IFS= read -r entry; do
    [[ -z $entry || $entry == \#* ]] && continue
    [[ $entry == *"::"* ]] || continue
    allow_file+=("${entry%%::*}")
    allow_substr+=("${entry#*::}")
  done <"$allowlist"
done

# Patterns the vendored scripts may use; a skill, agent or doc still may not.
script_only=('gh +api +graphql\>' '\-\-paginate\>')
in_script_only() {
  local pat=$1 p
  for p in "${script_only[@]}"; do [[ $pat == "$p" ]] && return 0; done
  return 1
}

is_allowed() {
  local file=$1 line=$2 i
  for i in "${!allow_file[@]}"; do
    if [[ $file == "${allow_file[$i]}" && $line == *"${allow_substr[$i]}"* ]]; then
      return 0
    fi
  done
  return 1
}

fail=0
while IFS= read -r -d '' file; do
  rel=${file#"$root"/}
  line_no=0
  while IFS= read -r line || [[ -n $line ]]; do
    line_no=$((line_no + 1))
    for pat in "${patterns[@]}"; do
      if [[ $line =~ $pat ]]; then
        if [[ $rel == .claude/scripts/*.sh ]] && in_script_only "$pat"; then
          continue
        fi
        if is_allowed "$rel" "$line"; then
          continue
        fi
        printf 'check-gh-rest: %s:%d: forbidden pattern (%s): %s\n' \
          "$rel" "$line_no" "$pat" "$line" >&2
        fail=1
      fi
    done
  done <"$file"
done < <(
  dirs=()
  for d in "$root/.claude" "$root/scripts"; do [[ -d $d ]] && dirs+=("$d"); done
  ((${#dirs[@]})) || exit 0
  find "${dirs[@]}" -type f \
    \( -name '*.md' -o -name '*.sh' -o -name '*.yml' -o -name '*.yaml' \) \
    -not -path '*/testdata/*' \
    -not -name 'check-gh-rest.sh' \
    -not -name 'test-check-gh-rest.sh' \
    -not -name 'gh-rest-allowlist.txt' \
    -not -name 'gh-rest-allowlist.local.txt' \
    -print0
)

exit "$fail"
