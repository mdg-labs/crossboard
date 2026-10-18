# Item shapes

Every item triage writes uses one of these shapes. `orchestrate`'s readiness
gate and `issue-refiner` expect exactly them. Section headings are fixed;
optional sections are left out entirely rather than left empty. Never write
membership or dependencies as prose ("Part of #N", "Depends on #N") — they are
native links.

## Leaf (feat, bug, chore, docs)

```markdown
## Original report

<the reporter's text, verbatim. In enrich mode: the existing body, plus every
comment that changed scope, quoted with its date. Never paraphrased.>

## Summary

<one or two sentences: what this delivers, as of the integration branch today>

## Design references

<the spec and design-doc sections this rests on, and any settled decision or
documented default it relies on — named the way CLAUDE.md `### Design docs`
says. "none" when nothing applies.>

## Current state

<what already exists and what is a stub (`501`, `TODO`, skipped test, fixed
data), with `file:line` or commit. "nothing yet" is a valid answer. Check the
code before describing anything as still to build.>

## Reproduction            <!-- bug only -->

<exact steps, input and observed vs expected>

## Root cause / relevant code            <!-- when investigated -->

<ranked suspects, each as `path` + symbol + why; the confirmed cause first>

## Upstream / reference context            <!-- only when an upstream was read -->

<the upstream project, version or commit, and what it does — behaviour and
intent, never transcribed code>

## Proposed approach            <!-- only where the design leaves a real choice -->

## Constraints            <!-- when a decision or rule limits the approach -->

## Acceptance criteria

- [ ] <checkable statement of done — states the bar: "refuses X; Y stays allowed">
- [ ] Reachable via: <entry point> → <capability>      <!-- feat/bug with runtime behaviour -->
- [ ] <for risk work: the failure scenario its test reproduces>
- [ ] <for UI work: the error, empty and loading states it shows>
- [ ] <the checks from workflow.json `checks` for the touched paths pass>

## Out of scope            <!-- required for feat, bug and chore -->

- <adjacent work, with the item that owns it — or "none">

## Open questions            <!-- only if one remains -->

1. <question> — **Recommended default:** <answer> — <one-line rationale>

## Scope hint

`<top-level path>`, `<entry-point file>`, … · ~<N> changed lines (excluding
generated code and lockfiles) · Expected files: <N> reviewable (`<likely paths>`)
```

Rules:

- **Acceptance criteria are the whole definition of done.** Hardening "while
  we're there" is either a criterion or listed under Out of scope — never
  implied.
- **`Reachable via:` sits inside Acceptance criteria**, and its entry-point file
  is in the Scope hint. Never split work into a "build the package" item and a
  later "wire it in" item.
- **`Expected files`** counts reviewable files only: leave out what
  `.coderabbit.yaml` `path_filters` exclude. Don't net it against the current
  promotion diff — orchestrate does that.
- **Spike**: the deliverable is recorded findings — acceptance criteria name
  what is measured, the pass/kill criterion, and the design-doc entries it
  settles.

## Epic

```markdown
## Original report

<verbatim, as for a leaf; for a seeded phase, the phase's deliverable and
"done when" text quoted verbatim from the doc>

## Summary

<what the whole epic delivers>

## Design references

## Goal

<the user-visible outcome when every sub-item is done>

## Product rules

<cross-cutting rules every sub-item must respect — only if there are any>

## Out of scope
```

The epic carries no acceptance criteria of its own and is never dispatched;
its sub-items are linked natively. Report the suggested implementation order in
the handoff, not in the body.

## Regression

A leaf `bug` with the `regression` label and one extra section directly after
`## Original report`:

```markdown
## Regression

Regressed from <item ref> (<its status>), fixed in `<sha>` — <what that fix did
and how the defect came back, if known>.
```

The earlier item is never reopened or edited.

## Dependency alert

A leaf `bug` labelled `security` and `dependencies` (plus the area of the
manifest's paths). No `Reachable via` — a bump changes no capability.

```markdown
## Original report

Dependabot alert #<n> (<severity>): <advisory summary>

## Summary

Bump `<package>` to `>= <patched version>` so the vulnerable range is gone from
every manifest and lockfile.

## Alert details

- **Package:** `<name>` (<ecosystem>)
- **Manifest:** `<manifest path>` · scope <runtime | development>
- **Vulnerable:** `<range>` · **Patched:** `>= <version>`
- **Advisory:** <GHSA id> · <CVE id or "no CVE">
- **Alert:** <alert URL>
- **Same advisory, other alerts:** <#m (<manifest>), … — or "none">
- **Previously fixed in:** <item ref — only for a recurrence>

## Resolution path

<how this repo bumps it: the package-manager command, a transitive override,
an image tag or action ref — from CLAUDE.md `### Implementation rules`. Note
when another open item's bump probably resolves this one too.>
Land the fix on `<integration branch>`; the alert closes by itself once the
patched version reaches the default branch. Never dismiss the alert.

## Acceptance criteria

- [ ] `<package>` resolves to `>= <patched>` in every listed manifest and lockfile
- [ ] <the gate> passes

## Out of scope

- <other packages pulled by the same parent, with their items; a major-version
  migration the bump does not need — or "none">

## Scope hint

`<manifest>`, `<lockfile>` · ~<N> changed lines (excluding the lockfile) ·
Expected files: <N> reviewable (`<paths>`)
```

A vulnerability in a part of the repo that isn't shipped (a docs site, dev
tooling) is still fixed; say so in the Summary.
