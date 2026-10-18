# Tracker contract

Every skill and agent talks about work items in the terms on this page. The repo's `.claude/workflow.json` `tracker.type` picks which mapping applies:

- [github.md](github.md): GitHub issues through `.claude/scripts/gh-rest.sh`. This is the default.
- [kaneo.md](kaneo.md): Kaneo through its MCP server, with GitHub issues as a read-only mirror.

When a skill says "the tracker", it means the operations below, done the way the mapping says. Nothing outside the mapping files names a tracker API.

## Work items

| Term | Meaning |
|------|---------|
| **Item** | One implementable unit: a GitHub issue, or a Kaneo task. |
| **Epic** | A parent item whose children are its sub-items. There are exactly two levels: epic → sub-item. An epic is never dispatched itself. |
| **Ref** | What the user types. `#n`, an issue URL, or for Kaneo, `<KEY>-<n>` or a task URL. |
| **`#n`** | The GitHub issue number. It is the only identifier that ever appears in a commit. For Kaneo it is the mirror issue's number, found read-only. |
| **Blocked-by** | A native dependency link. Membership and dependencies are never written as prose in the body. |

## Status machine

Each item has exactly one status at a time.

```
new/backlog ──triage──▶ ready ──executor──▶ in-progress ──executor──▶ in-review
                          ▲                      ▲                        │
                          │                      └────verifier FAIL───────┤
                   orchestrator                                     verifier PASS
                  (abandoned/budget)                                      ▼
                                                                    implemented ──fix reaches production──▶ done/closed
```

| Status | Set by | When |
|--------|--------|------|
| `new` / `backlog` | Tracker automation, or whoever files the item | It is filed and has not been triaged yet |
| `ready` | `triage` | Triage has passed the readiness check |
| `ready` (again) | orchestrator | The item was blocked, escalated, or dropped for the promotion budget |
| `in-progress` | `task-executor` | Before its first edit. The orchestrator sets it as a backstop right after dispatch |
| `in-review` | `task-executor` | After the item's commit is made in its scratch clone |
| `implemented` | `task-verifier` | On PASS. The verdict comment is posted first |
| `in-progress` (rework) | `task-verifier` | On FAIL. The verdict comment is posted first |
| `done` / `closed` / `cancelled` | Tracker automation only | When the `Fixes #n` commit reaches the production branch. No agent ever sets this |

An epic's status is computed from its sub-items, never set incrementally:

| Sub-items | Epic status |
|-----------|-------------|
| Any of them in progress or in review | `in-progress` |
| All of them implemented or closed | `implemented` |
| None started | Unchanged |

A sub-item counts as done for dependents when it is `implemented`, not when it is closed.

## Operations

Each mapping file has one section per operation:

1. **Resolve.** Turn a ref into the item's title, body, labels, status, parent, sub-items and blockers. Then get its `#n`.
2. **Search.** Find duplicates by title and keywords.
3. **Create.** Make a new item with its body, labels and initial status, plus its epic link and blocked-by links.
4. **Edit.** Change the body and title, or add and remove labels. Never touch status this way.
5. **Set status.** Move the item to one status. For epics, recompute the rollup.
6. **Comment.** Post the verifier's verdict, or record a decision.
7. **Forbidden.** Operations no agent may perform on this tracker.

## Commits

```
<type>(<scope>): <imperative summary>

<why, in prose>

Fixes #<n>
```

- **One item per commit,** with its own `Fixes #n` trailer.
- **Closing an epic.** The commit that finishes an epic's last sub-item also gets `Fixes #<epic>`. The orchestrator adds it at landing.
- **Cross-repo.** A commit in a sibling repo closes an issue here with `Fixes owner/repo#n`.
- **Private advisories.** The commit message stays neutral and ends with a `Refs: GHSA-…` trailer, with no `Fixes`.
- **Never in a commit:** a tracker-internal ID (a Kaneo CUID, or `<KEY>-<n>`), `[#n]` in the subject, or any Claude attribution.
- **Never invent `#n`.** If it cannot be resolved, ask.
