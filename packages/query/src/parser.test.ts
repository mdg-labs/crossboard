import { describe, expect, it } from "vitest";
import { parse, type Node, type QueryError } from "./index.js";

type Shape =
  | { and: Shape[] }
  | { or: Shape[] }
  | { text: string }
  | { q: string; values: unknown[]; negated?: true }
  | { number: number }
  | { ignored: true };

function shape(node: Node): Shape {
  switch (node.type) {
    case "and":
      return { and: node.children.map(shape) };
    case "or":
      return { or: node.children.map(shape) };
    case "text":
      return { text: node.value };
    case "number":
      return { number: node.number };
    case "ignored":
      return { ignored: true };
    case "qualifier":
      return node.negated
        ? { q: node.name, values: node.values, negated: true }
        : { q: node.name, values: node.values };
  }
}

function ast(query: string): Shape {
  const result = parse(query);
  if ("error" in result) {
    throw new Error(`unexpected error: ${JSON.stringify(result.error)}`);
  }
  return shape(result.ast);
}

function error(query: string): QueryError {
  const result = parse(query);
  if (!("error" in result)) {
    throw new Error(`expected a syntax error for ${query}`);
  }
  return result.error;
}

const q = (name: string, ...values: unknown[]): Shape => ({ q: name, values });
const t = (text: string): Shape => ({ text });

describe("terms and implicit AND", () => {
  it("parses an empty or blank query to an empty AND", () => {
    expect(ast("")).toEqual({ and: [] });
    expect(ast("   \t ")).toEqual({ and: [] });
  });

  it("returns a single term unwrapped", () => {
    expect(ast("login")).toEqual(t("login"));
    expect(ast("label:bug")).toEqual(q("label", "bug"));
  });

  it("combines whitespace-separated terms with implicit AND", () => {
    expect(ast("login  crash\tlabel:bug")).toEqual({
      and: [t("login"), t("crash"), q("label", "bug")],
    });
  });

  it("records the source range of each node", () => {
    const result = parse("ab  label:x");
    expect(result).toEqual({
      ast: {
        type: "and",
        start: 0,
        end: 11,
        children: [
          { type: "text", value: "ab", start: 0, end: 2 },
          {
            type: "qualifier",
            name: "label",
            negated: false,
            values: ["x"],
            start: 4,
            end: 11,
          },
        ],
      },
      warnings: [],
    });
  });
});

describe("AND and OR", () => {
  it("treats explicit AND like implicit AND", () => {
    expect(ast("a AND b")).toEqual({ and: [t("a"), t("b")] });
    expect(ast("a AND b c")).toEqual({ and: [t("a"), t("b"), t("c")] });
  });

  it("binds AND tighter than OR", () => {
    expect(ast("a OR b AND c")).toEqual({
      or: [t("a"), { and: [t("b"), t("c")] }],
    });
    expect(ast("a b OR c d")).toEqual({
      or: [{ and: [t("a"), t("b")] }, { and: [t("c"), t("d")] }],
    });
    expect(ast("a OR b OR c")).toEqual({ or: [t("a"), t("b"), t("c")] });
  });

  it("treats lowercase and/or as free text", () => {
    expect(ast("a and b or c")).toEqual({
      and: [t("a"), t("and"), t("b"), t("or"), t("c")],
    });
    expect(ast("And Or")).toEqual({ and: [t("And"), t("Or")] });
  });

  it("treats a quoted AND or OR as free text", () => {
    expect(ast('"AND" "OR"')).toEqual({ and: [t("AND"), t("OR")] });
  });

  it("recognises the operators next to parentheses", () => {
    expect(ast("(a)OR(b)")).toEqual({ or: [t("a"), t("b")] });
  });
});

describe("parentheses", () => {
  it("overrides precedence", () => {
    expect(ast("(a OR b) AND c")).toEqual({
      and: [{ or: [t("a"), t("b")] }, t("c")],
    });
    expect(ast("a AND (b OR c) d")).toEqual({
      and: [t("a"), { or: [t("b"), t("c")] }, t("d")],
    });
  });

  it("unwraps a group around one term", () => {
    expect(ast("((a))")).toEqual(t("a"));
  });

  it("accepts five open parentheses", () => {
    expect(ast("((((( a )))))")).toEqual(t("a"));
    expect(ast("(a) (b) (c) (d) (e) (f)")).toEqual({
      and: ["a", "b", "c", "d", "e", "f"].map(t),
    });
  });

  it("rejects a sixth open parenthesis at that parenthesis", () => {
    expect(error("(((((( a ))))))")).toEqual({
      message: "At most 5 parentheses may be open at once",
      start: 5,
      end: 6,
    });
  });

  it("rejects an unclosed parenthesis at its opening", () => {
    expect(error("a (b c")).toEqual({
      message: "Unbalanced parenthesis",
      start: 2,
      end: 3,
    });
    expect(error("a (")).toEqual({
      message: "Unbalanced parenthesis",
      start: 2,
      end: 3,
    });
    expect(error("((a)")).toEqual({
      message: "Unbalanced parenthesis",
      start: 0,
      end: 1,
    });
  });

  it("rejects an unmatched closing parenthesis", () => {
    expect(error("a) b")).toEqual({
      message: "Unbalanced parenthesis",
      start: 1,
      end: 2,
    });
    expect(error(")")).toEqual({
      message: "Unbalanced parenthesis",
      start: 0,
      end: 1,
    });
    expect(error("(a))")).toEqual({
      message: "Unbalanced parenthesis",
      start: 3,
      end: 4,
    });
  });

  it("rejects empty parentheses", () => {
    expect(error("a ()")).toEqual({
      message: "Empty parentheses",
      start: 2,
      end: 4,
    });
    expect(error("( )")).toEqual({
      message: "Empty parentheses",
      start: 0,
      end: 3,
    });
  });
});

describe("dangling operators", () => {
  const dangling = (word: string, start: number): QueryError => ({
    message: `${word} must be between two terms`,
    start,
    end: start + word.length,
  });

  it("rejects a leading operator", () => {
    expect(error("AND a")).toEqual(dangling("AND", 0));
    expect(error("OR a")).toEqual(dangling("OR", 0));
    expect(error("(OR a)")).toEqual(dangling("OR", 1));
  });

  it("rejects a trailing operator", () => {
    expect(error("a AND")).toEqual(dangling("AND", 2));
    expect(error("a OR")).toEqual(dangling("OR", 2));
    expect(error("(a AND)")).toEqual(dangling("AND", 3));
    expect(error("(a OR) b")).toEqual(dangling("OR", 3));
  });

  it("rejects adjacent operators at the first one", () => {
    expect(error("a OR OR b")).toEqual(dangling("OR", 2));
    expect(error("a AND OR b")).toEqual(dangling("AND", 2));
    expect(error("a OR AND b")).toEqual(dangling("OR", 2));
  });

  it("rejects a lone operator", () => {
    expect(error("AND")).toEqual(dangling("AND", 0));
  });
});

describe("qualifiers", () => {
  it("lowercases the qualifier name only", () => {
    expect(ast("LABEL:Bug")).toEqual(q("label", "Bug"));
    expect(ast("Is:Open")).toEqual(q("is", "open"));
    expect(ast("Blocked-By:o/r#1")).toEqual(
      q("blocked-by", { owner: "o", repo: "r", number: 1 }),
    );
  });

  it("accepts double-quoted values with spaces", () => {
    expect(ast('label:"good first issue"')).toEqual(
      q("label", "good first issue"),
    );
    expect(ast('label:"good first issue" bug')).toEqual({
      and: [q("label", "good first issue"), t("bug")],
    });
  });

  it("allows parentheses and commas inside quotes", () => {
    expect(ast('milestone:"v1 (beta), final"')).toEqual(
      q("milestone", "v1 (beta), final"),
    );
  });

  it("has no escape sequence", () => {
    expect(error('label:"a\\"b"')).toMatchObject({
      message: "Unbalanced quote",
    });
  });

  it("splits a comma list into OR elements", () => {
    expect(ast("label:bug,security")).toEqual(q("label", "bug", "security"));
    expect(ast("assignee:alice,@me")).toEqual(q("assignee", "alice", "@me"));
    expect(ast("repo:o/a,o/b")).toEqual(
      q("repo", { owner: "o", name: "a" }, { owner: "o", name: "b" }),
    );
  });

  it("splits a list with quoted elements", () => {
    expect(ast('label:"a b",c')).toEqual(q("label", "a b", "c"));
    expect(ast('label:a,"b c"')).toEqual(q("label", "a", "b c"));
  });

  it("keeps repeated qualifiers as separate AND terms", () => {
    expect(ast("label:bug label:p1")).toEqual({
      and: [q("label", "bug"), q("label", "p1")],
    });
  });

  it("negates a qualifier with -", () => {
    expect(ast("-label:wontfix")).toEqual({
      q: "label",
      values: ["wontfix"],
      negated: true,
    });
    expect(ast("-LABEL:a,b")).toEqual({
      q: "label",
      values: ["a", "b"],
      negated: true,
    });
  });

  it("treats a colon in free text that is not a qualifier as text", () => {
    expect(ast("12:30")).toEqual(t("12:30"));
    expect(ast(":x")).toEqual(t(":x"));
  });

  it("treats a hyphen inside a word as part of free text", () => {
    expect(ast("well-known")).toEqual(t("well-known"));
  });
});

describe("free text and quoting", () => {
  it("parses a quoted phrase as one term", () => {
    expect(ast('"login crash" bug')).toEqual({
      and: [t("login crash"), t("bug")],
    });
  });

  it("parses a quoted phrase containing parentheses", () => {
    expect(ast('"a (b"')).toEqual(t("a (b"));
  });

  it("strips quotes inside a word", () => {
    expect(ast('ab"c d"')).toEqual(t("abc d"));
  });
});

describe("syntax errors", () => {
  it("rejects an unbalanced quote from the quote to the end", () => {
    expect(error('label:"abc')).toEqual({
      message: "Unbalanced quote",
      start: 6,
      end: 10,
    });
    expect(error('a "b c')).toEqual({
      message: "Unbalanced quote",
      start: 2,
      end: 6,
    });
    expect(error('"a" "')).toEqual({
      message: "Unbalanced quote",
      start: 4,
      end: 5,
    });
  });

  it("rejects negated free text, groups and issue numbers", () => {
    const message = "Only a qualifier can be negated with -";
    expect(error("-bug")).toEqual({ message, start: 0, end: 4 });
    expect(error("a -#123")).toEqual({ message, start: 2, end: 7 });
    expect(error('-"a b"')).toEqual({ message, start: 0, end: 6 });
    expect(error("-")).toEqual({ message, start: 0, end: 1 });
    expect(error("--label:a")).toEqual({ message, start: 0, end: 9 });
  });

  it("rejects a negated group", () => {
    expect(error("-(a OR b)")).toEqual({
      message: "Only a qualifier can be negated with -",
      start: 0,
      end: 1,
    });
  });

  it("rejects an empty value over the whole term", () => {
    const message = "Empty qualifier value";
    expect(error("label:")).toEqual({ message, start: 0, end: 6 });
    expect(error("a -is: b")).toEqual({ message, start: 2, end: 6 });
    expect(error('label:""')).toEqual({ message, start: 0, end: 8 });
  });

  it("rejects an empty list element at its comma", () => {
    const message = "Empty list element";
    expect(error("label:a,")).toEqual({ message, start: 7, end: 8 });
    expect(error("label:,a")).toEqual({ message, start: 6, end: 7 });
    expect(error("label:a,,b")).toEqual({ message, start: 8, end: 9 });
    expect(error('label:a,""')).toEqual({ message, start: 9, end: 10 });
  });

  it("reports the first lexical error before structural ones", () => {
    expect(error("(a label:")).toMatchObject({
      message: "Empty qualifier value",
    });
  });
});
