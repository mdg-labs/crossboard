# Item titles

| Type | Pattern | Example |
|------|---------|---------|
| Bug | `<Area>: <observed defect>` | `Shares: deleting a share leaves its Samba user behind` |
| Feature / task | `<Verb> <target>` | `Add a pool usage widget to the dashboard` |
| User-visible outcome | `<what the user can now do>` | `Users can retry a failed sync from the UI` |
| Epic | `<Feature name>` — no "(epic)" suffix | `Array migration from Unraid` |
| Seeded phase | `Phase <N> — <deliverable>` | `Phase 3 — Rename detection` |
| Dependency alert | `Security: bump <package> to <patched> (<CVE or GHSA>)` | `Security: bump yaml to 2.4.2 (CVE-2026-1234)` |
| Regression | the bug pattern; the `regression` label says the rest | `Mover: files on the cache disk are skipped again` |

- **Area prefix** = the area label's name without `area:`, capitalized, and it
  must agree with the item's area label.
- **At most 80 characters**, no trailing period, no issue numbers in titles.
- **Rewrite** a title that is vague, misspelled or mis-scoped; **keep** one that
  is already accurate; use the user's wording when they asked for a title.
- Set the title in the same edit as the body.
