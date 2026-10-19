import { describe, expect, it } from "vitest";
import {
  appendQualifier,
  assigneeQualifier,
  labelQualifier,
  repoQualifier,
} from "@/components/filter-bar/qualifiers";

const LABEL = 'label:"x"';

describe("qualifier text", () => {
  it("quotes a label name and leaves assignee and repo bare", () => {
    expect(labelQualifier("good first issue")).toBe('label:"good first issue"');
    expect(assigneeQualifier("ada")).toBe("assignee:ada");
    expect(repoQualifier({ owner: "acme", name: "rocket" })).toBe(
      "repo:acme/rocket",
    );
  });

  it("cannot express a label with a double quote", () => {
    expect(labelQualifier('say "hi"')).toBeNull();
  });
});

describe("appendQualifier", () => {
  it("starts an empty filter with the qualifier", () => {
    expect(appendQualifier("", LABEL)).toBe(LABEL);
    expect(appendQualifier("   ", LABEL)).toBe(LABEL);
  });

  it("appends to a filter without a top-level OR", () => {
    expect(appendQualifier("is:open  ", LABEL)).toBe(`is:open ${LABEL}`);
    expect(appendQualifier("label:a AND repo:o/r", LABEL)).toBe(
      `label:a AND repo:o/r ${LABEL}`,
    );
  });

  it("wraps a filter with a top-level OR so the qualifier narrows all of it", () => {
    expect(appendQualifier("label:a OR label:b", LABEL)).toBe(
      `(label:a OR label:b) ${LABEL}`,
    );
    expect(appendQualifier("(label:a) OR (label:b)", LABEL)).toBe(
      `((label:a) OR (label:b)) ${LABEL}`,
    );
  });

  it("does not wrap an OR that only sits inside parentheses", () => {
    expect(appendQualifier("(label:a OR label:b)", LABEL)).toBe(
      `(label:a OR label:b) ${LABEL}`,
    );
    expect(appendQualifier("is:open (label:a OR label:b)", LABEL)).toBe(
      `is:open (label:a OR label:b) ${LABEL}`,
    );
  });

  it("does nothing when the wrapping would need more than 5 open parentheses", () => {
    const deep = "((((label:a OR label:b)))) OR label:c";
    expect(
      appendQualifier("(((((label:a OR label:b))))) OR label:c", LABEL),
    ).toBeNull();
    expect(appendQualifier(deep, LABEL)).toBe(`(${deep}) ${LABEL}`);
  });

  it("does nothing for a filter that does not parse", () => {
    expect(appendQualifier("label:a AND", LABEL)).toBeNull();
    expect(appendQualifier('label:"a', LABEL)).toBeNull();
  });
});
