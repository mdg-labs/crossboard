## 🔍 Verification — {{PASS|FAIL}}

**Attempt:** {{N}}
**Reviewed commit:** `{{SHA}}` — {{the commit subject}} (scratch workspace, not yet landed)
**Closes via:** `{{the trailer}}`, once the commit reaches `{{PRODUCTION_BRANCH}}`
{{IF RISK:}}**Risk-flagged:** yes — full risk review; failure test confirmed to fail before and pass after the change{{END IF}}

| Layer | Result (❌ = blocking finding, ⚠️ = notes only) |
|---|---|
| Correctness / compilation | {{✅ ⚠️ or ❌}} — {{one line}} |
| Scope (incl. trailer) | {{✅ ⚠️ or ❌}} — {{one line}} |
| Design conformance | {{✅ ⚠️ or ❌}} — {{one line}} |
| Security | {{✅ ⚠️ or ❌}} — {{one line}} |
| Risk review | {{✅ ⚠️ ❌ or ➖ not applicable}} — {{one line}} |
| Best practice / obvious bugs | {{✅ ⚠️ or ❌}} — {{one line}} |
| Reachability (production caller for everything new) | {{✅ ❌ or ➖ nothing new to reach}} — {{one line: the entry point traced}} |

### Checks run
{{the exact commands executed and their outcome, and any applicable check that could not run on this machine, with why}}

{{ — only if there are any, otherwise omit this whole section: }}
### Proves after landing
- {{workflow file / job — what only a real run can show (a deploy, a secret, a `schedule`, a production-branch-only trigger), and what to watch for}}

{{ — only on a fix round, otherwise omit this whole section: }}
### Previous blocking findings
1. **{{short title}}** — {{closed ✅ | still open ❌}} — {{the evidence}}

{{ — only if FAIL, otherwise omit this whole section: }}
### Blocking findings — must be closed before the next attempt
1. **{{short title}}** — `{{file:line}}` — {{what's wrong, the concrete scenario that shows it, and what closing it requires}}

{{ — only if there are any, otherwise omit this whole section: }}
### Notes — non-blocking, no action required
- {{one line each; never filed, never required of a fix round}}

{{ — only if there are any, otherwise omit this whole section: }}
### Findings outside this item
Real defects with a concrete scenario, outside this item's scope — the orchestrator files or routes each one.
1. **{{short title}}** — `{{file:line}}` or {{the command that shows it}} — {{what's wrong, the scenario, and why it isn't in this item's scope}}

---
*Verified by `task-verifier` via the `orchestrate` skill. This comment does not close the item — only its commit's trailer reaching `{{PRODUCTION_BRANCH}}` does.*
