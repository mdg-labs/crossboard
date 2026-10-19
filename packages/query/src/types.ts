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

export interface QualifierNode extends Span {
  type: "qualifier";
  name: string;
  negated: boolean;
  values: string[];
}

export type Node = AndNode | OrNode | TextNode | QualifierNode;

export type ParseResult =
  { ast: Node; warnings: QueryWarning[] } | { error: QueryError };
