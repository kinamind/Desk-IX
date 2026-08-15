import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createItem, completeItem, getItem, searchItems } from "../src/db/items";
import { claimMessage, failMessage } from "../src/db/messages";
import { createReminder, markReminderFailed } from "../src/db/reminders";
import type { IncomingMessage } from "../src/core/types";

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
});
