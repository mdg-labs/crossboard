import { parse } from "@crossboard/query";

/**
 * The qualifier a click on a label adds to the filter (SPEC FR-15), or `null`
 * for a name the filter language cannot express: it has no escape for `"`.
 */
export function labelQualifier(name: string): string | null {
  return name.includes('"') ? null : `label:"${name}"`;
}

export const assigneeQualifier = (login: string): string => `assignee:${login}`;

export const repoQualifier = (repo: { owner: string; name: string }): string =>
  `repo:${repo.owner}/${repo.name}`;

/**
 * `query` with `qualifier` added so that it narrows the whole filter, or
 * `null` when that cannot be done: the filter does not parse, or the
 * parentheses it needs would be more than the language allows (SPEC §4.3).
 * AND binds tighter than OR, so a filter with a top-level OR is wrapped in
 * parentheses first.
 */
export function appendQualifier(
  query: string,
  qualifier: string,
): string | null {
  const current = query.trim();
  if (current === "") {
    return qualifier;
  }
  if ("error" in parse(current)) {
    return null;
  }
  const plain = `${current} ${qualifier}`;
  const parsed = parse(plain);
  if ("error" in parsed) {
    return null;
  }
  // The qualifier joins the last branch of a top-level OR, so the root of the
  // result stays an OR exactly when the filter had one.
  if (parsed.ast.type !== "or") {
    return plain;
  }
  const wrapped = `(${current}) ${qualifier}`;
  return "error" in parse(wrapped) ? null : wrapped;
}
