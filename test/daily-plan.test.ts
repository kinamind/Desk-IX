import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildDailyPlan, listDueDailyPlanProfiles, shouldRunDailyPlan } from "../src/core/daily-plan";
import { claimDailyPlanRun, failDailyPlanRun } from "../src/db/daily-plan-runs";
import { createItem } from "../src/db/items";
import { ensureUserProfile, updateUserProfile } from "../src/db/user-profiles";

const now = new Date("2026-08-15T02:00:00.000Z");

describe("daily planning", () => {
  it("uses configured local time", () => {
    expect(shouldRunDailyPlan(new Date("2026-08-14T23:59:00.000Z"), "Asia/Singapore", "08:00")).toBe(false);
    expect(shouldRunDailyPlan(new Date("2026-08-15T00:00:00.000Z"), "Asia/Singapore", "08:00")).toBe(true);
    expect(shouldRunDailyPlan(new Date("2026-08-15T11:59:00.000Z"), "America/New_York", "08:00")).toBe(false);
    expect(shouldRunDailyPlan(new Date("2026-08-15T12:00:00.000Z"), "America/New_York", "08:00")).toBe(true);
  });

  it("builds a concise plan from real D1 items without AI", async () => {
    await createItem(env.DB, {
      type: "task",
      title: "今天提交报告",
      content: "今天提交报告",
      rawMessage: "今天提交报告",
      priority: "urgent",
      dueAt: "2026-08-15T07:00:00.000Z",
      sourceChannel: "telegram",
      sourceUserId: "42",
      sourceMessageId: "daily-must",
    }, now);
    await createItem(env.DB, {
      type: "idea",
      title: "整理研究想法",
      content: "整理研究想法",
      rawMessage: "整理研究想法",
      priority: "low",
      sourceChannel: "telegram",
      sourceUserId: "42",
      sourceMessageId: "daily-if-time",
    }, now);
    const plan = await buildDailyPlan(env, now);
    expect(plan).toContain("8/15 今日安排");
    expect(plan).toContain("Must\n• 今天提交报告");
    expect(plan).toContain("If time\n• 整理研究想法");
    expect(plan.split("\n").length).toBeLessThanOrEqual(12);
  });

  it("keeps each scheduled plan scoped to its own channel identity", async () => {
    await createItem(env.DB, {
      type: "task",
      title: "只属于 QQ 用户的任务",
      content: "QQ 私人事项",
      rawMessage: "QQ 私人事项",
      sourceChannel: "qq",
      sourceUserId: "qq-only",
      sourceMessageId: "daily-qq-private",
    }, now);
    await createItem(env.DB, {
      type: "task",
      title: "只属于 Telegram 用户的任务",
      content: "Telegram 私人事项",
      rawMessage: "Telegram 私人事项",
      sourceChannel: "telegram",
      sourceUserId: "telegram-only",
      sourceMessageId: "daily-telegram-private",
    }, now);

    const plan = await buildDailyPlan(env, now, fetch, { channel: "qq", userId: "qq-only" });

    expect(plan).toContain("只属于 QQ 用户的任务");
    expect(plan).not.toContain("只属于 Telegram 用户的任务");
  });

  it("selects each subscribed profile using its own timezone and preferred time", async () => {
    await ensureUserProfile(env.DB, "qq", "late-singapore", {
      timezone: "Asia/Singapore",
      locale: "zh-CN",
      dailyPlanTime: "11:00",
    });
    await ensureUserProfile(env.DB, "telegram", "new-york-morning", {
      timezone: "America/New_York",
      locale: "zh-CN",
      dailyPlanTime: "23:30",
    });
    await ensureUserProfile(env.DB, "qq", "disabled-plan", {
      timezone: "Asia/Singapore",
      locale: "zh-CN",
      dailyPlanTime: "08:00",
    });
    await updateUserProfile(env.DB, "qq", "disabled-plan", { dailyPlanEnabled: false });

    const due = await listDueDailyPlanProfiles(env, new Date("2026-08-15T03:15:00.000Z"));
    expect(due.map((profile) => profile.userId)).toContain("late-singapore");
    expect(due.map((profile) => profile.userId)).not.toContain("new-york-morning");
    expect(due.map((profile) => profile.userId)).not.toContain("disabled-plan");
  });

  it("personalizes the fallback plan with the profile's address and local date", async () => {
    await ensureUserProfile(env.DB, "qq", "personal-plan", {
      timezone: "America/New_York",
      locale: "zh-CN",
      dailyPlanTime: "11:00",
    });
    await updateUserProfile(env.DB, "qq", "personal-plan", { userCallName: "小王" });
    await createItem(env.DB, {
      type: "task",
      title: "准备下午的材料",
      content: "准备下午的材料",
      rawMessage: "准备下午的材料",
      sourceChannel: "qq",
      sourceUserId: "personal-plan",
      sourceMessageId: "personal-plan-item",
    }, now);

    const plan = await buildDailyPlan(
      env,
      new Date("2026-08-15T02:00:00.000Z"),
      fetch,
      { channel: "qq", userId: "personal-plan" },
    );
    expect(plan).toContain("小王，8/14 今日安排");
    expect(plan).toContain("准备下午的材料");
  });

  it("deduplicates a successful day and allows a failed retry", async () => {
    await expect(claimDailyPlanRun(env.DB, "2026-08-15", "telegram", "42", now)).resolves.toBe(true);
    await expect(claimDailyPlanRun(env.DB, "2026-08-15", "telegram", "42", now)).resolves.toBe(false);
    await failDailyPlanRun(env.DB, "2026-08-15", "telegram", "42", "temporary", now);
    await expect(claimDailyPlanRun(env.DB, "2026-08-15", "telegram", "42", now)).resolves.toBe(true);
  });

  it("does not slice a complete model-generated daily plan", async () => {
    const userId = "long-ai-plan";
    const longItemContent = `${"背景".repeat(300)}末尾关键限制：必须避开组会。`;
    await createItem(env.DB, {
      type: "task",
      title: "复杂的一天",
      content: longItemContent,
      rawMessage: "需要完整安排",
      sourceChannel: "qq",
      sourceUserId: userId,
      sourceMessageId: "long-ai-plan-item",
    }, now);
    const longPlan = "安排".repeat(1_500);
    let requestBody = "";
    const fetcher: typeof fetch = async (_input, init) => {
      requestBody = typeof init?.body === "string" ? init.body : "";
      return Response.json({
        model: "test-model",
        choices: [{ message: { content: longPlan } }],
      });
    };
    const aiEnv = {
      ...env,
      AI_API_KEY: "test-key",
      AI_MODEL: "test-model",
      AI_DAILY_REQUEST_LIMIT: "0",
    } as unknown as Env;

    const plan = await buildDailyPlan(aiEnv, now, fetcher, { channel: "qq", userId });
    expect(requestBody).toContain("末尾关键限制：必须避开组会");
    expect(plan).toBe(longPlan);
    expect(plan.length).toBe(3_000);
  });
});
