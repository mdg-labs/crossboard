# Tracker: Kaneo

The Kaneo board is where the plan and the status live. The project's GitHub issues are a mirror created by the Kaneo ↔ GitHub sync. They supply the `#n` for commits and close when that commit reaches the production branch. **Agents only ever read them.**

IDs come from `workflow.json` `tracker`: `workspaceId`, `projectId` and `ticketKey` (refs look like `<KEY>-<n>`, e.g. `RO-108`).

## Tool names

There are two ways the same tools can show up:

- `mcp__Kaneo__<tool>`, from a project or user MCP server named `Kaneo`
- `mcp__claude_ai_Kaneo__<tool>`, from the claude.ai connector, which also works in cloud sessions

Use whichever this session lists. Below, every call is written as `Kaneo <tool>`. Pass the exact tool prefix in subagent prompts.

## Columns

Status slugs are exactly `backlog`, `ready`, `in-progress`, `in-review`, `implemented` and `done`. Only `done` is final (`isFinal`). Check them with `Kaneo list_project_columns { projectId }`. The status contract in [README.md](README.md) maps onto them one to one, with `backlog` standing in for `new`.

## Resolve

| Ref | Call |
|-----|------|
| `<KEY>-<n>` | `Kaneo get_task_by_ticket_id { ticketId }`, **without** `projectId`, which can make it 404. The response's `id` is the task CUID. |
| Task CUID | `Kaneo get_task { taskId }`. This does **not** accept `<KEY>-<n>` and fails with "Workspace ID could not be determined". |
| `#n` or issue URL | `.claude/scripts/gh-rest.sh issue-view <n>` → title, then `Kaneo search` for that title (see Search) and take the exact-title match. |
| Task URL | The last path segment is the CUID. |

Then load the rest:

- relations with `Kaneo get_task_relations { taskId }` (subtask edges to children, blocking edges to dependencies)
- comments with `Kaneo list_task_comments { taskId }`

### Finding the item's `#n`

Task payloads carry no GitHub link (checked 2026-10-07: no `externalLinks`). Find `#n` from the mirror, read-only:

1. If the user gave `#n`, use it.
2. If the payload has an `externalLinks` issue entry, use its `externalId`.
3. Otherwise run `.claude/scripts/gh-rest.sh issue-search "<exact task title>" --state all` and take the exact-title match.
4. No match: ask the user. Never guess.

Resolve the epic's `#n` too, because the commit that completes the epic carries `Fixes #<epic>`.

## Search

`Kaneo search { q, type: "tasks", workspaceId, projectId }`

- The parameter is `q`, not `query`.
- When you scope the search, pass both `workspaceId` and `projectId`.
- To list one column, use `Kaneo list_tasks` for the project and filter by status.

## Create

```
Kaneo whoami                                     → userId, once per run
Kaneo create_task { projectId, title, description, priority, status: "ready", userId }
Kaneo create_task_relation { sourceTaskId: <epic>, targetTaskId: <child>, relationType: "subtask" }
Kaneo create_task_relation { sourceTaskId: <blocker>, targetTaskId: <blocked>, relationType: "blocks" }
Kaneo attach_label_to_task { taskId, labelId }   → labels from Kaneo list_workspace_labels
```

Assign every new task to the operator. The GitHub mirror appears after the sync; resolve its `#n` as described above before reporting.

**Labels.** Use the same families as GitHub (type, areas from `labels.areas`, extras), by name. Kaneo label rows can be tied to a task, so attaching one takes care:

1. `Kaneo list_workspace_labels { workspaceId }`.
2. Attach a row with that name whose `taskId` is null.
3. If every row with that name is already tied to another task, `Kaneo create_label` with the same name and color, plus this `taskId`.
4. Never re-attach a row that belongs to another task.
5. A label name that doesn't exist in the workspace yet needs the maintainer's approval first.

`update_task` merges fields: pass only what changes.

## Edit

`Kaneo update_task { taskId, title?, description? }`. Labels go through `attach_label_to_task` and `detach_label_from_task`. Never change status this way.

## Set status

`Kaneo update_task_status { taskId, status }`

Kaneo has no rollup script. The orchestrator computes the epic's status from `get_task_relations` and the children's columns, using the README's table, and sets it.

## Comment

`Kaneo create_task_comment { taskId, content }`. Content is limited to 10,000 characters. Verdict comments go on the Kaneo task, never on the GitHub mirror.

## Forbidden

- Any write to a GitHub issue: create, edit, label, comment, assign, close.
- Setting `done`. The sync does that when the `Fixes #n` commit reaches the production branch.
- Putting a CUID or `<KEY>-<n>` in a commit message.

## In dispatch prompts

The orchestrate templates are tracker-neutral. The orchestrator fills these tokens for each item. `<P>` is the Kaneo tool prefix this session lists. Agents inherit the session's MCP tools; the deferred ones load with `ToolSearch` `select:<P>update_task_status,<P>create_task_comment`, so say so in the dispatch.

| Token | Kaneo fill |
|-------|------------|
| `{{ITEM_REF}}` | `<KEY>-<n> (#<mirror n>)` |
| `{{TRAILER_REF}}` | `#<mirror n>` |
| `{{CLAIM}}` | `<P>update_task_status { taskId: "<cuid>", status: "in-progress" }`. If the call fails, report the item `blocked`; never start unclaimed. |
| `{{ROLLUP}}` | Always omitted. The orchestrator rolls epics up itself. |
| `{{HAND_OFF}}` | `<P>update_task_status { taskId: "<cuid>", status: "in-review" }` |
| `{{POST_VERDICT}}` | `<P>create_task_comment { taskId: "<cuid>", content: <the filled comment> }`, at 10,000 characters or fewer |
| `{{SET_PASS}}` / `{{SET_FAIL}}` | `<P>update_task_status { taskId: "<cuid>", status: "implemented" }` / `… "in-progress"` |
| `{{TRACKER_WRITES}}` | "Your only tracker writes are the Kaneo status calls named below. Never write to a GitHub issue, and never set `done`, `ready` or `backlog`." (verifier: "…the status calls and the one verdict comment named below…") |
