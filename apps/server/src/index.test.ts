import { describe, expect, it } from "vitest";
import { SERVICE_NAME } from "./index.js";

describe("@crossboard/server", () => {
  it("names the service", () => {
    expect(SERVICE_NAME).toBe("crossboard");
  });
});
