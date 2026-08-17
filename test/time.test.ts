import { describe, expect, it } from "vitest";
import { localDate, localDayBounds, localWeekBounds } from "../src/core/time";

const now = new Date("2026-08-15T02:00:00.000Z");

describe("timezone arithmetic", () => {
  it("formats the user's local date", () => {
    expect(localDate(now, "Asia/Singapore")).toBe("2026-08-15");
  });

  it("builds timezone-safe day and week bounds without interpreting language", () => {
    expect(localDayBounds(now, "Asia/Singapore")).toEqual({
      start: "2026-08-14T16:00:00.000Z",
      end: "2026-08-15T16:00:00.000Z",
    });
    expect(localWeekBounds(now, "Asia/Singapore", true)).toEqual({
      start: "2026-08-16T16:00:00.000Z",
      end: "2026-08-23T16:00:00.000Z",
    });
  });

  it("keeps local-day boundaries correct across daylight-saving changes", () => {
    const beforeFallBack = new Date("2026-11-01T12:00:00.000Z");
    expect(localDayBounds(beforeFallBack, "America/New_York")).toEqual({
      start: "2026-11-01T04:00:00.000Z",
      end: "2026-11-02T05:00:00.000Z",
    });
    expect(localDayBounds(beforeFallBack, "America/New_York", 1)).toEqual({
      start: "2026-11-02T05:00:00.000Z",
      end: "2026-11-03T05:00:00.000Z",
    });
  });
});
