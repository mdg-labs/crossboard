import type { QueryError, Span } from "./types.js";

export interface ValueElement extends Span {
  value: string;
}

export type Token =
  | (Span & { kind: "lparen" })
  | (Span & { kind: "rparen" })
  | (Span & { kind: "and" })
  | (Span & { kind: "or" })
  | (Span & { kind: "text"; value: string; quoted: boolean })
  | (Span & {
      kind: "qualifier";
      name: string;
      negated: boolean;
      values: ValueElement[];
    });

export class QuerySyntaxError extends Error {
  readonly detail: QueryError;

  constructor(message: string, start: number, end: number) {
    super(message);
    this.detail = { message, start, end };
  }
}

const QUALIFIER_HEAD = /^(-?)([A-Za-z][A-Za-z0-9-]*):/;

function isSpace(char: string): boolean {
  return /\s/.test(char);
}

function readValues(
  query: string,
  termStart: number,
  valueStart: number,
  wordEnd: number,
): ValueElement[] {
  const elements: ValueElement[] = [];
  let elementStart = valueStart;
  let text = "";
  let i = valueStart;
  for (;;) {
    if (i === wordEnd || query[i] === ",") {
      if (text === "") {
        if (elementStart === valueStart && i === wordEnd) {
          throw new QuerySyntaxError(
            "Empty qualifier value",
            termStart,
            wordEnd,
          );
        }
        const comma = i === wordEnd ? i - 1 : i;
        throw new QuerySyntaxError("Empty list element", comma, comma + 1);
      }
      elements.push({ value: text, start: elementStart, end: i });
      if (i === wordEnd) {
        return elements;
      }
      i += 1;
      elementStart = i;
      text = "";
    } else if (query[i] === '"') {
      const close = query.indexOf('"', i + 1);
      text += query.slice(i + 1, close);
      i = close + 1;
    } else {
      text += query[i];
      i += 1;
    }
  }
}

function wordEndFrom(query: string, start: number): number {
  let i = start;
  while (i < query.length) {
    const char = query[i] as string;
    if (isSpace(char) || char === "(" || char === ")") {
      break;
    }
    if (char === '"') {
      const close = query.indexOf('"', i + 1);
      if (close === -1) {
        throw new QuerySyntaxError("Unbalanced quote", i, query.length);
      }
      i = close + 1;
    } else {
      i += 1;
    }
  }
  return i;
}

function readWord(query: string, start: number, end: number): Token {
  const raw = query.slice(start, end);
  if (raw === "AND") {
    return { kind: "and", start, end };
  }
  if (raw === "OR") {
    return { kind: "or", start, end };
  }
  const head = QUALIFIER_HEAD.exec(raw);
  if (head) {
    return {
      kind: "qualifier",
      name: (head[2] as string).toLowerCase(),
      negated: head[1] === "-",
      values: readValues(query, start, start + head[0].length, end),
      start,
      end,
    };
  }
  if (raw.startsWith("-")) {
    throw new QuerySyntaxError(
      "Only a qualifier can be negated with -",
      start,
      end,
    );
  }
  return {
    kind: "text",
    value: raw.replaceAll('"', ""),
    quoted: raw.includes('"'),
    start,
    end,
  };
}

export function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < query.length) {
    const char = query[i] as string;
    if (isSpace(char)) {
      i += 1;
    } else if (char === "(") {
      tokens.push({ kind: "lparen", start: i, end: i + 1 });
      i += 1;
    } else if (char === ")") {
      tokens.push({ kind: "rparen", start: i, end: i + 1 });
      i += 1;
    } else {
      const end = wordEndFrom(query, i);
      tokens.push(readWord(query, i, end));
      i = end;
    }
  }
  return tokens;
}
