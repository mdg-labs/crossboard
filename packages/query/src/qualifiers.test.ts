import { describe, expect, it } from "vitest";
import {
  parse,
  type Node,
  type QualifierNode,
  type QueryError,
  type QueryWarning,
} from "./index.js";

function parsed(query: string): { ast: Node; warnings: QueryWarning[] } {
  const result = parse(query);
  if ("error" in result) {
    throw new Error(`unexpected error: ${JSON.stringify(result.error)}`);
  }
  return result;
}

function qualifier(query: string): QualifierNode {
  const { ast } = parsed(query);
  if (ast.type !== "qualifier") {
    throw new Error(`expected a qualifier, got ${ast.type}`);
  }
  return ast;
}

function error(query: string): QueryError {
  const result = parse(query);
  if (!("error" in result)) {
    throw new Error(`expected a syntax error for ${query}`);
  }
  return result.error;
}

describe("known qualifiers", () => {
  it.each([
    ["is:open", "is", ["open"]],
    ["is:closed", "is", ["closed"]],
    ["is:issue", "is", ["issue"]],
    ["is:pr", "is", ["pr"]],
    ["is:blocked", "is", ["blocked"]],
    ["is:blocking", "is", ["blocking"]],
    ["IS:Blocked,BLOCKING", "is", ["blocked", "blocking"]],
    ["no:label", "no", ["label"]],
    ["no:assignee", "no", ["assignee"]],
    ["no:milestone", "no", ["milestone"]],
    ["no:type", "no", ["type"]],
    ["no:parent", "no", ["parent"]],
    ["No:Label,assignee", "no", ["label", "assignee"]],
    ["has:sub-issues", "has", ["sub-issues"]],
    ["has:parent", "has", ["parent"]],
    ["has:dependencies", "has", ["dependencies"]],
    ["HAS:Parent", "has", ["parent"]],
    ['label:Bug,"good first"', "label", ["Bug", "good first"]],
    ["assignee:@me", "assignee", ["@me"]],
    ["author:alice", "author", ["alice"]],
    ["org:mdg-labs", "org", ["mdg-labs"]],
    ["user:Alice", "user", ["Alice"]],
    ["type:Bug", "type", ["Bug"]],
    ['milestone:"v1.0"', "milestone", ["v1.0"]],
  ])("resolves %s", (query, name, values) => {
    const node = qualifier(query);
    expect(node).toMatchObject({ name, values, negated: false });
  });

  it("keeps negation on a resolved qualifier", () => {
    expect(qualifier("-no:label")).toMatchObject({
      name: "no",
      values: ["label"],
      negated: true,
    });
  });

  it("resolves repo to owner and name", () => {
    expect(qualifier("repo:mdg-labs/crossboard,o/a")).toMatchObject({
      name: "repo",
      values: [
        { owner: "mdg-labs", name: "crossboard" },
        { owner: "o", name: "a" },
      ],
    });
  });

  it.each(["parent", "blocked-by", "blocking"])(
    "resolves %s to an issue reference",
    (name) => {
      expect(qualifier(`${name}:mdg-labs/crossboard#12,o/r#3`)).toMatchObject({
        name,
        values: [
          { owner: "mdg-labs", repo: "crossboard", number: 12 },
          { owner: "o", repo: "r", number: 3 },
        ],
      });
    },
  );

  it("produces no warnings for valid qualifiers", () => {
    expect(
      parsed("is:open is:issue label:bug no:label has:parent repo:o/r")
        .warnings,
    ).toEqual([]);
  });
});

describe("repo and issue reference errors", () => {
  it("rejects a bare repo name at the element", () => {
    expect(error("repo:crossboard")).toEqual({
      message: 'Expected owner/name, got "crossboard"',
      start: 5,
      end: 15,
    });
  });

  it.each(["o/", "/r", "o/r/x", "o/r#1", "a b"])(
    "rejects repo value %s",
    (value) => {
      expect(error(`repo:o/a,"${value}"`)).toMatchObject({
        message: `Expected owner/name, got "${value}"`,
        start: 9,
      });
    },
  );

  it.each(["parent", "blocked-by", "blocking"])(
    "rejects a malformed reference for %s",
    (name) => {
      const start = name.length + 1;
      for (const value of [
        "12",
        "#12",
        "o/r",
        "o/r#",
        "o/r#x",
        "o/r#0",
        "o/r#012",
      ]) {
        expect(error(`${name}:${value}`)).toEqual({
          message: `Expected owner/repo#N, got "${value}"`,
          start,
          end: start + value.length,
        });
      }
    },
  );

  it("rejects an unsafe issue number", () => {
    expect(error("parent:o/r#99999999999999999999")).toMatchObject({
      message: 'Expected owner/repo#N, got "o/r#99999999999999999999"',
    });
  });

  it("points at the bad element of a list", () => {
    expect(error("blocking:o/r#1,bad")).toEqual({
      message: 'Expected owner/repo#N, got "bad"',
      start: 15,
      end: 18,
    });
  });

  it("reports a syntax error over earlier warnings", () => {
    expect(error("sort:updated repo:x")).toMatchObject({
      message: 'Expected owner/name, got "x"',
    });
  });
});

describe("unknown qualifiers and values", () => {
  it.each(["sort", "in", "reason", "foo", "Sort"])(
    "ignores %s: with a warning naming it",
    (name) => {
      const query = `a ${name}:x b`;
      const { ast, warnings } = parsed(query);
      expect(ast).toMatchObject({
        type: "and",
        children: [
          { type: "text" },
          { type: "ignored", start: 2, end: 4 + name.length },
          { type: "text" },
        ],
      });
      expect(warnings).toEqual([
        {
          message: `Unknown qualifier "${name.toLowerCase()}"; it is ignored`,
          start: 2,
          end: 4 + name.length,
        },
      ]);
    },
  );

  it("ignores a negated unknown qualifier", () => {
    const { ast, warnings } = parsed("-sort:updated");
    expect(ast).toMatchObject({ type: "ignored", start: 0, end: 13 });
    expect(warnings).toHaveLength(1);
  });

  it.each([
    ["is:draft", "is", "draft", 3],
    ["no:foo", "no", "foo", 3],
    ["has:foo", "has", "foo", 4],
  ])("ignores %s with a warning on the value", (query, name, value, start) => {
    const { ast, warnings } = parsed(query);
    expect(ast).toMatchObject({ type: "ignored" });
    expect(warnings).toEqual([
      {
        message: `Unknown value "${value}" for "${name}:"; it is ignored`,
        start,
        end: start + value.length,
      },
    ]);
  });

  it("ignores the whole qualifier when one list element is unknown", () => {
    const { ast, warnings } = parsed("is:open,draft,wip");
    expect(ast).toMatchObject({ type: "ignored", start: 0, end: 17 });
    expect(warnings.map((w) => [w.start, w.end])).toEqual([
      [8, 13],
      [14, 17],
    ]);
  });

  it("warns for each unknown qualifier in order", () => {
    const { warnings } = parsed("sort:a is:draft in:title");
    expect(warnings.map((w) => w.start)).toEqual([0, 10, 16]);
  });
});

describe("hints", () => {
  it("warns that closed issues are not synced", () => {
    const { ast, warnings } = parsed("is:closed");
    expect(ast).toMatchObject({ name: "is", values: ["closed"] });
    expect(warnings).toEqual([
      { message: "Crossboard only syncs open issues", start: 3, end: 9 },
    ]);
  });

  it("warns that pull requests are not shown", () => {
    const { ast, warnings } = parsed("x -is:open,pr");
    expect(ast).toMatchObject({
      children: [{ type: "text" }, { name: "is", values: ["open", "pr"] }],
    });
    expect(warnings).toEqual([
      { message: "Pull requests are not shown", start: 11, end: 13 },
    ]);
  });

  it("warns for both hints in one list", () => {
    expect(parsed("is:closed,pr").warnings.map((w) => w.message)).toEqual([
      "Crossboard only syncs open issues",
      "Pull requests are not shown",
    ]);
  });
});

describe("issue numbers and quoted phrases", () => {
  it("parses #N as an issue-number match", () => {
    const { ast, warnings } = parsed("#123");
    expect(ast).toEqual({ type: "number", number: 123, start: 0, end: 4 });
    expect(warnings).toEqual([]);
  });

  it("parses #N among other terms", () => {
    expect(parsed("login #7").ast).toMatchObject({
      children: [{ type: "text" }, { type: "number", number: 7 }],
    });
  });

  it.each(["#", "#12a", "#1.5", "12", "a#1"])(
    "keeps %s as free text",
    (term) => {
      expect(parsed(term).ast).toMatchObject({ type: "text", value: term });
    },
  );

  it("keeps a quoted #N as free text", () => {
    expect(parsed('"#123"').ast).toMatchObject({
      type: "text",
      value: "#123",
    });
  });

  it("keeps a quoted phrase as one free-text term", () => {
    expect(parsed('"login crash"').ast).toMatchObject({
      type: "text",
      value: "login crash",
      start: 0,
      end: 13,
    });
  });
});
