import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AgentPrincipal } from "../src/agent/context";
import { calendarSnapshot, findOwnedAvailability } from "../src/agent/tools/calendar";
import { createItem } from "../src/db/items";
import { ensureUserProfile } from "../src/db/user-profiles";

const principal: AgentPrincipal = {
  channel: "qq",
  userId: "calendar-tool-owner",
  eventId: "calendar-tool-event",
  receivedAt: "2026-08-17T00:00:00.000Z",
};

describe("Agent calendar tools", () => {
  it("returns a timezone-aware canonical snapshot and actual conflicts", async () => {
    await ensureUserProfile(env.DB, principal.channel, principal.userId, {
      timezone: "Asia/Singapore",
      locale: "zh-CN",
      dailyPlanTime: "11:00",
    });
    await createItem(env.DB, {
      type: "task",
      title: "第一场讨论",
      content: "固定安排",
      rawMessage: "第一场讨论",
      dueAt: "2026-08-18T05:00:00.000Z",
      estimatedDuration: 120,
      temporalRole: "event",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "calendar-tool-first",
    });
    await createItem(env.DB, {
      type: "task",
      title: "第二场讨论",
      content: "部分重叠",
      rawMessage: "第二场讨论",
      dueAt: "2026-08-18T06:00:00.000Z",
      estimatedDuration: 120,
      temporalRole: "event",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "calendar-tool-second",
    });

    const result = await calendarSnapshot(env, principal, {
      from: "2026-08-18T00:00:00.000Z",
      to: "2026-08-19T00:00:00.000Z",
    });

    expect(result.timezone).toBe("Asia/Singapore");
    expect(result.entries).toHaveLength(2);
    expect(result.conflicts).toHaveLength(1);
  });

  it("finds every qualifying gap without ranking or imposing a day-length cap", async () => {
    await ensureUserProfile(env.DB, principal.channel, principal.userId, {
      timezone: "Asia/Singapore",
      locale: "zh-CN",
      dailyPlanTime: "11:00",
    });
    await createItem(env.DB, {
      type: "task",
      title: "中间的会议",
      content: "占用两小时",
      rawMessage: "中间的会议",
      dueAt: "2026-08-20T04:00:00.000Z",
      estimatedDuration: 120,
      temporalRole: "event",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "calendar-tool-gap",
    });

    const result = await findOwnedAvailability(env, principal, {
      from: "2026-08-20T00:00:00.000Z",
      to: "2026-09-20T00:00:00.000Z",
      minimumMinutes: 60,
      excludeItemIds: [],
    });

    expect(result.timezone).toBe("Asia/Singapore");
    expect(result.available[0]).toEqual({
      startAt: "2026-08-20T00:00:00.000Z",
      endAt: "2026-08-20T04:00:00.000Z",
      durationMinutes: 240,
    });
    expect(result.available.at(-1)?.endAt).toBe("2026-09-20T00:00:00.000Z");
    expect(result.busy).toHaveLength(1);
  });
});
