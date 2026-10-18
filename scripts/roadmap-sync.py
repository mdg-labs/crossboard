#!/usr/bin/env python3
"""File docs/roadmap.md on GitHub as epics and sub-issues, then delete it.

The roadmap is a one-shot seed. Once every entry is an issue, the issues are
the plan and this file is removed (it stays in git history, so the script only
applies a committed, unmodified file). Membership, ordering and milestones are
GitHub's native fields (sub-issue parent, blocked-by, milestone), never body
prose.

    scripts/roadmap-sync.py --validate        # parse and validate, no GitHub calls
    scripts/roadmap-sync.py                   # validate and show the plan (dry run)
    scripts/roadmap-sync.py --apply           # create, link, set ready, delete the file
    scripts/roadmap-sync.py --apply --yes     # no confirmation prompt
    scripts/roadmap-sync.py --apply --keep    # do not delete the file afterwards
    scripts/roadmap-sync.py --apply M3.4 M5   # only these entries (an epic brings its
                                              # subtree, every entry its ancestors)

Format: a ```milestones block maps milestone keys to titles. Each entry is a
Markdown heading followed by an ```epic block (an entry with children, at any
depth) or a ```meta block (a leaf), then bold-labelled fields. `parent:` and
`depends: [..]` are the only relations; a top-level epic names its
`milestone:` and every descendant inherits it.

Cascading: the tracker contract (.claude/trackers/README.md) assumes two
levels, so deeper trees follow three rules enforced here: an entry with
children is an epic and is never dispatched; a parent's children are all
leaves or all epics; and nothing depends on an epic that has epic children,
because epic-status.sh never rolls such an epic up.

Re-running is safe: every issue carries a `<!-- roadmap:ID -->` marker, so an
interrupted run resumes where it stopped and never duplicates.

GitHub calls go through .claude/scripts/gh-rest.sh and issue-status.sh, with
two exceptions:
- Creating a milestone is a direct `gh api` POST, because gh-rest.sh has no
  milestone subcommand. It is scoped to workflow.json's repo explicitly.
- The `maintainer-only` label is never applied: gh-rest.sh refuses it by
  design, since only the maintainer applies it. Those issues are filed
  without it, left at status:new, and the script prints the command for the
  maintainer to add the label.

Exit codes: 0 ok, 1 validation failed, 2 a GitHub call failed.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / ".claude" / "scripts"
GH_REST = SCRIPTS / "gh-rest.sh"
ISSUE_STATUS = SCRIPTS / "issue-status.sh"
WORKFLOW = json.loads((ROOT / ".claude" / "workflow.json").read_text())
REPO = WORKFLOW["repo"]
DEFAULT_ROADMAP = ROOT / "docs" / "roadmap.md"

TYPES = {"feat", "bug", "chore", "docs", "spike"}
LABELS_CFG = WORKFLOW.get("labels", {})
AREAS = {a["name"] for a in LABELS_CFG.get("areas", [])}
RISK = (LABELS_CFG.get("risk") or {}).get("name")
MAINTAINER = (LABELS_CFG.get("maintainerOnly") or {}).get("name")
EXTRA = {x["name"] for x in LABELS_CFG.get("extra", [])}
# Labels only the maintainer applies; gh-rest.sh refuses to add them.
MAINTAINER_APPLIED = {n for n in [MAINTAINER] if n} | {
    x["name"] for x in LABELS_CFG.get("extra", []) if x.get("maintainerApplied")
}
BASE_EXTRAS = {"blocked", "security", "regression", "dependencies"}
KNOWN = TYPES | AREAS | EXTRA | BASE_EXTRAS | {n for n in (RISK, MAINTAINER) if n}
RISK_PATHS = WORKFLOW.get("riskPaths", [])
STALE = WORKFLOW.get("readiness", {}).get("stale", [])
REQUIRE_REACHABLE = WORKFLOW.get("readiness", {}).get("requireReachableVia") is not False
DEFAULT_EXEMPT = r"\bno\b|\bnot\b|never|retired|removed"  # as in issue-readiness.sh

LEAF_FIELDS = ("Summary", "Design references", "Current state", "Constraints",
               "Acceptance criteria", "Out of scope", "Scope hint")
EPIC_FIELDS = ("Done when", "Summary", "Design references", "Goal", "Product rules", "Out of scope")
FIELD_RE = re.compile(r"^\*\*(" + "|".join(sorted(set(LEAF_FIELDS + EPIC_FIELDS), key=len, reverse=True))
                      + r")\*\*[ \t]*(.*)$")
HEADING_RE = re.compile(r"^(#{2,6}) (.+)$")
PROSE_FORBIDDEN = [
    (re.compile(r"(?<![\w&])#\d+\b"), "an issue reference"),
    (re.compile(r"\b(part of|depends on|see (the )?roadmap)\b", re.I), "relation prose"),
    (re.compile(r"roadmap", re.I), "a reference to the roadmap"),
]


# --------------------------------------------------------------------------
# Model and parsing
# --------------------------------------------------------------------------


@dataclass
class Entry:
    kind: str  # "epic" | "leaf"
    ident: str
    title: str
    meta: dict[str, str]
    fields: dict[str, str]
    line: int
    children: list[str] = field(default_factory=list)

    def _list(self, key: str) -> list[str]:
        raw = self.meta.get(key, "").strip()
        return [x.strip() for x in raw.strip("[]").split(",") if x.strip()]

    @property
    def labels(self) -> list[str]:
        return self._list("labels")

    @property
    def depends(self) -> list[str]:
        return self._list("depends")

    @property
    def parent(self) -> str:
        return self.meta.get("parent", "").strip()


def parse(text: str) -> tuple[dict[str, str], list[Entry]]:
    lines = text.splitlines()
    pm = re.search(r"^```milestones\n(.*?)^```", text, re.S | re.M)
    if not pm:
        raise SystemExit("roadmap: no ```milestones block")
    milestones = dict(re.findall(r"^(\S+):[ \t]*(.+)$", pm.group(1), re.M))

    entries: list[Entry] = []
    in_fence = False
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("```"):
            in_fence = not in_fence
            i += 1
            continue
        m = HEADING_RE.match(ln)
        if in_fence or not m:
            i += 1
            continue
        heading_line, title = i + 1, m.group(2).strip()
        j = i + 1
        while j < len(lines) and not lines[j].strip():
            j += 1
        block_kind = lines[j].strip() if j < len(lines) else ""
        if block_kind not in ("```epic", "```meta"):
            i += 1  # a heading in the preamble, not an entry
            continue
        j += 1
        block: list[str] = []
        while j < len(lines) and lines[j].strip() != "```":
            block.append(lines[j])
            j += 1
        j += 1
        meta = dict(re.findall(r"^(\w+):[ \t]*(.*)$", "\n".join(block), re.M))

        prose: list[str] = []
        fence = False
        while j < len(lines):
            nxt = lines[j]
            if nxt.startswith("```"):
                fence = not fence
            elif not fence and HEADING_RE.match(nxt):
                break
            prose.append(nxt)
            j += 1
        fields: dict[str, list[str]] = {}
        cur: str | None = None
        for p in prose:
            fm = FIELD_RE.match(p)
            if fm:
                cur = fm.group(1)
                fields[cur] = [fm.group(2)] if fm.group(2) else []
            elif cur:
                fields[cur].append(p)
        ident = meta.get("id", "").strip()
        if not ident:
            raise SystemExit(f"roadmap:{heading_line}: '{title}' has no `id:`")
        kind = "epic" if block_kind == "```epic" else "leaf"
        entries.append(Entry(kind, ident, title, meta,
                             {k: "\n".join(v).strip() for k, v in fields.items()}, heading_line))
        i = j
    if not entries:
        raise SystemExit("roadmap: no entries found")
    by_id = {e.ident: e for e in entries}
    for e in entries:
        if e.parent in by_id:
            by_id[e.parent].children.append(e.ident)
    return milestones, entries


def ancestors(e: Entry, by_id: dict[str, Entry]) -> list[Entry]:
    out: list[Entry] = []
    seen: set[str] = set()
    while e.parent and e.parent in by_id and e.parent not in seen:
        seen.add(e.parent)
        e = by_id[e.parent]
        out.append(e)
    return out


def top_of(e: Entry, by_id: dict[str, Entry]) -> Entry:
    chain = ancestors(e, by_id)
    return chain[-1] if chain else e


def depth(e: Entry, by_id: dict[str, Entry]) -> int:
    return len(ancestors(e, by_id))


# --------------------------------------------------------------------------
# Rendering (the item shapes of .claude/skills/triage/templates/item-shapes.md)
# --------------------------------------------------------------------------


def marker(ident: str) -> str:
    return f"<!-- roadmap:{ident} -->"


def render_body(e: Entry) -> str:
    f = e.fields
    out: list[str] = []

    def section(name: str, text: str) -> None:
        out.extend([f"## {name}", "", text, ""])

    if e.kind == "epic":
        done = f.get("Done when", "")
        section("Original report", ("Done when (SPEC §11):\n\n> " + done) if done else f.get("Summary", ""))
        section("Summary", f.get("Summary", ""))
        section("Design references", f.get("Design references") or "none")
        section("Goal", f.get("Goal") or done)
        if f.get("Product rules"):
            section("Product rules", f["Product rules"])
        section("Out of scope", f.get("Out of scope") or "none")
    else:
        section("Original report", f.get("Summary", ""))
        section("Summary", f.get("Summary", ""))
        section("Design references", f.get("Design references") or "none")
        section("Current state", f.get("Current state") or "nothing yet")
        if f.get("Constraints"):
            section("Constraints", f["Constraints"])
        section("Acceptance criteria", f.get("Acceptance criteria", ""))
        if f.get("Out of scope"):
            section("Out of scope", f["Out of scope"])
        section("Scope hint", f.get("Scope hint", ""))
    out.append(marker(e.ident))
    return "\n".join(out).strip() + "\n"


def prose_of(e: Entry, milestones: dict[str, str]) -> str:
    # A top-level epic's title is its milestone's name, not a reference.
    own_ms = milestones.get(e.meta.get("milestone", "").strip())
    title = "" if e.title == own_ms else e.title
    return "\n".join([title, *e.fields.values()])


# --------------------------------------------------------------------------
# Validation (mirrors .claude/scripts/issue-readiness.sh, plus the seed rules)
# --------------------------------------------------------------------------


def risk_path_hit(path: str) -> bool:
    """A Scope hint path touches a riskPaths glob when it matches it, or when it
    is the direct parent of the glob's literal prefix (`apps/server/src/db/` holds
    `apps/server/src/db/schema/**`; a package root like `apps/server/` does not count)."""
    is_dir = path.endswith("/")
    path = path.rstrip("/")
    for glob in RISK_PATHS:
        pat = glob.replace("**/", "*").replace("/**", "*").replace("**", "*")
        if fnmatch.fnmatch(path, pat) or fnmatch.fnmatch(path + "/", pat):
            return True
        literal = re.split(r"[*?\[]", glob, maxsplit=1)[0]
        rest = literal[len(path) + 1:].strip("/") if literal.startswith(path + "/") else None
        if is_dir and rest is not None and "/" not in rest:  # the direct parent only
            return True
    return False


def readiness_problems(e: Entry, body: str) -> list[str]:
    """What issue-readiness.sh would report for the rendered body."""
    problems: list[str] = []
    labels = set(e.labels)
    if e.kind == "epic":
        return problems  # issue-readiness.sh passes every epic
    sec = lambda name: re.search(rf"^##\s+{name}", body, re.M)  # noqa: E731
    if not sec("Original report"):
        problems.append("no '## Original report'")
    if not sec("Acceptance criteria"):
        problems.append("no '## Acceptance criteria'")
    if labels & {"feat", "bug", "chore"} and not sec("Out of scope"):
        problems.append("no '## Out of scope'")
    if REQUIRE_REACHABLE and "dependencies" not in labels and labels & {"feat", "bug"}:
        crit = re.search(r"^##\s+Acceptance criteria\n(.*?)(?=^##\s|\Z)", body, re.M | re.S)
        if not crit or not re.search(r"Reachable via", crit.group(1), re.I):
            problems.append("no 'Reachable via:' criterion")
    for rule in STALE:
        exempt = rule.get("exempt") or DEFAULT_EXEMPT
        for ln in body.splitlines():
            if re.search(rule["pattern"], ln, re.I) and not re.search(exempt, ln, re.I):
                problems.append(f"stale: {rule['reason']}")
                break
    return problems


def repo_links_to_roadmap(roadmap: Path) -> list[str]:
    """Repo files (tracked or untracked, not ignored) that name the roadmap file,
    which is deleted after the sync."""
    try:
        rel = str(roadmap.resolve().relative_to(ROOT))
    except ValueError:
        return []
    proc = subprocess.run(["git", "grep", "-l", "-I", "--untracked", "-F", Path(rel).name], capture_output=True, text=True, cwd=ROOT)
    me = str(Path(__file__).resolve().relative_to(ROOT))
    return [f for f in proc.stdout.splitlines() if f not in (rel, me)]


def validate(milestones: dict[str, str], entries: list[Entry], roadmap: Path) -> list[str]:
    problems: list[str] = []
    by_id: dict[str, Entry] = {}
    titles: dict[str, str] = {}
    for e in entries:
        if e.ident in by_id:
            problems.append(f"{e.ident}: duplicate id")
        by_id[e.ident] = e
        if e.title in titles:
            problems.append(f"{e.ident}: title duplicates {titles[e.title]}")
        titles[e.title] = e.ident
    ids = set(by_id)
    top_ids = {e.ident for e in entries if not e.parent}

    for e in entries:
        p = f"{e.ident}"
        # Tree shape
        if e.parent:
            if e.parent not in by_id:
                problems.append(f"{p}: parent '{e.parent}' does not exist")
            elif not e.ident.startswith(e.parent + "."):
                problems.append(f"{p}: a child's id is `{e.parent}.<n>`")
            if "milestone" in e.meta:
                problems.append(f"{p}: only a top-level epic names `milestone:`; children inherit it")
        else:
            if e.kind != "epic":
                problems.append(f"{p}: a leaf needs a `parent:`")
            if e.meta.get("milestone", "").strip() not in milestones:
                problems.append(f"{p}: milestone '{e.meta.get('milestone', '')}' is not in the ```milestones block")
        if e.kind == "epic" and not e.children:
            problems.append(f"{p}: an ```epic block needs children (use ```meta for a leaf)")
        if e.kind == "leaf" and e.children:
            problems.append(f"{p}: has children, so it must be an ```epic block")
        kinds = {by_id[c].kind for c in e.children}
        if len(kinds) > 1:
            problems.append(f"{p}: children must be all leaves or all epics, not mixed")

        # Labels
        for lab in e.labels:
            if lab.startswith("status:"):
                problems.append(f"{p}: `{lab}` is machine-managed and never declared here")
            elif lab == "epic":
                problems.append(f"{p}: `epic` is added by the script from the block type")
            elif lab not in KNOWN:
                problems.append(f"{p}: label '{lab}' is not in .claude/workflow.json or the base set")
        types = [lab for lab in e.labels if lab in TYPES]
        if e.kind == "leaf" and len(types) != 1:
            problems.append(f"{p}: needs exactly one type label, has {types or 'none'}")
        if e.kind == "epic" and types:
            problems.append(f"{p}: an epic carries no type label")
        if not [lab for lab in e.labels if lab in AREAS]:
            problems.append(f"{p}: needs at least one area:* label")

        # Dependencies
        for dep in e.depends:
            if dep == e.ident:
                problems.append(f"{p}: depends on itself")
            elif dep not in by_id:
                problems.append(f"{p}: depends on unknown id '{dep}'")
            elif any(by_id[c].kind == "epic" for c in by_id[dep].children):
                problems.append(f"{p}: depends on '{dep}', an epic with epic children that is never rolled up")
            elif dep in {a.ident for a in ancestors(e, by_id)}:
                problems.append(f"{p}: depends on its own ancestor '{dep}'")

        # Fields and shape
        f = e.fields
        if len(e.title) > 80:
            problems.append(f"{p}: title is {len(e.title)} characters (max 80)")
        if e.title.endswith("."):
            problems.append(f"{p}: title ends with a period")
        if e.kind == "epic":
            for req in ("Summary", "Design references", "Goal", "Out of scope"):
                if not f.get(req):
                    problems.append(f"{p}: epic needs **{req}**")
            if not e.parent and not f.get("Done when"):
                problems.append(f"{p}: a top-level epic quotes its milestone's **Done when**")
        else:
            for req in ("Summary", "Design references", "Current state", "Acceptance criteria", "Scope hint"):
                if not f.get(req):
                    problems.append(f"{p}: needs **{req}**")
            if set(e.labels) & {"feat", "bug", "chore"} and not f.get("Out of scope"):
                problems.append(f"{p}: needs **Out of scope** (write `none` if nothing)")
            crit = [ln for ln in f.get("Acceptance criteria", "").splitlines() if ln.startswith("- [ ]")]
            if not crit:
                problems.append(f"{p}: **Acceptance criteria** must be a `- [ ]` checklist")
            elif not re.search(r"checks of workflow\.json", crit[-1]):
                problems.append(f"{p}: the last criterion is 'the checks of workflow.json for the touched paths pass'")
            if not re.search(r"Expected files: \d+", f.get("Scope hint", "")):
                problems.append(f"{p}: **Scope hint** needs '~<N> changed lines' and 'Expected files: <N>'")
            scope_paths = re.findall(r"`([^`\s]+/[^`\s]*|[^`\s/]+\.[a-z]+)`", f.get("Scope hint", ""))
            if RISK and any(risk_path_hit(sp) for sp in scope_paths) and RISK not in e.labels:
                problems.append(f"{p}: its Scope hint touches a riskPaths path, so it needs `{RISK}`")
        for owner in re.findall(r'owned by "([^"]+)"', f.get("Out of scope", "")):
            if owner not in titles:
                problems.append(f"{p}: Out of scope names '{owner}', which is no entry's title")

        # Prose: no relations, issue refs or entry ids outside metadata
        text = prose_of(e, milestones)
        for rx, what in PROSE_FORBIDDEN:
            m = rx.search(text)
            if m:
                problems.append(f"{p}: prose contains {what}: '{m.group(0)}'")
        for other in ids:
            for m in re.finditer(rf"(?<![\w.-]){re.escape(other)}(?![\w-]|\.\d)", text):
                allowed = other in top_ids and text[:m.start()].endswith("SPEC §11 ")
                if not allowed:
                    hint = f"write 'SPEC §11 {other}'" if other in top_ids else "name an entry by its title"
                    problems.append(f"{p}: prose names entry id '{other}' ({hint})")
                    break

        for r in readiness_problems(e, render_body(e)):
            problems.append(f"{p}: issue-readiness: {r}")

    # Dependency cycles
    state: dict[str, int] = {}

    def visit(node: str, stack: list[str]) -> None:
        if state.get(node) == 1:
            problems.append("dependency cycle: " + " -> ".join(stack + [node]))
            return
        if state.get(node) == 2:
            return
        state[node] = 1
        for dep in by_id[node].depends:
            if dep in by_id:
                visit(dep, stack + [node])
        state[node] = 2

    for e in entries:
        visit(e.ident, [])
    # Parent cycles
    for e in entries:
        seen = {e.ident}
        cur = e
        while cur.parent in by_id:
            if cur.parent in seen:
                problems.append(f"{e.ident}: parent chain loops")
                break
            seen.add(cur.parent)
            cur = by_id[cur.parent]

    for f_ in repo_links_to_roadmap(roadmap):
        problems.append(f"{f_}: names {roadmap.name}, which is deleted after the sync")
    return problems


# --------------------------------------------------------------------------
# GitHub plumbing: gh-rest.sh and issue-status.sh, retried on rate limits
# --------------------------------------------------------------------------


class GhError(RuntimeError):
    pass


# A 403 is retried only when GitHub says it is a rate or abuse limit; any other
# 403 (missing scope, no access) is permanent and fails at once.
RETRYABLE = re.compile(r"rate limit|secondary|abuse|HTTP 429|HTTP 5\d\d|timeout|connection", re.I)


def run(args: list[str], what: str) -> str:
    for attempt in range(10):
        proc = subprocess.run(args, capture_output=True, text=True, cwd=ROOT)
        if proc.returncode == 0:
            return proc.stdout
        err = (proc.stderr + proc.stdout).strip()
        if RETRYABLE.search(err) and attempt < 9:
            wait = min(30 * 2 ** attempt, 600)
            print(f"  {what}: GitHub asked us to slow down; waiting {wait}s (attempt {attempt + 1})", flush=True)
            time.sleep(wait)
            continue
        raise GhError(f"{what}\n{err}")
    raise GhError(f"{what}: gave up after retries")


def gh_rest(*args: str) -> object:
    out = run([str(GH_REST), *args], f"gh-rest.sh {args[0]}")
    return json.loads(out) if out.strip() else None


def create_milestone(title: str) -> None:
    # The one direct call: gh-rest.sh has no milestone subcommand.
    run(["gh", "api", "--method", "POST", f"repos/{REPO}/milestones", "-f", f"title={title}"],
        f"create milestone '{title}'")


def set_status(n: int, status: str) -> None:
    run([str(ISSUE_STATUS), str(n), status], f"issue-status.sh {n} {status}")


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("ids", nargs="*", help="only these entries (an epic brings its subtree, any entry its ancestors)")
    ap.add_argument("--roadmap", type=Path, default=DEFAULT_ROADMAP)
    ap.add_argument("--validate", action="store_true", help="parse and validate only; no GitHub calls")
    ap.add_argument("--apply", action="store_true", help="write to GitHub")
    ap.add_argument("--yes", action="store_true", help="no confirmation prompt")
    ap.add_argument("--keep", action="store_true", help="do not delete the roadmap after a full apply")
    args = ap.parse_args()

    milestones, entries = parse(args.roadmap.read_text())
    by_id = {e.ident: e for e in entries}
    problems = validate(milestones, entries, args.roadmap)
    problems += [f"unknown id on the command line: {i}" for i in args.ids if i not in by_id]
    if problems:
        print("Validation failed:\n")
        for p in problems:
            print(f"  ✗ {p}")
        return 1
    n_epics = sum(e.kind == "epic" for e in entries)
    print(f"Parsed {len(milestones)} milestones, {n_epics} epics, {len(entries) - n_epics} leaves — valid.")
    if args.validate:
        return 0

    # Selection: named entries, their subtrees, and their ancestors.
    full_run = not args.ids
    wanted: set[str] = set()
    for ident in args.ids or [e.ident for e in entries]:
        stack = [ident]
        while stack:
            cur = stack.pop()
            wanted.add(cur)
            stack.extend(by_id[cur].children)
        wanted |= {a.ident for a in ancestors(by_id[ident], by_id)}
    # Parents before children; document order within a level.
    selected = sorted((e for e in entries if e.ident in wanted), key=lambda e: (depth(e, by_id), e.line))
    milestone_of = {e.ident: milestones[top_of(e, by_id).meta["milestone"].strip()] for e in entries}

    def create_labels(e: Entry) -> list[str]:
        labs = set(e.labels) - MAINTAINER_APPLIED
        if e.kind == "epic":
            labs.add("epic")
        return sorted(labs)

    def wants_ready(e: Entry) -> bool:
        return e.kind == "leaf" and not (set(e.labels) & MAINTAINER_APPLIED)

    try:
        gh_rest("repo-view", "--jq", "{full_name}")
        existing: dict[str, dict] = {}
        for issue in gh_rest("issue-list", "--state", "all") or []:  # type: ignore[union-attr]
            m = re.search(r"<!-- roadmap:(\S+) -->", issue.get("body") or "")
            if m:
                existing[m.group(1)] = issue
        have_labels = {lab["name"] for lab in gh_rest("label-list") or []}  # type: ignore[union-attr]
        need_labels = {lab for e in selected for lab in create_labels(e)}
        missing_labels = sorted(need_labels - have_labels)
        have_ms = {m["title"] for m in gh_rest("paged", "milestones?state=all") or []}  # type: ignore[union-attr]
        missing_ms = sorted({milestone_of[e.ident] for e in selected} - have_ms)
        todo = [e for e in selected if e.ident not in existing]

        if not args.apply:
            print(f"Target repo: {REPO}\nDRY RUN — nothing will be created. Re-run with --apply.\n")
            if missing_labels:
                print(f"Labels missing (run .claude/scripts/bootstrap-labels.sh): {', '.join(missing_labels)}")
            if missing_ms:
                print(f"Milestones to create: {', '.join(missing_ms)}")
            held = [e.ident for e in selected if set(e.labels) & MAINTAINER_APPLIED]
            if held:
                print(f"Filed without their maintainer-applied label, for you to add right after --apply: {', '.join(held)}")
            print(f"\nIssues to create: {len(todo)} · already filed: {len([e for e in selected if e.ident in existing])}\n")
            for e in sorted(selected, key=lambda e: e.line):
                d = depth(e, by_id)
                tag = "[epic]" if e.kind == "epic" else ("[maint]" if not wants_ready(e) else "[ready]")
                flags = f" [{RISK}]" if RISK and RISK in e.labels else ""
                deps = f"  ← {', '.join(e.depends)}" if e.depends else ""
                filed = f"  (#{existing[e.ident]['number']})" if e.ident in existing else ""
                ms = f"   ({milestone_of[e.ident]})" if d == 0 else ""
                print(f"{'    ' * d}{tag:<7} {e.ident:<8} {e.title}{flags}{deps}{filed}{ms}")
            return 0

        if missing_labels:
            print(f"Labels missing: {', '.join(missing_labels)} — run .claude/scripts/bootstrap-labels.sh first.")
            return 1
        if full_run and not args.keep:
            try:
                rel = str(args.roadmap.resolve().relative_to(ROOT))
            except ValueError:
                print(f"{args.roadmap} is outside the repository; pass --keep.")
                return 1
            dirty = subprocess.run(["git", "status", "--porcelain", "--", rel],
                                   capture_output=True, text=True, cwd=ROOT).stdout.strip()
            tracked = subprocess.run(["git", "ls-files", "--error-unmatch", rel],
                                     capture_output=True, cwd=ROOT).returncode == 0
            if dirty or not tracked:
                print(f"{rel} must be committed and unmodified before --apply, because the script deletes it afterwards.")
                return 1
        if todo and not args.yes:
            print(f"About to create {len(todo)} issues and {len(missing_ms)} milestones in {REPO} — visible, hard-to-undo work.")
            if input("Type 'yes' to continue: ").strip().lower() != "yes":
                print("Aborted — nothing created.")
                return 0

        for title in missing_ms:
            create_milestone(title)
            print(f"  milestone  {title}")

        # 1. Issues, parents before children.
        with tempfile.TemporaryDirectory() as tmp:
            for e in selected:
                if e.ident in existing:
                    continue
                body = Path(tmp) / f"{e.ident}.md"
                body.write_text(render_body(e))
                cmd = ["issue-create", "--title", e.title, "--body-file", str(body),
                       "--milestone", milestone_of[e.ident]]
                for lab in create_labels(e):
                    cmd += ["--label", lab]
                issue = gh_rest(*cmd)
                existing[e.ident] = issue  # type: ignore[assignment]
                print(f"  {'epic' if e.kind == 'epic' else 'leaf'} #{issue['number']:<5} {e.ident:<8} {e.title}")  # type: ignore[index]
                time.sleep(1.0)

        num = {i: existing[i]["number"] for i in wanted}

        # 2. Sub-issue links, parents before children. A pass over everything
        #    selected, so a re-run heals gaps; a different existing parent is
        #    reported, never silently moved.
        linked = 0
        conflicts: list[str] = []
        for e in selected:
            if not e.parent:
                continue
            want = num[e.parent]
            cur = gh_rest("parent", str(num[e.ident]))
            if cur and cur.get("number") == want:  # type: ignore[union-attr]
                continue
            if cur:
                conflicts.append(f"{e.ident}: #{num[e.ident]} already has parent #{cur.get('number')}, want #{want}")  # type: ignore[union-attr]
                continue
            gh_rest("add-sub-issue", str(want), str(num[e.ident]))
            linked += 1
            time.sleep(0.5)

        # 3. Blocked-by links.
        for e in selected:
            deps = [d for d in e.depends if d in existing]
            if not deps:
                continue
            have = {d["number"] for d in gh_rest("blocked-by", str(num[e.ident])) or []}  # type: ignore[union-attr]
            for dep in deps:
                if existing[dep]["number"] not in have:
                    gh_rest("add-blocked-by", str(num[e.ident]), str(existing[dep]["number"]))
                    linked += 1
                    time.sleep(0.5)

        # 4. Verify the wiring before anything is marked ready.
        after: list[str] = list(conflicts)
        for e in selected:
            n = num[e.ident]
            if e.parent:
                cur = gh_rest("parent", str(n))
                if not cur or cur.get("number") != num[e.parent]:  # type: ignore[union-attr]
                    after.append(f"{e.ident}: #{n} is not a sub-issue of #{num[e.parent]}")
            have = {d["number"] for d in gh_rest("blocked-by", str(n)) or []}  # type: ignore[union-attr]
            for dep in e.depends:
                if dep in existing and existing[dep]["number"] not in have:
                    after.append(f"{e.ident}: #{n} is not blocked by {dep} (#{existing[dep]['number']})")
                elif dep not in existing and full_run:
                    after.append(f"{e.ident}: dependency {dep} has no issue")
        if after:
            print("\nVerification failed — nothing set ready, the roadmap is kept:")
            for p_ in after:
                print(f"  ✗ {p_}")
            return 2

        # 5. Ready last, only on leaves still at status:new (a re-run never
        #    moves an item an agent has already picked up).
        readied = 0
        for e in selected:
            if not wants_ready(e):
                continue
            issue = gh_rest("issue-view", str(num[e.ident]))
            statuses = [lab["name"] for lab in issue["labels"] if lab["name"].startswith("status:")]  # type: ignore[index]
            if statuses in ([], ["status:new"]):
                set_status(num[e.ident], "ready")
                readied += 1
    except GhError as exc:
        print(f"\nStopped: {exc}\nRe-run to continue; filed issues are recognised by their roadmap marker.", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nInterrupted — re-run to continue.", file=sys.stderr)
        return 2

    print(f"\nDone: {len(todo)} issues created, {linked} relationships added, {readied} set ready.")
    held = [e for e in selected if set(e.labels) & MAINTAINER_APPLIED]
    if held:
        print("\n" + "!" * 78)
        print("ACTION NEEDED NOW: these issues are filed WITHOUT their maintainer-applied label.")
        print("Orchestrate pulls maintainer-only work out by that label alone, so until you add it,")
        print("orchestrating their epic would dispatch an agent to them. Run each line:")
        print("!" * 78)
        for e in held:
            for lab in sorted(set(e.labels) & MAINTAINER_APPLIED):
                print(f"  ! gh api --method POST repos/{REPO}/issues/{num[e.ident]}/labels -f 'labels[]={lab}'   # {e.ident} {e.title}")
    if full_run and not args.keep:
        args.roadmap.unlink()
        print(f"\nDeleted {args.roadmap.relative_to(ROOT)} (the issues are the plan now; it is in git history). Commit the deletion.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
