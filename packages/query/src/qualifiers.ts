import { QuerySyntaxError, type Token } from "./lexer.js";
import {
  HAS_VALUES,
  IS_VALUES,
  NO_VALUES,
  type IssueRef,
  type Node,
  type QueryWarning,
  type RepoRef,
  type Span,
} from "./types.js";

type QualifierToken = Extract<Token, { kind: "qualifier" }>;
type Element = QualifierToken["values"][number];

const REPO_PATTERN = /^([^\s/#]+)\/([^\s/#]+)$/;
const ISSUE_REF_PATTERN = /^([^\s/#]+)\/([^\s/#]+)#([1-9][0-9]*)$/;

const STRING_QUALIFIERS = [
  "label",
  "assignee",
  "author",
  "org",
  "user",
  "type",
  "milestone",
] as const;

function isOneOf<T extends string>(
  values: readonly T[],
  value: string,
): value is T {
  return (values as readonly string[]).includes(value);
}

function parseRepo(element: Element): RepoRef {
  const match = REPO_PATTERN.exec(element.value);
  if (!match) {
    throw new QuerySyntaxError(
      `Expected owner/name, got "${element.value}"`,
      element.start,
      element.end,
    );
  }
  return { owner: match[1] as string, name: match[2] as string };
}

function parseIssueRef(element: Element): IssueRef {
  const match = ISSUE_REF_PATTERN.exec(element.value);
  const number = Number(match?.[3]);
  if (!match || !Number.isSafeInteger(number)) {
    throw new QuerySyntaxError(
      `Expected owner/repo#N, got "${element.value}"`,
      element.start,
      element.end,
    );
  }
  return { owner: match[1] as string, repo: match[2] as string, number };
}

function ignored(span: Span): Node {
  return { type: "ignored", start: span.start, end: span.end };
}

function resolveEnum<T extends string>(
  token: QualifierToken,
  allowed: readonly T[],
  warnings: QueryWarning[],
  hint: (value: T) => string | undefined,
): T[] | undefined {
  const values: T[] = [];
  let known = true;
  for (const element of token.values) {
    const value = element.value.toLowerCase();
    if (!isOneOf(allowed, value)) {
      known = false;
      warnings.push({
        message: `Unknown value "${element.value}" for "${token.name}:"; it is ignored`,
        start: element.start,
        end: element.end,
      });
      continue;
    }
    const message = hint(value);
    if (message) {
      warnings.push({ message, start: element.start, end: element.end });
    }
    values.push(value);
  }
  return known ? values : undefined;
}

export function resolveQualifier(
  token: QualifierToken,
  warnings: QueryWarning[],
): Node {
  const { start, end, negated } = token;
  const base = { type: "qualifier", negated, start, end } as const;
  const name = token.name;
  if (name === "is") {
    const values = resolveEnum(token, IS_VALUES, warnings, (value) =>
      value === "closed"
        ? "Crossboard only syncs open issues"
        : value === "pr"
          ? "Pull requests are not shown"
          : undefined,
    );
    return values ? { ...base, name, values } : ignored(token);
  }
  if (name === "no") {
    const values = resolveEnum(token, NO_VALUES, warnings, () => undefined);
    return values ? { ...base, name, values } : ignored(token);
  }
  if (name === "has") {
    const values = resolveEnum(token, HAS_VALUES, warnings, () => undefined);
    return values ? { ...base, name, values } : ignored(token);
  }
  if (isOneOf(STRING_QUALIFIERS, name)) {
    return { ...base, name, values: token.values.map((e) => e.value) };
  }
  if (name === "repo") {
    return { ...base, name, values: token.values.map(parseRepo) };
  }
  if (name === "parent" || name === "blocked-by" || name === "blocking") {
    return { ...base, name, values: token.values.map(parseIssueRef) };
  }
  warnings.push({
    message: `Unknown qualifier "${name}"; it is ignored`,
    start,
    end,
  });
  return ignored(token);
}
