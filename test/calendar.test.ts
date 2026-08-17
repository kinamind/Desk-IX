import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { findCalendarAvailability } from "../src/core/calendar";
import { loadCalendarSnapshot } from "../src/db/calendar";
import { createItem } from "../src/db/items";
import { createReminder } from "../src/db/reminders";
import { replaceWorkSessions } from "../src/db/work-sessions";

const now = new Date("2026-08-17T00:00:00.000Z");
const from = "2026-08-17T06:00:00.000Z";
const to = "2026-08-17T14:00:00.000Z";

describe("internal calendar", () => {
  it("builds a complete user-scoped snapshot without treating deadlines or reminders as busy time", async () => {
    const event = await createItem(env.DB, {
      type: "task",
      title: "研究组会",
      content: "固定安排",
      rawMessage: "研究组会",
      dueAt: "2026-08-17T08:00:00.000Z",
      estimatedDuration: 120,
      temporalRole: "event",
      sourceChannel: "qq",
      sourceUserId: "calendar-owner",
      sourceMessageId: "calendar-event",
    }, now);
    const deadline = await createItem(env.DB, {
      type: "task",
      title: "提交 proposal",
      content: "最晚中午提交",
      rawMessage: "最晚中午提交",
      dueAt: "2026-08-17T12:00:00.000Z",
      estimatedDuration: 180,
      temporalRole: "deadline",
      sourceChannel: "qq",
      sourceUserId: "calendar-owner",
      sourceMessageId: "calendar-deadline",
    }, now);
    await replaceWorkSessions(env.DB, deadline.id, [{
      startAt: "2026-08-17T09:00:00.000Z",
      endAt: "2026-08-17T11:00:00.000Z",
      label: "完善 proposal",
    }], "截止前推进", now);
    await createReminder(env.DB, {
      itemId: deadline.id,
      remindAt: "2026-08-17T07:00:00.000Z",
      kind: "deadline_warning",
      targetChannel: "qq",
      targetUserId: "calendar-owner",
    }, now);
    await createItem(env.DB, {
      type: "task",
      title: "其他用户的会议",
      content: "不可见",
      rawMessage: "不可见",
      dueAt: "2026-08-17T08:00:00.000Z",
      estimatedDuration: 60,
      temporalRole: "event",
      sourceChannel: "qq",
      sourceUserId: "other-user",
      sourceMessageId: "other-calendar-event",
    }, now);

    const snapshot = await loadCalendarSnapshot(env.DB, "qq", "calendar-owner", from, to);

    expect(snapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: event.id, kind: "event", blocksTime: true }),
      expect.objectContaining({ itemId: deadline.id, kind: "deadline", blocksTime: false, endAt: null }),
      expect.objectContaining({ itemId: deadline.id, kind: "work_session", blocksTime: true }),
      expect.objectContaining({ itemId: deadline.id, kind: "reminder", blocksTime: false, endAt: null }),
    ]));
    expect(snapshot.entries.some((entry) => entry.title === "其他用户的会议")).toBe(false);
    expect(snapshot.conflicts).toHaveLength(1);
    expect(snapshot.conflicts[0]).toMatchObject({
      overlapStart: "2026-08-17T09:00:00.000Z",
      overlapEnd: "2026-08-17T10:00:00.000Z",
    });
  });

  it("returns factual free intervals while leaving reminders and deadlines non-blocking", async () => {
    const event = await createItem(env.DB, {
      type: "task",
      title: "固定讨论",
      content: "08:00 到 10:00",
      rawMessage: "固定讨论",
      dueAt: "2026-08-17T08:00:00.000Z",
      estimatedDuration: 120,
      temporalRole: "event",
      sourceChannel: "qq",
      sourceUserId: "availability-owner",
      sourceMessageId: "availability-event",
    }, now);
    const task = await createItem(env.DB, {
      type: "task",
      title: "写报告",
      content: "中午截止",
      rawMessage: "写报告",
      dueAt: "2026-08-17T12:00:00.000Z",
      temporalRole: "deadline",
      sourceChannel: "qq",
      sourceUserId: "availability-owner",
      sourceMessageId: "availability-deadline",
    }, now);
    await replaceWorkSessions(env.DB, task.id, [{
      startAt: "2026-08-17T09:00:00.000Z",
      endAt: "2026-08-17T11:00:00.000Z",
    }], "推进报告", now);
    await createReminder(env.DB, {
      itemId: task.id,
      remindAt: "2026-08-17T07:00:00.000Z",
      kind: "reminder",
      targetChannel: "qq",
      targetUserId: "availability-owner",
    }, now);

    const snapshot = await loadCalendarSnapshot(env.DB, "qq", "availability-owner", from, to);
    const availability = findCalendarAvailability(snapshot.entries, from, to, 60);

    expect(availability.available).toEqual([
      { startAt: from, endAt: "2026-08-17T08:00:00.000Z", durationMinutes: 120 },
      { startAt: "2026-08-17T11:00:00.000Z", endAt: to, durationMinutes: 180 },
    ]);
    expect(findCalendarAvailability(snapshot.entries, from, to, 60, [event.id]).available).toEqual([
      { startAt: from, endAt: "2026-08-17T09:00:00.000Z", durationMinutes: 180 },
      { startAt: "2026-08-17T11:00:00.000Z", endAt: to, durationMinutes: 180 },
    ]);
  });

  it("calculates availability across midnight and rejects inverted ranges", () => {
    expect(findCalendarAvailability([{
      id: "night-event",
      itemId: "night-event-item",
      kind: "event",
      title: "跨午夜活动",
      startAt: "2026-08-17T23:00:00.000Z",
      endAt: "2026-08-18T01:00:00.000Z",
      blocksTime: true,
      temporalRole: "event",
    }], "2026-08-17T22:00:00.000Z", "2026-08-18T03:00:00.000Z", 60).available).toEqual([
      {
        startAt: "2026-08-17T22:00:00.000Z",
        endAt: "2026-08-17T23:00:00.000Z",
        durationMinutes: 60,
      },
      {
        startAt: "2026-08-18T01:00:00.000Z",
        endAt: "2026-08-18T03:00:00.000Z",
        durationMinutes: 120,
      },
    ]);
    expect(() => findCalendarAvailability([], to, from, 30)).toThrow("after");
  });
});
