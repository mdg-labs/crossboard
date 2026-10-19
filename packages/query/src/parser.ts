import { QuerySyntaxError, tokenize, type Token } from "./lexer.js";
import type { Node, ParseResult, Span } from "./types.js";

export const MAX_OPEN_PARENTHESES = 5;

type Operand = Exclude<Token, { kind: "rparen" | "and" | "or" }>;

function startsOperand(token: Token | undefined): token is Operand {
  return (
    token !== undefined &&
    (token.kind === "text" ||
      token.kind === "qualifier" ||
      token.kind === "lparen")
  );
}

function span(first: Span, last: Span): Span {
  return { start: first.start, end: last.end };
}

class Parser {
  private position = 0;
  private open = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    if (this.tokens.length === 0) {
      return { type: "and", children: [], start: 0, end: 0 };
    }
    this.requireOperand();
    const node = this.parseOr();
    const rest = this.peek();
    if (rest) {
      throw new QuerySyntaxError(
        "Unbalanced parenthesis",
        rest.start,
        rest.end,
      );
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private next(): Token {
    return this.tokens[this.position++] as Token;
  }

  private requireOperand(): void {
    const token = this.peek() as Token;
    if (startsOperand(token)) {
      return;
    }
    if (token.kind === "rparen") {
      throw new QuerySyntaxError(
        "Unbalanced parenthesis",
        token.start,
        token.end,
      );
    }
    throw this.dangling(token);
  }

  private dangling(token: Token): QuerySyntaxError {
    const word = token.kind === "and" ? "AND" : "OR";
    return new QuerySyntaxError(
      `${word} must be between two terms`,
      token.start,
      token.end,
    );
  }

  private parseOr(): Node {
    const children = [this.parseAnd()];
    while (this.peek()?.kind === "or") {
      const operator = this.next();
      if (!startsOperand(this.peek())) {
        throw this.dangling(operator);
      }
      children.push(this.parseAnd());
    }
    return this.combine("or", children);
  }

  private parseAnd(): Node {
    const children = [this.parseUnary()];
    for (;;) {
      const token = this.peek();
      if (token?.kind === "and") {
        this.next();
        if (!startsOperand(this.peek())) {
          throw this.dangling(token);
        }
        children.push(this.parseUnary());
      } else if (startsOperand(token)) {
        children.push(this.parseUnary());
      } else {
        return this.combine("and", children);
      }
    }
  }

  private combine(type: "and" | "or", children: Node[]): Node {
    const [only] = children;
    if (children.length === 1) {
      return only as Node;
    }
    return {
      type,
      children,
      ...span(only as Node, children[children.length - 1] as Node),
    };
  }

  private parseUnary(): Node {
    const token = this.next() as Operand;
    if (token.kind === "text") {
      return {
        type: "text",
        value: token.value,
        start: token.start,
        end: token.end,
      };
    }
    if (token.kind === "qualifier") {
      return {
        type: "qualifier",
        name: token.name,
        negated: token.negated,
        values: token.values.map((element) => element.value),
        start: token.start,
        end: token.end,
      };
    }
    return this.parseGroup(token);
  }

  private parseGroup(open: Span): Node {
    if (this.open === MAX_OPEN_PARENTHESES) {
      throw new QuerySyntaxError(
        `At most ${MAX_OPEN_PARENTHESES} parentheses may be open at once`,
        open.start,
        open.end,
      );
    }
    const first = this.peek();
    if (first?.kind === "rparen") {
      throw new QuerySyntaxError("Empty parentheses", open.start, first.end);
    }
    if (first === undefined) {
      throw new QuerySyntaxError(
        "Unbalanced parenthesis",
        open.start,
        open.end,
      );
    }
    this.requireOperand();
    this.open += 1;
    const inner = this.parseOr();
    this.open -= 1;
    if (this.peek()?.kind !== "rparen") {
      throw new QuerySyntaxError(
        "Unbalanced parenthesis",
        open.start,
        open.end,
      );
    }
    this.next();
    return inner;
  }
}

export function parse(query: string): ParseResult {
  try {
    const ast = new Parser(tokenize(query)).parse();
    return { ast, warnings: [] };
  } catch (error) {
    if (error instanceof QuerySyntaxError) {
      return { error: error.detail };
    }
    throw error;
  }
}
