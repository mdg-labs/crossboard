import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";

describe("App", () => {
  it("renders the placeholder heading", () => {
    expect(renderToString(<App />)).toContain("Crossboard");
  });
});
