import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { archiveItem, createItem, completeItem, getItem, listAgentContextItems, mergeItemEnrichment, restoreItem, searchItems, searchOwnedItems, updateItem } from "../src/db/items";
import { claimMessage, failMessage } from "../src/db/messages";
import { createReminder, markReminderFailed } from "../src/db/reminders";
import { listScheduleWindows } from "../src/db/schedule";
import type { IncomingMessage } from "../src/core/types";
import { replaceWorkSessions } from "../src/db/work-sessions";

const now = new Date("2026-08-15T02:00:00.000Z");

describe("D1 repositories", () => {
  it("persists, searches, and completes items", async () => {
    const item = await createItem(env.DB, {
      type: "task",
      title: "提交报告 100%",
      content: "包含下划线_a",
      rawMessage: "提交报告",
      sourceChannel: "telegram",
      sourceUserId: "42",
      sourceMessageId: "event-1",
      dueAt: "2026-08-16T02:00:00.000Z",
    }, now);
    expect(await getItem(env.DB, item.id)).toMatchObject({ title: "提交报告 100%", status: "open" });
    expect(await searchItems(env.DB, { keyword: "100%" })).toHaveLength(1);
    expect(await searchItems(env.DB, { keyword: "_a" })).toHaveLength(1);
    await expect(searchItems(env.DB, { keyword: "\\%_".repeat(30_000) })).resolves.toEqual([]);
    await expect(completeItem(env.DB, item.id, now)).resolves.toBe(true);
    await expect(completeItem(env.DB, item.id, now)).resolves.toBe(false);
  });

  it("deduplicates processed messages and reclaims failures", async () => {
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:10",
      messageId: "10",
      userId: "42",
      text: "hello",
      timestamp: now.toISOString(),
      eventType: "message",
    };
    const first = await claimMessage(env.DB, incoming);
    expect(first.claimed).toBe(true);
    expect((await claimMessage(env.DB, incoming)).claimed).toBe(false);
    await failMessage(env.DB, first.id, "temporary", now);
    expect((await claimMessage(env.DB, incoming, now)).claimed).toBe(true);
  });

  it("reclaims a processing claim only after its lease is stale", async () => {
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:stale",
      messageId: "11",
      userId: "42",
      text: "hello",
      timestamp: now.toISOString(),
      eventType: "message",
    };
    expect((await claimMessage(env.DB, incoming, now)).claimed).toBe(true);
    expect((await claimMessage(env.DB, incoming, new Date(now.getTime() + 4 * 60_000))).claimed).toBe(false);
    expect((await claimMessage(env.DB, incoming, new Date(now.getTime() + 6 * 60_000))).claimed).toBe(true);
  });

  it("reclaims a reminder after transient workflow creation failure", async () => {
    const item = await createItem(env.DB, {
      type: "task",
      title: "提醒测试",
      content: "提醒测试",
      rawMessage: "提醒测试",
      sourceChannel: "qq",
      sourceUserId: "qq-user-42",
      sourceMessageId: "qq-1",
    }, now);
    const input = {
      itemId: item.id,
      remindAt: "2026-08-16T02:00:00.000Z",
      kind: "reminder",
      targetChannel: "qq" as const,
      targetUserId: "qq-user-42",
    };
    const first = await createReminder(env.DB, input, now);
    expect(first.created).toBe(true);
    await markReminderFailed(env.DB, first.reminder.id, "workflow unavailable");
    const retry = await createReminder(env.DB, input, now);
    expect(retry).toMatchObject({ created: true, reminder: { id: first.reminder.id, status: "pending" } });
  });

  it("scopes agent context and searches to the current user", async () => {
    await createItem(env.DB, {
      type: "note",
      title: "我的记录",
      content: "只属于我",
      rawMessage: "只属于我",
      sourceChannel: "qq",
      sourceUserId: "me",
      sourceMessageId: "scope-me",
    }, now);
    await createItem(env.DB, {
      type: "note",
      title: "别人的记录",
      content: "不应该暴露",
      rawMessage: "不应该暴露",
      sourceChannel: "qq",
      sourceUserId: "other",
      sourceMessageId: "scope-other",
    }, now);

    await expect(listAgentContextItems(env.DB, "qq", "me")).resolves.toMatchObject([{ title: "我的记录" }]);
    await expect(searchOwnedItems(env.DB, "qq", "me", { limit: 10 })).resolves.toMatchObject([{ title: "我的记录" }]);
  });

  it("updates, archives, and restores without deleting the item", async () => {
    const item = await createItem(env.DB, {
      type: "task",
      title: "原标题",
      content: "原内容",
      rawMessage: "原内容",
      sourceChannel: "qq",
      sourceUserId: "me",
      sourceMessageId: "lifecycle-item",
    }, now);
    await expect(updateItem(env.DB, item.id, { title: "新标题", dueAt: "2026-08-18T02:00:00.000Z" }, now)).resolves.toBe(true);
    await expect(archiveItem(env.DB, item.id, now)).resolves.toBe(true);
    await expect(restoreItem(env.DB, item.id, now)).resolves.toBe(true);
    await expect(getItem(env.DB, item.id)).resolves.toMatchObject({ title: "新标题", status: "open", dueAt: "2026-08-18T02:00:00.000Z" });
  });

  it("builds a user-scoped schedule from item times and pending reminders", async () => {
    const meeting = await createItem(env.DB, {
      type: "task",
      title: "下午会议",
      content: "下午会议",
      rawMessage: "下午会议",
      sourceChannel: "qq",
      sourceUserId: "me",
      sourceMessageId: "schedule-meeting",
      dueAt: "2026-08-15T06:30:00.000Z",
      estimatedDuration: 60,
    }, now);
    const task = await createItem(env.DB, {
      type: "task",
      title: "提交申请",
      content: "提交申请",
      rawMessage: "提交申请",
      sourceChannel: "qq",
      sourceUserId: "me",
      sourceMessageId: "schedule-reminder",
      dueAt: "2026-08-16T12:00:00.000Z",
    }, now);
    await createReminder(env.DB, {
      itemId: task.id,
      remindAt: "2026-08-15T05:00:00.000Z",
      kind: "deferred_action",
      targetChannel: "qq",
      targetUserId: "me",
    }, now);
    await createItem(env.DB, {
      type: "task",
      title: "别人的会议",
      content: "别人的会议",
      rawMessage: "别人的会议",
      sourceChannel: "qq",
      sourceUserId: "other",
      sourceMessageId: "schedule-other",
      dueAt: "2026-08-15T06:30:00.000Z",
    }, now);
    const ongoing = await createItem(env.DB, {
      type: "task",
      title: "正在进行的讨论",
      content: "1:30 开始，持续一小时",
      rawMessage: "1:30 开始，持续一小时",
      sourceChannel: "qq",
      sourceUserId: "me",
      sourceMessageId: "schedule-ongoing",
      dueAt: "2026-08-15T01:30:00.000Z",
      estimatedDuration: 60,
    }, now);
    await replaceWorkSessions(env.DB, task.id, [{
      startAt: "2026-08-15T08:00:00.000Z",
      endAt: "2026-08-15T09:30:00.000Z",
      label: "准备申请材料",
    }], "避开下午会议", now);

    const windows = await listScheduleWindows(env.DB, "qq", "me", now);
    expect(windows).toEqual(expect.arrayContaining([
      {
        itemId: task.id,
        title: "准备申请材料",
        startAt: "2026-08-15T08:00:00.000Z",
        endAt: "2026-08-15T09:30:00.000Z",
        source: "work_session",
      },
      {
        itemId: meeting.id,
        title: "下午会议",
        startAt: "2026-08-15T06:30:00.000Z",
        endAt: "2026-08-15T07:30:00.000Z",
        source: "item",
      },
      {
        itemId: task.id,
        title: "提交申请（提醒）",
        startAt: "2026-08-15T05:00:00.000Z",
        endAt: "2026-08-15T05:01:00.000Z",
        source: "reminder",
      },
      {
        itemId: ongoing.id,
        title: "正在进行的讨论",
        startAt: "2026-08-15T01:30:00.000Z",
        endAt: "2026-08-15T02:30:00.000Z",
        source: "item",
      },
    ]));
    expect(windows.some((window) => window.title === "别人的会议")).toBe(false);
  });

  it("keeps deadlines visible on items without pretending they occupy the calendar", async () => {
    const deadline = await createItem(env.DB, {
      type: "task",
      title: "提交 proposal",
      content: "20号之前完成",
      rawMessage: "20号之前完成",
      dueAt: "2026-08-20T12:00:00.000Z",
      estimatedDuration: 300,
      temporalRole: "deadline",
      sourceChannel: "qq",
      sourceUserId: "deadline-owner",
      sourceMessageId: "deadline-not-busy",
    }, now);

    await expect(getItem(env.DB, deadline.id)).resolves.toMatchObject({ temporalRole: "deadline" });
    const windows = await listScheduleWindows(env.DB, "qq", "deadline-owner", now, 7);
    expect(windows.some((window) => window.itemId === deadline.id)).toBe(false);
  });

  it("finds records by structured enrichment fields", async () => {
    const item = await createItem(env.DB, {
      type: "note",
      title: "研究院招聘",
      content: "三个来源页面",
      rawMessage: "记录一下",
      sourceChannel: "qq",
      sourceUserId: "enrichment-search-owner",
      sourceMessageId: "enrichment-search",
      aiEnrichment: {
        category: "recruitment",
        organizations: ["深圳理工大学人工智能研究院"],
        roles: ["教学科研人员"],
        locations: ["深圳"],
      },
    }, now);

    await expect(searchOwnedItems(env.DB, "qq", "enrichment-search-owner", {
      keyword: "教学科研人员",
      limit: 10,
    })).resolves.toMatchObject([{ id: item.id }]);
  });

  it("does not overwrite a user-set URL or deadline when promoting enrichment", async () => {
    const item = await createItem(env.DB, {
      type: "resource",
      title: "我自己的标题",
      content: "申请页面",
      rawMessage: "申请页面",
      url: "https://user.example/application",
      dueAt: "2026-09-01T12:00:00.000Z",
      tags: ["用户标签"],
      sourceChannel: "qq",
      sourceUserId: "enrichment-preserve-owner",
      sourceMessageId: "enrichment-preserve",
    }, now);

    await mergeItemEnrichment(env.DB, item.id, { category: "application" }, { fetch_status: "ok" }, {
      primaryUrl: "https://model.example/application",
      dueAtIfMissing: "2026-08-31T12:00:00.000Z",
      tags: ["用户标签", "申请"],
    }, now);

    await expect(getItem(env.DB, item.id)).resolves.toMatchObject({
      title: "我自己的标题",
      url: "https://user.example/application",
      dueAt: "2026-09-01T12:00:00.000Z",
      tags: ["用户标签", "申请"],
    });
  });
});
