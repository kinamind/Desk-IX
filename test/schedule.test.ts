import { describe, expect, it } from "vitest";
import { findAvailableReminderTime } from "../src/core/schedule";
import type { ScheduleWindow } from "../src/core/types";

const now = new Date("2026-08-16T05:56:00.000Z");

describe("conflict-aware reminder scheduling", () => {
  it("moves a reminder past an occupied event and a recovery buffer", () => {
    const schedule: ScheduleWindow[] = [{
      itemId: "busy-item",
      title: "两点半有事",
      startAt: "2026-08-16T06:15:00.000Z",
      endAt: "2026-08-16T07:30:00.000Z",
      source: "item",
    }];

    expect(findAvailableReminderTime("2026-08-16T06:45:00.000Z", {
      now,
      dueAt: "2026-08-16T15:59:59.000Z",
      targetItemId: "target-item",
      schedule,
      avoidWindows: [],
    })).toEqual({
      reminderAt: "2026-08-16T07:30:00.000Z",
      adjusted: true,
      conflicts: ["两点半有事"],
    });
  });

  it("does not let an item's own deadline or old reminder block its replacement", () => {
    const schedule: ScheduleWindow[] = [{
      itemId: "target-item",
      title: "报名 GOAIHZ",
      startAt: "2026-08-16T06:30:00.000Z",
      endAt: "2026-08-16T06:45:00.000Z",
      source: "reminder",
    }];

    expect(findAvailableReminderTime("2026-08-16T06:30:00.000Z", {
      now,
      dueAt: "2026-08-16T15:59:59.000Z",
      targetItemId: "target-item",
      schedule,
      avoidWindows: [],
    })).toEqual({
      reminderAt: "2026-08-16T06:30:00.000Z",
      adjusted: false,
      conflicts: [],
    });
  });

  it("returns no time when every next slot would miss the deadline", () => {
    const avoidWindows: ScheduleWindow[] = [{
      itemId: null,
      title: "今天余下时间已有安排",
      startAt: "2026-08-16T06:00:00.000Z",
      endAt: "2026-08-16T08:00:00.000Z",
      source: "message",
    }];

    expect(findAvailableReminderTime("2026-08-16T06:30:00.000Z", {
      now,
      dueAt: "2026-08-16T07:00:00.000Z",
      targetItemId: "target-item",
      schedule: [],
      avoidWindows,
    })).toEqual({ reminderAt: null, adjusted: true, conflicts: ["今天余下时间已有安排"] });
  });
});
