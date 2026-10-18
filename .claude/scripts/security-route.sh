#!/usr/bin/env bash
# Prints where this repo's Critical and High security findings go:
#   advisories — a draft private security advisory, never a public item
#                (the threat model's disclosure split, rules/mdg-security.md)
#   issues     — an ordinary tracker item labelled security, like every other
#                finding: the repository is private, and GitHub offers no
#                security advisories or private vulnerability reporting on a
#                private repository (the advisories API answers 404)
#
# While the repository is private the answer is issues: absent or true. A
# `false` there is an error (exit 2), because GitHub offers a private
# repository no security advisories, so routing to them could never file
# anything. On a public
# repository it is always advisories, whatever the setting says, so a
# repository made public with the setting still in place never files an
# exploitable finding in public; a set `true` there is reported on stderr.
#
# The visibility is read live on every call, never cached: the answer must
# follow the repository the day it changes. A failed read is an error, never
# a guess.
#
# Usage: .claude/scripts/security-route.sh
# Exit 0 with one word on stdout; exit 2 when the setting or the repository
# cannot be read.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=workflow-config.sh
source "$HERE/workflow-config.sh"

die() { printf 'security-route: %s\n' "$*" >&2; exit 2; }

[[ $# -eq 0 ]] || die "usage: $0"

# tojson, not wf_get_json: jq's `//` default would read a set `false` as absent.
setting=$(wf_get '.security.privateRepoIssues | tojson') \
  || die "could not read security.privateRepoIssues from $WF_CONFIG"
setting=${setting:-null}
[[ $setting == true || $setting == false || $setting == null ]] \
  || die "security.privateRepoIssues must be true or false, got $setting"

private=$("$HERE/gh-rest.sh" repo-view --jq '.private') \
  || die "could not read the repository's visibility"
case $private in
  true)
    [[ $setting != false ]] \
      || die "security.privateRepoIssues is false, but the repository is private and GitHub offers it no security advisories: remove the setting, or make the repository public"
    echo issues ;;
  false)
    [[ $setting == true ]] \
      && printf 'security-route: security.privateRepoIssues is set, but the repository is public: advisories\n' >&2
    echo advisories ;;
  *) die "unexpected visibility from repo-view: '$private'" ;;
esac
