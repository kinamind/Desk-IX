import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Schedule } from "agents";
import type { AgentPrincipal } from "../src/agent/context";
import {
  buildLifecycleReviewMessage,
  isLifecycleFollowupSchedule,
  type LifecycleFollowupController,
} from "../src/agent/followups";
import {
  manageOwnedLifecycleFollowup,
  transitionOwnedItem,
} from "../src/agent/tools/write";
import { createItem } from "../src/db/items";

const principal: AgentPrincipal = {
  channel: "qq",
  userId: "qq-user-42",
  eventId: "followup-event",
  receivedAt: "2026-08-17T05:00:00.000Z",
};

describe("agent-owned lifecycle follow-ups", () => {
  it("matches only the exact callback and item payload", () => {
    const itemId = "10000000-0000-4000-8000-000000000001";
    const otherItemId = "10000000-0000-4000-8000-000000000002";
    const matching = {
      id: "schedule-1",
      callback: "reviewScheduledItem",
      payload: {
        itemId,
        channel: "qq",
        userId: "user-1",
        reviewAt: "2026-08-17T08:00:00.000Z",
        reason: "review this item",
      },
      type: "scheduled",
      time: 1_787_000_000,
    } satisfies Schedule<unknown>;
    expect(isLifecycleFollowupSchedule(matching, itemId)).toBe(true);
    expect(isLifecycleFollowupSchedule(matching, otherItemId)).toBe(false);
    expect(isLifecycleFollowupSchedule({ ...matching, callback: "anotherCallback" }, itemId)).toBe(false);
    expect(isLifecycleFollowupSchedule({ ...matching, payload: "not-an-object" }, itemId)).toBe(false);
  });

  it("builds a review turn that leaves the decision to the Agent", async () => {
    const meeting = await createItem(env.DB, {
      type: "task",
      title: "和 Amiya 开会",
      content: "讨论迁移进度",
      rawMessage: "今晚十点开会",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "meeting-review",
      dueAt: "2026-08-17T14:00:00.000Z",
    });
    const prompt = buildLifecycleReviewMessage(meeting, {
      itemId: meeting.id,
      channel: principal.channel,
      userId: principal.userId,
      reviewAt: "2026-08-17T15:00:00.000Z",
      reason: "安排结束后判断是否自然完成，或是否还有迁移跟进",
    }, new Date("2026-08-17T15:00:00.000Z"));

    expect(prompt).toContain("系统触发的生命周期复盘");
    expect(prompt).toContain("不是用户声称");
    expect(prompt).toContain("发生确定性");
    expect(prompt).toContain("结果确定性");
    expect(prompt).toContain("可以标记完成并告知");
    expect(prompt).toContain("保持原状态并简短询问");
    expect(prompt).toContain("后续事项");
    expect(prompt).not.toContain("会议一律完成");
  });

  it("verifies ownership, schedules reviews, and cancels them on terminal transitions", async () => {
    const reviewAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const item = await createItem(env.DB, {
      type: "task",
      title: "固定安排",
      content: "结束后复盘",
      rawMessage: "安排一下",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "followup-owned-item",
    });
    const set = vi.fn<LifecycleFollowupController["set"]>().mockResolvedValue({
      scheduled: true,
      scheduleId: "schedule-1",
      reviewAt,
    });
    const cancel = vi.fn<LifecycleFollowupController["cancel"]>().mockResolvedValue({ canceled: 1 });
    const controller: LifecycleFollowupController = { set, cancel };

    await expect(manageOwnedLifecycleFollowup(env, principal, {
      operation: "set",
      itemId: item.id,
      reviewAt,
      reason: "到点后结合上下文判断是否结束",
    }, controller)).resolves.toMatchObject({ scheduled: true, scheduleId: "schedule-1" });
    expect(set).toHaveBeenCalledWith({
      itemId: item.id,
      channel: principal.channel,
      userId: principal.userId,
      reviewAt,
      reason: "到点后结合上下文判断是否结束",
    });

    await transitionOwnedItem(env, principal, { itemId: item.id, transition: "complete" }, controller);
    expect(cancel).toHaveBeenCalledWith(item.id);

    await expect(manageOwnedLifecycleFollowup(env, { ...principal, userId: "someone-else" }, {
      operation: "cancel",
      itemId: item.id,
    }, controller)).rejects.toThrow("Item not found");
  });
});
