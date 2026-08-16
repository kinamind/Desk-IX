import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AgentPrincipal } from "../src/agent/context";
import { manageOwnedReminder, transitionOwnedItem, updateOwnedItem } from "../src/agent/tools/write";
import { createItem, getItem } from "../src/db/items";

const principal: AgentPrincipal = {
  channel: "qq",
  userId: "qq-user-42",
  eventId: "agent-write-event",
  receivedAt: "2026-08-16T08:00:00.000Z",
};

describe("agent write capabilities", () => {
  it("enriches the same recruitment item with structured facts and provenance", async () => {
    const item = await createItem(env.DB, {
      type: "resource",
      title: "这个招聘信息帮我记录一下",
      content: "https://jobs.example/notice",
      rawMessage: "招聘信息",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "recruitment-to-update",
    });

    const result = await updateOwnedItem(env, principal, {
      itemId: item.id,
      title: "深圳理工大学人工智能研究院招聘",
      content: "招聘教学科研人员；申请材料包括简历、研究计划与代表作。",
      tags: ["招聘", "深圳理工大学", "人工智能"],
      primaryUrl: "https://jobs.example/notice",
      structuredData: {
        category: "recruitment",
        organizations: ["深圳理工大学人工智能研究院"],
        roles: ["教学科研人员"],
      },
      provenance: { sourceUrls: ["https://jobs.example/notice"] },
    });

    expect(result).toEqual({ updated: true, itemId: item.id });
    await expect(getItem(env.DB, item.id)).resolves.toMatchObject({
      id: item.id,
      title: "深圳理工大学人工智能研究院招聘",
      aiEnrichment: {
        category: "recruitment",
        organizations: ["深圳理工大学人工智能研究院"],
        roles: ["教学科研人员"],
      },
      metadata: { provenance: { sourceUrls: ["https://jobs.example/notice"] } },
    });
  });

  it("supports natural lifecycle operations without deleting the record", async () => {
    const item = await createItem(env.DB, {
      type: "task",
      title: "候选任务",
      content: "待决定",
      rawMessage: "待决定",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "transition-item",
    });

    await expect(transitionOwnedItem(env, principal, { itemId: item.id, transition: "abandon" })).resolves.toMatchObject({ status: "archived" });
    await expect(transitionOwnedItem(env, principal, { itemId: item.id, transition: "restore" })).resolves.toMatchObject({ status: "open" });
    await expect(getItem(env.DB, item.id)).resolves.toMatchObject({ id: item.id, status: "open" });
  });

  it("rejects meaningless immediate reminders and reports schedule conflicts", async () => {
    const base = Date.now() + 24 * 60 * 60_000;
    const item = await createItem(env.DB, {
      type: "task",
      title: "稍后研究数据",
      content: "暂时不做",
      rawMessage: "暂时不做",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "reminder-item",
    });
    await createItem(env.DB, {
      type: "task",
      title: "已有会议",
      content: "这一小时有事",
      rawMessage: "已有会议",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "busy-item",
      dueAt: new Date(base).toISOString(),
      estimatedDuration: 60,
    });

    const immediate = await manageOwnedReminder(env, principal, {
      operation: "set",
      itemId: item.id,
      remindAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      kind: "deferred_action",
      allowConflict: false,
      explicitImmediate: false,
    });
    expect(immediate.scheduled).toBe(false);
    expect("reason" in immediate ? immediate.reason : "").toContain("too immediate");

    const conflict = await manageOwnedReminder(env, principal, {
      operation: "set",
      itemId: item.id,
      remindAt: new Date(base).toISOString(),
      kind: "deferred_action",
      allowConflict: false,
      explicitImmediate: false,
    });
    expect(conflict.scheduled).toBe(false);
    expect("reason" in conflict ? conflict.reason : "").toContain("overlaps");
    expect("conflicts" in conflict ? conflict.conflicts[0]?.title : "").toBe("已有会议");
  });
});
