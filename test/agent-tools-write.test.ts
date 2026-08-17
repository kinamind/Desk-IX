import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AgentPrincipal } from "../src/agent/context";
import type { ReminderWorkflowPayload } from "../src/core/types";
import {
  manageOwnedReminder,
  manageOwnedWorkSessions,
  transitionOwnedItem,
  updateOwnedItem,
  updateOwnedProfile,
} from "../src/agent/tools/write";
import { createItem, getItem } from "../src/db/items";
import { listOwnedWorkSessions } from "../src/db/work-sessions";
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

  it("lets the Agent use any future reminder time and reports actual schedule conflicts", async () => {
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

    const reminderEnv: Env = {
      ...env,
      REMINDER_WORKFLOW: {
        create: async (options: WorkflowInstanceCreateOptions<ReminderWorkflowPayload> = {}) => ({
          id: options.id ?? "generated",
        }) as WorkflowInstance,
      } as Workflow<ReminderWorkflowPayload>,
    };
    const immediate = await manageOwnedReminder(reminderEnv, principal, {
      operation: "set",
      itemId: item.id,
      remindAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      kind: "deferred_action",
      allowConflict: false,
      timeSelection: "agent_selected",
    });
    expect(immediate.scheduled).toBe(true);

    const conflict = await manageOwnedReminder(env, principal, {
      operation: "set",
      itemId: item.id,
      remindAt: new Date(base).toISOString(),
      kind: "deferred_action",
      allowConflict: false,
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
      timeSelection: "user_exact",
    });
    expect(exact.scheduled).toBe(true);
    expect("conflictsAccepted" in exact ? exact.conflictsAccepted : 0).toBeGreaterThan(0);
  });

  it("does not invent a pre-meeting conflict window for a reminder", async () => {
    const meetingAt = Date.now() + 144 * 60 * 60_000;
    const target = await createItem(env.DB, {
      type: "task",
      title: "会前带材料",
      content: "在会议前提醒",
      rawMessage: "会前带材料",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "pre-meeting-reminder",
    });
    await createItem(env.DB, {
      type: "task",
      title: "项目会议",
      content: "固定会议",
      rawMessage: "项目会议",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "pre-meeting-event",
      dueAt: new Date(meetingAt).toISOString(),
      estimatedDuration: 60,
    });
    const reminderEnv: Env = {
      ...env,
      REMINDER_WORKFLOW: {
        create: async (options: WorkflowInstanceCreateOptions<ReminderWorkflowPayload> = {}) => ({
          id: options.id ?? "generated",
        }) as WorkflowInstance,
      } as Workflow<ReminderWorkflowPayload>,
    };

    await expect(manageOwnedReminder(reminderEnv, principal, {
      operation: "set",
      itemId: target.id,
      remindAt: new Date(meetingAt - 5 * 60_000).toISOString(),
      kind: "bring_materials",
      allowConflict: false,
      timeSelection: "agent_selected",
    })).resolves.toMatchObject({ scheduled: true });
  });

  it("persists model-selected work sessions and rejects overlapping plans", async () => {
    const base = Date.now() + 72 * 60 * 60_000;
    const first = await createItem(env.DB, {
      type: "task",
      title: "整理研究内容",
      content: "需要三小时",
      rawMessage: "整理研究内容",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "work-session-first",
    });
    const second = await createItem(env.DB, {
      type: "task",
      title: "撰写 proposal",
      content: "需要五小时",
      rawMessage: "撰写 proposal",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "work-session-second",
    });
    const firstStart = new Date(base).toISOString();
    const firstEnd = new Date(base + 2 * 60 * 60_000).toISOString();
    const laterStart = new Date(base + 3 * 60 * 60_000).toISOString();
    const laterEnd = new Date(base + 5 * 60 * 60_000).toISOString();

    await expect(manageOwnedWorkSessions(env, principal, {
      operation: "replace",
      itemId: first.id,
      sessions: [{ startAt: firstStart, endAt: firstEnd, label: "整理现状" }],
      rationale: "先完成较早截止的 update",
      timeSelection: "agent_selected",
      allowConflict: false,
    })).resolves.toMatchObject({ scheduled: true, sessionCount: 1, totalMinutes: 120 });

    const overlapping = await manageOwnedWorkSessions(env, principal, {
      operation: "replace",
      itemId: second.id,
      sessions: [{ startAt: firstStart, endAt: firstEnd }],
      rationale: "proposal 第一段",
      timeSelection: "agent_selected",
      allowConflict: false,
    });
    expect(overlapping).toMatchObject({ scheduled: false });
    expect("conflicts" in overlapping ? overlapping.conflicts[0]?.source : "").toBe("work_session");

    await expect(manageOwnedWorkSessions(env, principal, {
      operation: "replace",
      itemId: second.id,
      sessions: [{ startAt: laterStart, endAt: laterEnd, label: "proposal 框架" }],
      rationale: "避开已有工作段",
      timeSelection: "agent_selected",
      allowConflict: false,
    })).resolves.toMatchObject({ scheduled: true, sessionCount: 1 });

    await expect(listOwnedWorkSessions(env.DB, second.id, "qq", principal.userId)).resolves.toMatchObject([
      { startAt: laterStart, endAt: laterEnd, label: "proposal 框架", status: "planned" },
    ]);
  });

  it("rejects internally overlapping sessions and cancels sessions at terminal lifecycle", async () => {
    const base = Date.now() + 96 * 60 * 60_000;
    const item = await createItem(env.DB, {
      type: "task",
      title: "深度工作",
      content: "分段完成",
      rawMessage: "深度工作",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "work-session-lifecycle",
    });
    const start = new Date(base).toISOString();
    const middle = new Date(base + 60 * 60_000).toISOString();
    const end = new Date(base + 2 * 60 * 60_000).toISOString();

    const overlappingPlan = await manageOwnedWorkSessions(env, principal, {
      operation: "replace",
      itemId: item.id,
      sessions: [
        { startAt: start, endAt: end },
        { startAt: middle, endAt: end },
      ],
      rationale: "错误重叠方案",
      timeSelection: "agent_selected",
      allowConflict: false,
    });
    expect(overlappingPlan).toMatchObject({ scheduled: false });
    expect("reason" in overlappingPlan ? overlappingPlan.reason : "").toContain("overlap");

    await manageOwnedWorkSessions(env, principal, {
      operation: "replace",
      itemId: item.id,
      sessions: [{ startAt: start, endAt: middle }],
      rationale: "可执行的一段",
      timeSelection: "agent_selected",
      allowConflict: false,
    });
    await transitionOwnedItem(env, principal, { itemId: item.id, transition: "complete" });
    await expect(listOwnedWorkSessions(env.DB, item.id, "qq", principal.userId)).resolves.toMatchObject([
      { status: "canceled" },
    ]);
  });

  it("does not allow work-session writes through another user's item ID", async () => {
    const item = await createItem(env.DB, {
      type: "task",
      title: "别人的工作",
      content: "私有",
      rawMessage: "私有",
      sourceChannel: "qq",
      sourceUserId: "another-user",
      sourceMessageId: "private-work-session",
    });
    const start = Date.now() + 120 * 60 * 60_000;
    await expect(manageOwnedWorkSessions(env, principal, {
      operation: "replace",
      itemId: item.id,
      sessions: [{ startAt: new Date(start).toISOString(), endAt: new Date(start + 60 * 60_000).toISOString() }],
      rationale: "不应成功",
      timeSelection: "agent_selected",
      allowConflict: false,
    })).rejects.toThrow("not found");
  });
});
