import { describe, expect, it } from "vitest";
import { resolveReminderWakeAt } from "../src/workflows/reminder";

describe("reminder workflow", () => {
  it("delivers without sleeping when the requested time is already past", () => {
    const now = Date.parse("2026-08-15T15:50:45.000Z");
    expect(resolveReminderWakeAt("2026-08-15T15:50:42.000Z", now)).toBeNull();
  });

  it("preserves a future wake time", () => {
    const now = Date.parse("2026-08-15T15:50:00.000Z");
    const future = "2026-08-16T02:00:00.000Z";
    expect(resolveReminderWakeAt(future, now)).toBe(Date.parse(future));
  });
});
