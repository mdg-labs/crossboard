import { describe, expect, it } from "vitest";
import {
  checkDraft,
  emptyDraft,
  moveColumn,
  newColumn,
  toInput,
} from "@/components/board-form/board-draft";

describe("checkDraft", () => {
  it("accepts a blank base filter and blank column filters", () => {
    const draft = emptyDraft();
    draft.name = "Sprint";
    draft.columns = [{ ...newColumn(), name: "To do" }];

    expect(checkDraft(draft).valid).toBe(true);
  });

  it("reports the parse error of a filter at its column", () => {
    const draft = emptyDraft();
    draft.name = "Sprint";
    draft.columns = [
      { ...newColumn(), name: "To do", filter: "label:bug" },
      { ...newColumn(), name: "Doing", filter: "AND label:bug" },
    ];

    const problems = checkDraft(draft);

    expect(problems.valid).toBe(false);
    expect(problems.columns[0]?.filter).toBeNull();
    expect(problems.columns[1]?.filter).toEqual(expect.any(String));
    expect(problems.baseFilter).toBeNull();
  });

  it("requires names of 1 to 100 characters", () => {
    const draft = emptyDraft();
    draft.name = "x".repeat(101);
    draft.columns = [{ ...newColumn(), name: " " }];

    const problems = checkDraft(draft);

    expect(problems.name).toBe("Enter a name of 1 to 100 characters.");
    expect(problems.columns[0]?.name).toBe(
      "Enter a name of 1 to 100 characters.",
    );
    expect(problems.valid).toBe(false);
  });
});

describe("toInput", () => {
  it("trims names and filters and drops the row keys", () => {
    const draft = emptyDraft();
    draft.name = "  Sprint ";
    draft.baseFilter = " repo:acme/widgets ";
    draft.columns = [{ ...newColumn(), name: " Doing ", filter: " is:open " }];

    expect(toInput(draft)).toEqual({
      name: "Sprint",
      baseFilter: "repo:acme/widgets",
      sort: "updated-desc",
      subIssueMode: "collapsed",
      showOther: false,
      columns: [{ name: "Doing", filter: "is:open" }],
    });
  });
});

describe("moveColumn", () => {
  it("swaps with the neighbour and stops at the ends", () => {
    expect(moveColumn(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveColumn(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveColumn(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveColumn(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });
});
