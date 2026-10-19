import { afterEach, describe, expect, it } from "vitest";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  it.each([
    [10_000, "just now"],
    [5 * MINUTE, "5 min ago"],
    [3 * HOUR + 20 * MINUTE, "3 h ago"],
    [2 * DAY, "2 d ago"],
    [65 * DAY, "2 mo ago"],
    [800 * DAY, "2 y ago"],
  ])("renders %d ms as %s", (elapsed, text) => {
    expect(formatRelativeTime(NOW - elapsed, NOW)).toBe(text);
  });

  it("never renders a time in the future as negative", () => {
    expect(formatRelativeTime(NOW + HOUR, NOW)).toBe("just now");
  });
});

describe("formatAbsoluteTime", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = original;
    }
  });

  it("uses the time zone of the browser", () => {
    process.env.TZ = "Asia/Kolkata";
    expect(formatAbsoluteTime(NOW)).toContain("5:30:00");
    process.env.TZ = "America/New_York";
    expect(formatAbsoluteTime(NOW)).toContain("8:00:00");
  });
});
