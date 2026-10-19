import { describe, expect, it } from "vitest";
import {
  formatValue,
  nameSuggestions,
  suggestionContext,
  valueSuggestions,
} from "@/components/filter-bar/suggestions";

const at = (text: string, marker = "|") => {
  const caret = text.indexOf(marker);
  return suggestionContext(text.replace(marker, ""), caret);
};

describe("suggestionContext", () => {
  it("suggests qualifier names for the word being typed", () => {
    expect(at("la|")).toEqual({ kind: "name", prefix: "la", start: 0, end: 2 });
    expect(at("is:open -as|")).toEqual({
      kind: "name",
      prefix: "as",
      start: 9,
      end: 11,
    });
    expect(at("(is:open OR au|)")).toEqual({
      kind: "name",
      prefix: "au",
      start: 12,
      end: 14,
    });
  });

  it("suggests nothing for an empty word or free text with no letter start", () => {
    expect(at("|")).toBeNull();
    expect(at("is:open |")).toBeNull();
    expect(at("12|")).toBeNull();
    expect(at('"quoted te|xt"')).toBeNull();
  });

  it("suggests values right after the colon", () => {
    expect(at("label:|")).toEqual({
      kind: "value",
      field: "label",
      prefix: "",
      start: 6,
      end: 6,
    });
    expect(at("-assignee:oc|")).toMatchObject({
      kind: "value",
      field: "assignee",
      prefix: "oc",
      start: 10,
    });
  });

  it("reads the qualifier name case-insensitively and knows org and user", () => {
    expect(at("Label:b|")).toMatchObject({ kind: "value", field: "label" });
    expect(at("org:a|")).toMatchObject({ kind: "value", field: "org" });
    expect(at("user:a|")).toMatchObject({ kind: "value", field: "user" });
  });

  it("suggests nothing for qualifiers the server has no values for", () => {
    expect(at("is:o|")).toBeNull();
    expect(at("parent:a/b#|")).toBeNull();
    expect(at("foo:b|")).toBeNull();
  });

  it("uses the text after the last comma, without quotes, as the prefix", () => {
    expect(at("label:bug,doc|")).toEqual({
      kind: "value",
      field: "label",
      prefix: "doc",
      start: 10,
      end: 13,
    });
    expect(at("label:bug,|")).toMatchObject({ prefix: "", start: 10 });
    expect(at('label:"good fir|"')).toMatchObject({
      prefix: "good fir",
      start: 6,
      end: 16,
    });
    expect(at('label:"a,b",c|')).toMatchObject({ prefix: "c", start: 12 });
  });

  it("replaces the whole element the caret is in", () => {
    expect(at("label:b|ug,docs")).toMatchObject({
      prefix: "b",
      start: 6,
      end: 9,
    });
    expect(at("label:bug,d|ocs")).toMatchObject({
      prefix: "d",
      start: 10,
      end: 14,
    });
  });

  it("suggests nothing when the caret is inside the qualifier name", () => {
    expect(at("lab|el:bug")).toBeNull();
  });
});

describe("suggestions", () => {
  it("completes a qualifier name with its colon and asks for its values", () => {
    const text = "is:open la";
    const context = suggestionContext(text, text.length);
    if (context?.kind !== "name") {
      throw new Error("expected a name context");
    }
    expect(nameSuggestions(text, context)).toEqual([
      { label: "label:", text: "is:open label:", caret: 14, continues: true },
    ]);
  });

  it("keeps the negation when completing a name", () => {
    const text = "-as";
    const context = suggestionContext(text, text.length);
    if (context?.kind !== "name") {
      throw new Error("expected a name context");
    }
    expect(nameSuggestions(text, context)[0]?.text).toBe("-assignee:");
  });

  it("inserts a value, quoted when it would otherwise split", () => {
    const text = "label:bug,go repo:a/b";
    const context = suggestionContext(text, 12);
    if (context?.kind !== "value") {
      throw new Error("expected a value context");
    }
    expect(
      valueSuggestions(text, context, ["good first issue", "go", 'say "hi"']),
    ).toEqual([
      {
        label: "good first issue",
        text: 'label:bug,"good first issue" repo:a/b',
        caret: 28,
        continues: false,
      },
      {
        label: "go",
        text: "label:bug,go repo:a/b",
        caret: 12,
        continues: false,
      },
    ]);
  });

  it("formats values", () => {
    expect(formatValue("bug")).toBe("bug");
    expect(formatValue("good first issue")).toBe('"good first issue"');
    expect(formatValue("a,b")).toBe('"a,b"');
    expect(formatValue("v(1)")).toBe('"v(1)"');
  });
});
