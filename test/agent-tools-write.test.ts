import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AgentPrincipal } from "../src/agent/context";
import type { ReminderWorkflowPayload } from "../src/core/types";
import { manageOwnedReminder, transitionOwnedItem, updateOwnedItem, updateOwnedProfile } from "../src/agent/tools/write";
import { createItem, getItem } from "../src/db/items";
import { ensureUserProfile, getUserProfile } from "../src/db/user-profiles";

const principal: AgentPrincipal = {
  channel: "qq",
  userId: "qq-user-42",
  eventId: "agent-write-event",
  receivedAt: "2026-08-16T08:00:00.000Z",
};

describe("agent write capabilities", () => {
  it("updates only the authenticated user's persistent assistant profile", async () => {
    await ensureUserProfile(env.DB, principal.channel, principal.userId, {
      timezone: "Asia/Singapore",
      locale: "zh-CN",
      dailyPlanTime: "08:00",
    });
    await ensureUserProfile(env.DB, principal.channel, "someone-else", {
      timezone: "UTC",
      locale: "zh-CN",
      dailyPlanTime: "08:00",
    });

    const updated = await updateOwnedProfile(env, principal, {
      assistantCallName: "小九",
      dailyPlanTime: "11:00",
      chronotype: "late",
      routineCoaching: true,
      preferences: { planningDensity: "light" },
    });

    expect(updated.profile).toMatchObject({
      assistantCallName: "小九",
      dailyPlanTime: "11:00",
      chronotype: "late",
      routineCoaching: true,
    });
    await expect(getUserProfile(env.DB, principal.channel, "someone-else")).resolves.toMatchObject({
      timezone: "UTC",
      assistantCallName: "拾序",
    });
  });

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
      timeSelection: "agent_selected",
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
      timeSelection: "agent_selected",
    });
    expect(conflict.scheduled).toBe(false);
    expect("reason" in conflict ? conflict.reason : "").toContain("overlaps");
    expect("conflicts" in conflict ? conflict.conflicts[0]?.title : "").toBe("已有会议");
  });

  it("does not let an agent-selected broad time override a collision", async () => {
    const base = Date.now() + 48 * 60 * 60_000;
    const item = await createItem(env.DB, {
      type: "task",
      title: "下午处理材料",
      content: "下午提醒，具体时间由 Desk-IX 选择",
      rawMessage: "下午提醒我",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "broad-time-target",
    });
    await createItem(env.DB, {
      type: "task",
      title: "下午已有安排",
      content: "占用这一小时",
      rawMessage: "已有安排",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "broad-time-conflict",
      dueAt: new Date(base).toISOString(),
      estimatedDuration: 60,
    });

    const broad = await manageOwnedReminder(env, principal, {
      operation: "set",
      itemId: item.id,
      remindAt: new Date(base).toISOString(),
      kind: "deferred_action",
      allowConflict: true,
      explicitImmediate: false,
      timeSelection: "agent_selected",
    });
    expect(broad.scheduled).toBe(false);
    expect("reason" in broad ? broad.reason : "").toContain("broad or agent-selected");

    const reminderEnv: Env = {
      ...env,
      REMINDER_WORKFLOW: {
        create: async (options: WorkflowInstanceCreateOptions<ReminderWorkflowPayload> = {}) => ({
          id: options.id ?? "generated",
        }) as WorkflowInstance,
      } as Workflow<ReminderWorkflowPayload>,
    };
    const exact = await manageOwnedReminder(reminderEnv, principal, {
      operation: "set",
      itemId: item.id,
      remindAt: new Date(base).toISOString(),
      kind: "deferred_action",
      allowConflict: true,
      explicitImmediate: false,
      timeSelection: "user_exact",
    });
    expect(exact.scheduled).toBe(true);
    expect("conflictsAccepted" in exact ? exact.conflictsAccepted : 0).toBeGreaterThan(0);
  });
});
