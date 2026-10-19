import { describe, expect, it } from "vitest";
import {
  canPickRepos,
  pickedRepos,
  withPickedRepos,
} from "@/components/board/repo-term";

describe("pickedRepos", () => {
  it.each([
    ["", []],
    ["repo:acme/a", ["acme/a"]],
    ["is:open repo:acme/a,acme/b label:bug", ["acme/a", "acme/b"]],
    ["REPO:acme/a AND is:open", ["acme/a"]],
    ["-repo:acme/a", []],
    ["repo:acme/a OR label:bug", []],
    ["is:open (repo:acme/a OR repo:acme/b)", []],
    ["repo:", []],
  ])("reads the top-level term of %j", (q, expected) => {
    expect(pickedRepos(q)).toEqual(expected);
  });
});

describe("canPickRepos", () => {
  it("is true for a filter that parses and for none", () => {
    expect(canPickRepos("")).toBe(true);
    expect(canPickRepos("label:bug")).toBe(true);
  });

  it("is false for a filter that does not parse", () => {
    expect(canPickRepos("label:bug AND")).toBe(false);
  });
});

describe("withPickedRepos", () => {
  it.each([
    ["", ["acme/a"], "repo:acme/a"],
    ["", ["acme/a", "acme/b"], "repo:acme/a,acme/b"],
    ["label:bug", ["acme/a"], "label:bug repo:acme/a"],
    ["label:bug OR is:open", ["acme/a"], "(label:bug OR is:open) repo:acme/a"],
    [
      "label:bug repo:acme/a is:open",
      ["acme/b"],
      "label:bug repo:acme/b is:open",
    ],
    [
      "repo:acme/a AND is:open",
      ["acme/a", "acme/b"],
      "repo:acme/a,acme/b AND is:open",
    ],
    ["-repo:acme/a", ["acme/b"], "-repo:acme/a repo:acme/b"],
  ])("sets the term of %j to %j", (q, repos, expected) => {
    expect(withPickedRepos(q, repos)).toBe(expected);
  });

  it.each([
    ["repo:acme/a", ""],
    ["label:bug repo:acme/a", "label:bug"],
    ["repo:acme/a label:bug", "label:bug"],
    ["repo:acme/a AND label:bug", "label:bug"],
    ["label:bug AND repo:acme/a", "label:bug"],
    ["label:bug AND repo:acme/a AND is:open", "label:bug AND is:open"],
    ["(repo:acme/a) label:bug", "label:bug"],
    ["label:bug ((repo:acme/a))", "label:bug"],
    ["label:bug AND (repo:acme/a) AND is:open", "label:bug AND is:open"],
    ["label:bug", "label:bug"],
  ])("removes the term from %j when nothing is picked", (q, expected) => {
    expect(withPickedRepos(q, [])).toBe(expected);
  });

  it("leaves a filter that does not parse alone", () => {
    expect(withPickedRepos("label:bug AND", ["acme/a"])).toBeNull();
  });
});
