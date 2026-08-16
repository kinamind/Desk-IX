import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildDailyPlan, shouldRunDailyPlan } from "../src/core/daily-plan";
import { claimDailyPlanRun, failDailyPlanRun } from "../src/db/daily-plan-runs";
import { createItem } from "../src/db/items";

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

  it("deduplicates a successful day and allows a failed retry", async () => {
    await expect(claimDailyPlanRun(env.DB, "2026-08-15", "telegram", "42", now)).resolves.toBe(true);
    await expect(claimDailyPlanRun(env.DB, "2026-08-15", "telegram", "42", now)).resolves.toBe(false);
    await failDailyPlanRun(env.DB, "2026-08-15", "telegram", "42", "temporary", now);
    await expect(claimDailyPlanRun(env.DB, "2026-08-15", "telegram", "42", now)).resolves.toBe(true);
  });
});
