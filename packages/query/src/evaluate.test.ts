import { describe, expect, it } from "vitest";
import {
  evaluate,
  parse,
  type EvaluationContext,
  type FilterableIssue,
  type IssueRelation,
} from "./index.js";

function issue(overrides: Partial<FilterableIssue> = {}): FilterableIssue {
  return {
    repoOwner: "mdg-labs",
    repoName: "crossboard",
    number: 42,
    title: "Login crashes on Safari",
    authorLogin: "alice",
    typeName: null,
    milestoneTitle: null,
    labels: [],
    assignees: [],
    parent: null,
    subIssueTotal: 0,
    blockedBy: [],
    blocking: [],
    blockedByNotAccessible: 0,
    blockingNotAccessible: 0,
    ...overrides,
  };
}

const viewer: EvaluationContext = { viewerLogin: "bob" };

function matches(
  query: string,
  overrides: Partial<FilterableIssue> = {},
  context: EvaluationContext = viewer,
): boolean {
  const result = parse(query);
  if ("error" in result) {
    throw new Error(`unexpected error: ${JSON.stringify(result.error)}`);
  }
  return evaluate(result.ast, issue(overrides), context);
}

const relation = (
  state: IssueRelation["state"],
  number = 1,
  owner = "o",
  repo = "r",
): IssueRelation => ({ owner, repo, number, state });

describe("state and kind", () => {
  it("matches every issue for is:open and is:issue", () => {
    expect(matches("is:open")).toBe(true);
    expect(matches("is:issue")).toBe(true);
  });

  it("matches nothing for is:closed and is:pr", () => {
    expect(matches("is:closed")).toBe(false);
    expect(matches("is:pr")).toBe(false);
  });

  it("inverts them when negated", () => {
    expect(matches("-is:closed")).toBe(true);
    expect(matches("-is:open")).toBe(false);
  });
});

describe("label, assignee, author, type, milestone", () => {
  it("matches a label case-insensitively and exactly", () => {
    const labels = ["Bug", "good first issue"];
    expect(matches("label:bug", { labels })).toBe(true);
    expect(matches("label:BUG", { labels })).toBe(true);
    expect(matches('label:"Good First Issue"', { labels })).toBe(true);
    expect(matches("label:bu", { labels })).toBe(false);
    expect(matches("label:bug", { labels: [] })).toBe(false);
  });

  it("matches an assignee and resolves @me", () => {
    const assignees = ["Alice", "bob"];
    expect(matches("assignee:alice", { assignees })).toBe(true);
    expect(matches("assignee:ali", { assignees })).toBe(false);
    expect(matches("assignee:@me", { assignees })).toBe(true);
    expect(matches("assignee:@ME", { assignees })).toBe(true);
    expect(matches("assignee:@me", { assignees: ["alice"] })).toBe(false);
    expect(matches("assignee:carol", { assignees })).toBe(false);
  });

  it("matches the author and resolves @me", () => {
    expect(matches("author:ALICE")).toBe(true);
    expect(matches("author:alic")).toBe(false);
    expect(matches("author:@me")).toBe(false);
    expect(matches("author:@me", { authorLogin: "Bob" })).toBe(true);
    expect(matches("author:ghost", { authorLogin: "ghost" })).toBe(true);
  });

  it("matches the type name", () => {
    expect(matches("type:bug", { typeName: "Bug" })).toBe(true);
    expect(matches("type:bu", { typeName: "Bug" })).toBe(false);
    expect(matches("type:bug", { typeName: null })).toBe(false);
  });

  it("matches the milestone title", () => {
    expect(matches('milestone:"V1.0"', { milestoneTitle: "v1.0" })).toBe(true);
    expect(matches("milestone:v1", { milestoneTitle: "v1.0" })).toBe(false);
    expect(matches("milestone:v1.0", { milestoneTitle: null })).toBe(false);
  });
});

describe("no and has", () => {
  it("evaluates no:label", () => {
    expect(matches("no:label")).toBe(true);
    expect(matches("no:label", { labels: ["bug"] })).toBe(false);
  });

  it("evaluates no:assignee", () => {
    expect(matches("no:assignee")).toBe(true);
    expect(matches("no:assignee", { assignees: ["a"] })).toBe(false);
  });

  it("evaluates no:milestone", () => {
    expect(matches("no:milestone")).toBe(true);
    expect(matches("no:milestone", { milestoneTitle: "v1" })).toBe(false);
  });

  it("evaluates no:type", () => {
    expect(matches("no:type")).toBe(true);
    expect(matches("no:type", { typeName: "Bug" })).toBe(false);
  });

  it("evaluates no:parent", () => {
    const parent = { owner: "o", repo: "r", number: 1 };
    expect(matches("no:parent")).toBe(true);
    expect(matches("no:parent", { parent })).toBe(false);
  });

  it("evaluates has:sub-issues", () => {
    expect(matches("has:sub-issues")).toBe(false);
    expect(matches("has:sub-issues", { subIssueTotal: 2 })).toBe(true);
  });

  it("evaluates has:parent", () => {
    const parent = { owner: "o", repo: "r", number: 1 };
    expect(matches("has:parent")).toBe(false);
    expect(matches("has:parent", { parent })).toBe(true);
  });

  it("evaluates has:dependencies over readable and not-accessible relations", () => {
    expect(matches("has:dependencies")).toBe(false);
    expect(
      matches("has:dependencies", { blockedBy: [relation("CLOSED")] }),
    ).toBe(true);
    expect(matches("has:dependencies", { blocking: [relation("OPEN")] })).toBe(
      true,
    );
    expect(matches("has:dependencies", { blockedByNotAccessible: 1 })).toBe(
      true,
    );
    expect(matches("has:dependencies", { blockingNotAccessible: 1 })).toBe(
      true,
    );
  });
});

describe("repo, org and user", () => {
  it("matches owner/name case-insensitively and exactly", () => {
    expect(matches("repo:mdg-labs/crossboard")).toBe(true);
    expect(matches("repo:MDG-Labs/CrossBoard")).toBe(true);
    expect(matches("repo:mdg-labs/cross")).toBe(false);
    expect(matches("repo:other/crossboard")).toBe(false);
  });

  it("matches the repo owner for org and user", () => {
    expect(matches("org:mdg-labs")).toBe(true);
    expect(matches("user:MDG-LABS")).toBe(true);
    expect(matches("org:mdg")).toBe(false);
    expect(matches("user:alice")).toBe(false);
  });
});

describe("parent", () => {
  const parent = { owner: "MDG-Labs", repo: "Crossboard", number: 12 };

  it("matches the direct parent", () => {
    expect(matches("parent:mdg-labs/crossboard#12", { parent })).toBe(true);
    expect(matches("parent:mdg-labs/crossboard#13", { parent })).toBe(false);
    expect(matches("parent:other/crossboard#12", { parent })).toBe(false);
    expect(matches("parent:mdg-labs/other#12", { parent })).toBe(false);
    expect(matches("parent:mdg-labs/crossboard#12")).toBe(false);
  });
});

describe("free text and issue numbers", () => {
  it("matches a case-insensitive substring of the title", () => {
    expect(matches("login")).toBe(true);
    expect(matches("LOGIN safari")).toBe(true);
    expect(matches("ogin cras")).toBe(true);
    expect(matches("login firefox")).toBe(false);
  });

  it("matches a quoted phrase as a whole", () => {
    expect(matches('"login crashes"')).toBe(true);
    expect(matches('"crashes login"')).toBe(false);
  });

  it("does not match labels or other fields", () => {
    expect(matches("bug", { labels: ["bug"] })).toBe(false);
    expect(matches("alice")).toBe(false);
  });

  it("matches #N against the issue number", () => {
    expect(matches("#42")).toBe(true);
    expect(matches("#4")).toBe(false);
    expect(matches("#43")).toBe(false);
  });

  it("matches a quoted #N as title text", () => {
    expect(matches('"#42"')).toBe(false);
    expect(matches('"#42"', { title: "see #42" })).toBe(true);
  });
});

describe("dependencies (SPEC 4.4)", () => {
  it("is:blocked needs a readable open blocker or a not-accessible one", () => {
    expect(matches("is:blocked")).toBe(false);
    expect(matches("is:blocked", { blockedBy: [relation("OPEN")] })).toBe(true);
    expect(matches("is:blocked", { blockedByNotAccessible: 2 })).toBe(true);
    expect(
      matches("is:blocked", {
        blockedBy: [relation("CLOSED"), relation("OPEN", 2)],
      }),
    ).toBe(true);
  });

  it("is:blocked ignores closed blockers and blocking relations", () => {
    expect(matches("is:blocked", { blockedBy: [relation("CLOSED")] })).toBe(
      false,
    );
    expect(
      matches("is:blocked", {
        blocking: [relation("OPEN")],
        blockingNotAccessible: 3,
      }),
    ).toBe(false);
  });

  it("is:blocking needs a readable open blocked issue or a not-accessible one", () => {
    expect(matches("is:blocking")).toBe(false);
    expect(matches("is:blocking", { blocking: [relation("OPEN")] })).toBe(true);
    expect(matches("is:blocking", { blockingNotAccessible: 1 })).toBe(true);
  });

  it("is:blocking ignores closed blocked issues and blocked-by relations", () => {
    expect(matches("is:blocking", { blocking: [relation("CLOSED")] })).toBe(
      false,
    );
    expect(
      matches("is:blocking", {
        blockedBy: [relation("OPEN")],
        blockedByNotAccessible: 3,
      }),
    ).toBe(false);
  });

  it("blocked-by: matches a readable relation in any state", () => {
    const blockedBy = [relation("CLOSED", 7, "Acme", "Widgets")];
    expect(matches("blocked-by:acme/widgets#7", { blockedBy })).toBe(true);
    expect(
      matches("blocked-by:acme/widgets#7", {
        blockedBy: [relation("OPEN", 7, "acme", "widgets")],
      }),
    ).toBe(true);
    expect(matches("blocked-by:acme/widgets#8", { blockedBy })).toBe(false);
    expect(matches("blocked-by:acme/widgets#7", { blocking: blockedBy })).toBe(
      false,
    );
    expect(matches("blocked-by:acme/widgets#7")).toBe(false);
  });

  it("blocking: matches a readable relation in any state", () => {
    const blocking = [relation("CLOSED", 9, "o", "r")];
    expect(matches("blocking:o/r#9", { blocking })).toBe(true);
    expect(matches("blocking:o/r#10", { blocking })).toBe(false);
    expect(matches("blocking:o/r#9", { blockedBy: blocking })).toBe(false);
  });
});

describe("boolean structure", () => {
  const labels = ["bug"];

  it("treats a comma list as OR within a qualifier", () => {
    expect(matches("label:bug,security", { labels })).toBe(true);
    expect(matches("label:security,bug", { labels })).toBe(true);
    expect(matches("label:security,p1", { labels })).toBe(false);
    expect(matches('label:"a b",bug', { labels })).toBe(true);
    expect(matches("repo:o/a,mdg-labs/crossboard")).toBe(true);
    expect(matches("assignee:alice,@me", { assignees: ["bob"] })).toBe(true);
    expect(matches("is:blocked,blocking", { blockingNotAccessible: 1 })).toBe(
      true,
    );
    expect(matches("no:label,assignee", { labels, assignees: [] })).toBe(true);
    expect(matches("has:parent,sub-issues", { subIssueTotal: 1 })).toBe(true);
  });

  it("negation inverts the whole comma list", () => {
    expect(matches("-label:bug,security", { labels })).toBe(false);
    expect(matches("-label:security,p1", { labels })).toBe(true);
    expect(matches("-no:label", { labels })).toBe(true);
    expect(matches("-is:blocked")).toBe(true);
  });

  it("ANDs repeated qualifiers", () => {
    expect(matches("label:bug label:p1", { labels: ["bug", "p1"] })).toBe(true);
    expect(matches("label:bug label:p1", { labels })).toBe(false);
  });

  it("gives AND precedence over OR", () => {
    expect(matches("zzz OR login AND safari")).toBe(true);
    expect(matches("zzz OR login AND firefox")).toBe(false);
    expect(matches("login AND firefox OR safari")).toBe(true);
    expect(matches("zzz AND login OR firefox")).toBe(false);
  });

  it("honours parentheses", () => {
    expect(matches("(zzz OR login) AND safari")).toBe(true);
    expect(matches("(zzz OR login) AND firefox")).toBe(false);
    expect(matches("login (firefox OR crashes)")).toBe(true);
  });

  it("matches everything for an empty query and ignored qualifiers", () => {
    expect(matches("")).toBe(true);
    expect(matches("sort:updated")).toBe(true);
    expect(matches("-sort:updated")).toBe(true);
    expect(matches("is:draft login")).toBe(true);
    expect(matches("is:draft zzz")).toBe(false);
  });
});
