import { parse, type Node } from "@crossboard/query";
import { appendQualifier } from "@/components/filter-bar/qualifiers";

interface RepoTerm {
  start: number;
  end: number;
  repos: string[];
}

/**
 * The one `repo:` term the picker manages (SPEC FR-34, D-21): the first
 * non-negated `repo:` qualifier that is the whole filter or a direct operand
 * of its top-level AND. `null` when there is none, `"invalid"` when the filter
 * does not parse.
 */
function topLevelRepoTerm(q: string): RepoTerm | null | "invalid" {
  const parsed = parse(q);
  if ("error" in parsed) {
    return "invalid";
  }
  const operands: Node[] =
    parsed.ast.type === "and" ? parsed.ast.children : [parsed.ast];
  for (const node of operands) {
    if (node.type === "qualifier" && node.name === "repo" && !node.negated) {
      return {
        start: node.start,
        end: node.end,
        repos: node.values.map((repo) => `${repo.owner}/${repo.name}`),
      };
    }
  }
  return null;
}

/** The repos the filter's top-level `repo:` term names, as `owner/name`. */
export function pickedRepos(q: string): string[] {
  const term = topLevelRepoTerm(q);
  return term === null || term === "invalid" ? [] : term.repos;
}

/** Whether the picker can edit this filter: it parses. */
export const canPickRepos = (q: string): boolean =>
  q.trim() === "" || topLevelRepoTerm(q) !== "invalid";

/**
 * `q` with its top-level `repo:` term set to `repos` (`repo:o/a,o/b`), added
 * when there is none and removed when `repos` is empty. `null` when the
 * result would not be a valid filter, which leaves `q` as it is.
 */
export function withPickedRepos(q: string, repos: string[]): string | null {
  const filter = q.trim();
  const term = filter === "" ? null : topLevelRepoTerm(filter);
  if (term === "invalid") {
    return null;
  }
  const qualifier = `repo:${repos.join(",")}`;
  if (term === null) {
    return repos.length === 0 ? filter : appendQualifier(filter, qualifier);
  }
  let before = filter.slice(0, term.start);
  let after = filter.slice(term.end);
  if (repos.length > 0) {
    before += qualifier;
  } else {
    // The term's span excludes parentheses around it; dropping the term
    // must not leave them empty.
    while (/\(\s*$/.test(before) && /^\s*\)/.test(after)) {
      before = before.replace(/\(\s*$/, "");
      after = after.replace(/^\s*\)/, "");
    }
    if (/^\s*AND(\s|$)/.test(after)) {
      // Dropping the term must not leave its AND without a left operand.
      after = after.replace(/^\s*AND\s*/, "");
    } else {
      before = before.replace(/\s*AND\s*$/, "");
    }
  }
  const head = before.trimEnd();
  const tail = after.trimStart();
  const joined =
    head === "" || tail === "" || head.endsWith("(") || tail.startsWith(")")
      ? ""
      : " ";
  const result = `${head}${joined}${tail}`;
  return result === "" || !("error" in parse(result)) ? result : null;
}
