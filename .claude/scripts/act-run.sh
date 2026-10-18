#!/usr/bin/env bash
# Runs one GitHub Actions job locally with nektos/act, so an executor or
# verifier can prove a workflow change in its own scratch clone instead of
# waiting for a real run that only lands after the change does.
#
# Usage: .claude/scripts/act-run.sh <workspace> <workflow file> <job id> [event]
#   <workflow file>  name under <workspace>/.github/workflows/ (e.g. ci.yml)
#   [event]          the event to simulate; default push
# Exit: 0 pass (the job ran and act reported it succeeded), 1 fail, or
#   2 usage, 3 act disabled or not runnable on this machine,
#   4 refused: the job, or a job it needs, matches act.neverRun,
#   5 unproven: act exited 0 but the job never ran (skipped by its `if:`).
#
# Settings come from .claude/workflow.json `act` (null or absent disables it):
#   platforms  { runs-on label: image } passed as -P, e.g. runners01
#   neverRun   job-id globs never run locally (deploy, migrate, publish, …)
#   timeout    seconds for the run, and for waiting on another lane; default 1800
#
# What it guarantees, whatever the repo or the user's act config says:
#   - no secrets, env, vars or inputs reach a job: every file act would read
#     them from is /dev/null, GITHUB_TOKEN is set empty, and act starts with
#     a minimal environment (act copies GITHUB_TOKEN or GH_TOKEN from its own
#     environment into secrets.GITHUB_TOKEN and github.token) and an empty
#     HOME, so a ~/.actrc cannot add any;
#   - `-j` pulls in a job's `needs`, so act's own plan of the whole graph is
#     checked against neverRun before anything starts — including jobs the
#     dry run then skips, whose `if:` may read outputs only a real run sets;
#   - one act run per user at a time: act names containers after the
#     workflow and job, so two lanes running the same job would collide;
#   - nothing is left behind: containers are removed (--rm), and the
#     workspace is copied into the container, never bound, so it stays as it
#     was — a read-only verifier may run this too;
#   - neither a repo .actrc nor a global one applies (see act_cmd below).
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=workflow-config.sh
source "$HERE/workflow-config.sh"

ACT=${MDG_ACT_BIN:-act}
LOCK=${MDG_ACT_LOCK:-/tmp/mdg-act-$(id -u).lock}

say() { printf 'act-run: %s\n' "$*" >&2; }
die() { say "$*"; exit 2; }
unavailable() { say "UNAVAILABLE: $*"; exit 3; }

[[ $# -ge 3 && $# -le 4 ]] || die "usage: $0 <workspace> <workflow file> <job id> [event]"
ws=$1 wf=$2 job=$3 event=${4:-push}
[[ -d $ws/.git ]] || die "not a git checkout: $ws"
ws=$(cd -- "$ws" && pwd)
[[ $wf != */* ]] || die "workflow file is a name under .github/workflows/, not a path: $wf"
wf_path="$ws/.github/workflows/$wf"
[[ -f $wf_path ]] || die "no such workflow: $wf_path"

cfg=$(wf_get_json .act null)
[[ $cfg != null ]] || unavailable "act is disabled (workflow.json \"act\" is null or absent)"
command -v "$ACT" >/dev/null || unavailable "act is not installed"
command -v flock >/dev/null || unavailable "flock is not installed"
timeout 20 docker info >/dev/null 2>&1 || unavailable "no Docker daemon reachable"

limit=$(jq -r '.timeout // 1800' <<<"$cfg")
platforms=()
while IFS= read -r p; do
  [[ -n $p ]] && platforms+=(-P "$p")
done < <(jq -r '(.platforms // {}) | to_entries[] | "\(.key)=\(.value)"' <<<"$cfg")
mapfile -t never < <(jq -r '(.neverRun // [])[]' <<<"$cfg")

real_cache=${XDG_CACHE_HOME:-$HOME/.cache}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home"

# Launched from $tmp with -C, never from the workspace: act reads ./.actrc
# from its own working directory and applies it on top of these flags, so a
# repo's .actrc could otherwise pass secrets or --bind.
keep=(PATH="$PATH" HOME="$tmp/home" XDG_CONFIG_HOME="$tmp/home/.config" XDG_CACHE_HOME="$real_cache")
for v in DOCKER_HOST DOCKER_TLS_VERIFY DOCKER_CERT_PATH TMPDIR; do
  [[ -z ${!v:-} ]] || keep+=("$v=${!v}")
done
act_cmd=(env -i "${keep[@]}"
  "$ACT" "$event" -C "$ws" -W "$wf_path" -j "$job" "${platforms[@]}"
  --secret-file /dev/null --env-file /dev/null --var-file /dev/null --input-file /dev/null
  -s GITHUB_TOKEN= --rm --pull=false --artifact-server-path "$tmp/artifacts" --json)
cd "$tmp"

# act's log records, one JSON object per line; anything else passes through.
records() { grep '^{' || true; }

# The dry run plans the job graph without creating a container. Its debug
# log names every planned stage ("Stages Runs: [a b]"), skipped jobs too.
if ! graph=$(timeout 120 "${act_cmd[@]}" -n -v </dev/null 2>&1); then
  [[ $graph != *"Could not find any stages to run"* ]] || die "no job '$job' runs on '$event' in $wf"
  say "FAIL: dry run did not validate"
  printf '%s\n' "$graph" | grep -v '^{' >&2 || true
  printf '%s\n' "$graph" | records \
    | jq -r 'select(.level == "error" or .level == "fatal") | .msg' >&2 2>/dev/null || true
  exit 1
fi
mapfile -t jobs < <(printf '%s\n' "$graph" | records \
  | jq -r '.msg // "" | select(startswith("Stages Runs: [")) | ltrimstr("Stages Runs: [") | rtrimstr("]") | split(" ")[]' \
    2>/dev/null | { grep -v '^$' || true; } | sort -u)
# No plan means this act logs it differently: fail closed, never run blind.
[[ ${#jobs[@]} -gt 0 ]] || unavailable "act did not report its job plan; cannot check neverRun"
[[ " ${jobs[*]} " == *" $job "* ]] || die "no job '$job' runs on '$event' in $wf"
for j in "${jobs[@]}"; do
  for g in "${never[@]}"; do
    # shellcheck disable=SC2053 # $g is a glob on purpose
    if [[ $j == $g ]]; then
      say "REFUSED: job '$j' (run for '$job') matches neverRun '$g'"
      exit 4
    fi
  done
done

say "running $wf/$job on '$event' (jobs: ${jobs[*]})"
rc=0
flock -E 75 -w "$limit" "$LOCK" timeout "$limit" "${act_cmd[@]}" </dev/null >"$tmp/run.log" 2>&1 || rc=$?
# Readable log: step output as "[job]   | line", everything else as "[job] msg".
jq -R -r '. as $line | (try fromjson catch null) as $r | if ($r | type) != "object" then $line elif $r.raw_output then
  ($r.msg | rtrimstr("\n") | split("\n")[] | "[\($r.jobID // "-")]   | \(.)")
  else "[\($r.jobID // "-")] \($r.msg)" end' "$tmp/run.log" 2>/dev/null || cat "$tmp/run.log"
case $rc in
  0) ;;
  75) say "UNAVAILABLE: another act run held the lock for ${limit}s"; exit 3 ;;
  124) say "FAIL: $wf/$job timed out after ${limit}s"; exit 1 ;;
  *) say "FAIL: $wf/$job exited $rc"; exit 1 ;;
esac
# Exit 0 alone is not a pass: a job skipped by its `if:` exits 0 too.
results=$(records <"$tmp/run.log" | jq -r --arg j "$job" 'select(.jobID == $j and .jobResult) | .jobResult' 2>/dev/null | sort -u)
if [[ -z $results ]]; then
  say "UNPROVEN: $wf/$job did not run on '$event' (skipped by its if:?)"
  exit 5
fi
if [[ $results != success ]]; then
  say "FAIL: $wf/$job result: $(tr '\n' ' ' <<<"$results")"
  exit 1
fi
say "PASS: $wf/$job"
