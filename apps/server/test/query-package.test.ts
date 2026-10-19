import {
  evaluate,
  parse,
  type EvaluationContext,
  type FilterableIssue,
} from "@crossboard/query";
import { describe, expect, it } from "vitest";

const issue: FilterableIssue = {
  repoOwner: "mdg-labs",
  repoName: "crossboard",
  number: 42,
  title: "Login crashes on Safari",
  authorLogin: "alice",
  typeName: null,
  milestoneTitle: null,
  labels: ["bug"],
  assignees: ["bob"],
  parent: null,
  subIssueTotal: 0,
  blockedBy: [],
  blocking: [],
  blockedByNotAccessible: 0,
  blockingNotAccessible: 0,
};

const viewer: EvaluationContext = { viewerLogin: "bob" };

function matches(query: string): boolean {
  const result = parse(query);
  if ("error" in result) throw new Error(result.error.message);
  return evaluate(result.ast, issue, viewer);
}

describe("@crossboard/query in the server", () => {
  it("evaluates a parsed filter against an issue", () => {
    expect(matches("is:open label:bug assignee:@me")).toBe(true);
    expect(matches("is:open label:feature")).toBe(false);
  });
});
