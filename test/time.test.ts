import { describe, expect, it } from "vitest";
import { localDayBounds, localWeekBounds, parseNaturalTime } from "../src/core/time";

const now = new Date("2026-08-15T02:00:00.000Z"); // 10:00 in Singapore, Saturday

describe("natural time parser", () => {
  it.each([
    ["半小时后提醒我", "2026-08-15T02:30:00.000Z"],
    ["2 小时后提醒我", "2026-08-15T04:00:00.000Z"],
    ["明天下午 3 点提醒", "2026-08-16T07:00:00.000Z"],
    ["今晚提醒", "2026-08-15T12:00:00.000Z"],
    ["周一 9 点", "2026-08-17T01:00:00.000Z"],
    ["下周一 9 点", "2026-08-17T01:00:00.000Z"],
    ["月底", "2026-08-31T01:00:00.000Z"],
    ["9 月 20 日", "2026-09-20T01:00:00.000Z"],
    ["9 月 20 日截止，提前一周提醒我", "2026-09-13T01:00:00.000Z"],
    ["9 月 20 日截止，提前一个月提醒我", "2026-08-20T01:00:00.000Z"],
  ])("parses %s", (text, expected) => {
    expect(parseNaturalTime(text, now, "Asia/Singapore")?.at).toBe(expected);
  });

  it("rolls a bare past clock to tomorrow", () => {
    expect(parseNaturalTime("早上 9 点", now, "Asia/Singapore")?.at).toBe("2026-08-16T01:00:00.000Z");
  });

  it("returns null when no time signal exists", () => {
    expect(parseNaturalTime("随手记一个想法", now, "Asia/Singapore")).toBeNull();
  });

  it("builds timezone-safe day and week ranges", () => {
    expect(localDayBounds(now, "Asia/Singapore")).toEqual({
      start: "2026-08-14T16:00:00.000Z",
      end: "2026-08-15T16:00:00.000Z",
    });
    expect(localWeekBounds(now, "Asia/Singapore", true)).toEqual({
      start: "2026-08-16T16:00:00.000Z",
      end: "2026-08-23T16:00:00.000Z",
    });
  });
});
