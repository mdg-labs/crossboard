#!/usr/bin/env bash
# Sourced by the other scripts here, never run on its own.
#
# Every script in this directory is vendored unchanged into a consumer repo's
# .claude/scripts/ by the setup skill, so nothing repo-specific may be written
# into them. What differs per repo lives in .claude/workflow.json, the sibling
# of this directory, and this file is the only place that knows where it is.
#
# Located relative to this file rather than the working directory or
# `git rev-parse`: orchestrate's agents run these from scratch clones, whose
# own .claude/ carries the same workflow.json, and whose `origin` is a local
# path `gh` cannot infer a repository from.
#
# MDG_WORKFLOW_CONFIG overrides the path (tests); GH_REPO overrides the
# repository, the same variable gh itself honours.

WF_CONFIG=${MDG_WORKFLOW_CONFIG:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/workflow.json}

# Prints one value from the config by jq path, or nothing when the config or
# the key is absent — callers decide whether absence is fatal.
wf_get() {
  [[ -f $WF_CONFIG ]] || return 0
  jq -r "$1 // empty" "$WF_CONFIG"
}

# Prints a JSON value (array/object) from the config, or the given default.
wf_get_json() {
  local path=$1 default=${2:-null}
  if [[ -f $WF_CONFIG ]]; then
    jq -c "$path // $default" "$WF_CONFIG"
  else
    printf '%s\n' "$default"
  fi
}

# The owner/name every gh call is scoped to. Never guessed: a wrong default
# here would write labels and comments to some other repository.
wf_repo() {
  local repo=${GH_REPO:-$(wf_get .repo)}
  if [[ -z $repo ]]; then
    printf 'no repository: set "repo" in %s or export GH_REPO\n' "$WF_CONFIG" >&2
    return 1
  fi
  printf '%s' "$repo"
}
