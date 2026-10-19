export interface Span {
  start: number;
  end: number;
}

export interface QueryError extends Span {
  message: string;
}

export interface QueryWarning extends Span {
  message: string;
}

export interface AndNode extends Span {
  type: "and";
  children: Node[];
}

export interface OrNode extends Span {
  type: "or";
  children: Node[];
}

export interface TextNode extends Span {
  type: "text";
  value: string;
}

export const IS_VALUES = [
  "open",
  "closed",
  "issue",
  "pr",
  "blocked",
  "blocking",
] as const;
export const NO_VALUES = [
  "label",
  "assignee",
  "milestone",
  "type",
  "parent",
] as const;
export const HAS_VALUES = ["sub-issues", "parent", "dependencies"] as const;

export type IsValue = (typeof IS_VALUES)[number];
export type NoValue = (typeof NO_VALUES)[number];
export type HasValue = (typeof HAS_VALUES)[number];

export interface RepoRef {
  owner: string;
  name: string;
}

export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

interface QualifierBase extends Span {
  type: "qualifier";
  negated: boolean;
}

export interface IsQualifier extends QualifierBase {
  name: "is";
  values: IsValue[];
}

export interface NoQualifier extends QualifierBase {
  name: "no";
  values: NoValue[];
}

export interface HasQualifier extends QualifierBase {
  name: "has";
  values: HasValue[];
}

export interface StringQualifier extends QualifierBase {
  name: "label" | "assignee" | "author" | "org" | "user" | "type" | "milestone";
  values: string[];
}

export interface RepoQualifier extends QualifierBase {
  name: "repo";
  values: RepoRef[];
}

export interface IssueRefQualifier extends QualifierBase {
  name: "parent" | "blocked-by" | "blocking";
  values: IssueRef[];
}

export type QualifierNode =
  | IsQualifier
  | NoQualifier
  | HasQualifier
  | StringQualifier
  | RepoQualifier
  | IssueRefQualifier;

export interface NumberNode extends Span {
  type: "number";
  number: number;
}

export interface IgnoredNode extends Span {
  type: "ignored";
}

export type Node =
  AndNode | OrNode | TextNode | NumberNode | IgnoredNode | QualifierNode;

export type ParseResult =
  { ast: Node; warnings: QueryWarning[] } | { error: QueryError };
