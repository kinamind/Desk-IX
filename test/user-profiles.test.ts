import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ensureUserProfile,
  getUserProfile,
  listEnabledDailyPlanProfiles,
  updateUserProfile,
} from "../src/db/user-profiles";

describe("user profiles", () => {
  it("creates a persistent default profile and keeps users isolated", async () => {
    const profile = await ensureUserProfile(env.DB, "qq", "profile-owner", {
      timezone: "Asia/Singapore",
      locale: "zh-CN",
      dailyPlanTime: "08:00",
    });

    expect(profile).toMatchObject({
      channel: "qq",
      userId: "profile-owner",
      assistantCallName: "拾序",
      timezone: "Asia/Singapore",
      dailyPlanEnabled: true,
      dailyPlanTime: "08:00",
      chronotype: "unknown",
      routineCoaching: false,
      preferences: {},
    });
    await expect(getUserProfile(env.DB, "telegram", "profile-owner")).resolves.toBeNull();
  });

  it("updates reversible relationship and planning preferences", async () => {
    await ensureUserProfile(env.DB, "qq", "profile-update", {
      timezone: "Asia/Singapore",
      locale: "zh-CN",
      dailyPlanTime: "08:00",
    });

    const updated = await updateUserProfile(env.DB, "qq", "profile-update", {
      userCallName: "小王",
      assistantCallName: "小九",
      timezone: "Asia/Tokyo",
      dailyPlanTime: "11:00",
      chronotype: "late",
      targetWakeTime: "09:30",
      targetSleepTime: "01:30",
      routineCoaching: true,
      communicationStyle: "像熟悉的长期搭档，直接但别催得太紧",
      preferences: { planningDensity: "light", weekendPlans: false },
    });

    expect(updated).toMatchObject({
      userCallName: "小王",
      assistantCallName: "小九",
      timezone: "Asia/Tokyo",
      dailyPlanTime: "11:00",
      chronotype: "late",
      targetWakeTime: "09:30",
      targetSleepTime: "01:30",
      routineCoaching: true,
      preferences: { planningDensity: "light", weekendPlans: false },
    });
  });

  it("lists only profiles subscribed to daily plans", async () => {
    await ensureUserProfile(env.DB, "qq", "plan-enabled", {
      timezone: "Asia/Singapore",
      locale: "zh-CN",
      dailyPlanTime: "11:00",
    });
    await ensureUserProfile(env.DB, "qq", "plan-disabled", {
      timezone: "Asia/Singapore",
      locale: "zh-CN",
      dailyPlanTime: "11:00",
    });
    await updateUserProfile(env.DB, "qq", "plan-disabled", { dailyPlanEnabled: false });

    const profiles = await listEnabledDailyPlanProfiles(env.DB);
    expect(profiles.map((profile) => profile.userId)).toContain("plan-enabled");
    expect(profiles.map((profile) => profile.userId)).not.toContain("plan-disabled");
  });

  it("rejects invalid timezones and clock values", async () => {
    await expect(ensureUserProfile(env.DB, "qq", "bad-zone", {
      timezone: "Mars/Olympus",
      locale: "zh-CN",
      dailyPlanTime: "08:00",
    })).rejects.toThrow("timezone");
    await ensureUserProfile(env.DB, "qq", "bad-clock", {
      timezone: "Asia/Singapore",
      locale: "zh-CN",
      dailyPlanTime: "08:00",
    });
    await expect(updateUserProfile(env.DB, "qq", "bad-clock", {
      dailyPlanTime: "25:00",
    })).rejects.toThrow("time");
  });
});
