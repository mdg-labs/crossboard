## Execution report — {{UNIT_ID}}

**Workspace:** `{{WORKSPACE_PATH}}`
**Isolated environment:** {{"destroyed, confirmed gone" | "not used" | "not available in this repo"}}
**Items in this dispatch:** {{<ITEM_REF>, … in the order you worked them}}

{{FOR EACH ITEM — one block per item in this dispatch, including any you had
to report blocked:}}

### {{ITEM_REF}} — {{ITEM_TITLE}}

**Status:** {{done | blocked | already-resolved}}
**Commit:** `{{SHA}}` — {{the commit subject}} {{or "none — blocked" / "none — already resolved by <sha>"}}
**Trailer:** `{{the trailer line the commit carries}}`
**Tracker:** {{claim ✓/✗ · hand-off ✓/✗ — and the error if a call failed}}

**Files touched:**
- {{path}}

**Summary:** {{2-5 sentences: what was implemented and how}}

**Checks run:** {{every check actually run inside WORKSPACE for this item, with its result — and every applicable check that could NOT run on this machine, with why}}

**Proves after landing:** {{each workflow job whose acceptance only a real run can show, and why act could not — or "none"}}

**Dependencies:** {{packages added or changed, with the resolved versions — or "none"}}

**Generated output changed:** {{goldens / generated code and why — or "none"}}

**Destructive or security-relevant code paths touched:** {{each one, and the test covering it — or "none"}}

**Design references and defaults:** {{doc sections implemented; any decision or default this relies on; any default you believe is wrong, and why — or "none"}}

**Deviations from the item text:** {{where and why — or "none"}}

**Left undone / blocked:** {{what and why; for already-resolved, the evidence — or "none"}}

{{END FOR}}

### Findings outside these items
{{only real problems none of the items above cover and you did not fix: a pre-existing defect with a concrete scenario, a doc statement that is untrue, or work a planned feature cannot do without. One line each — what, where (`file:line` or the command that shows it), the scenario, and why it isn't yours. Not findings: style, hardening you would like, ideas, and tooling missing on this machine. The orchestrator files or routes each one; you never open an item. "none" is the normal answer.}}
