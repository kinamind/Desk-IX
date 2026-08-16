import {
  CHRONOTYPES,
  type ChannelName,
  type Chronotype,
  type UserPreferenceValue,
  type UserProfile,
  type UserProfileDefaults,
  type UserProfileUpdate,
} from "../core/types";

const clockPattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

interface UserProfileRow {
  channel: ChannelName;
  user_id: string;
  user_call_name: string | null;
  assistant_call_name: string;
  timezone: string;
  locale: string;
  daily_plan_enabled: number;
  daily_plan_time: string;
  chronotype: Chronotype;
  target_wake_time: string | null;
  target_sleep_time: string | null;
  routine_coaching: number;
  communication_style: string;
  preferences: string;
  created_at: string;
  updated_at: string;
}

export async function ensureUserProfile(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  defaults: UserProfileDefaults,
  now = new Date(),
): Promise<UserProfile> {
  assertTimezone(defaults.timezone);
  assertClock(defaults.dailyPlanTime, "daily plan time");
  const timestamp = now.toISOString();
  await db.prepare(`
    INSERT OR IGNORE INTO user_profiles (
      channel, user_id, timezone, locale, daily_plan_time, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    channel,
    userId,
    defaults.timezone,
    defaults.locale,
    defaults.dailyPlanTime,
    timestamp,
    timestamp,
  ).run();
  const profile = await getUserProfile(db, channel, userId);
  if (!profile) throw new Error("Failed to create user profile");
  return profile;
}

export async function getUserProfile(
  db: D1Database,
  channel: ChannelName,
  userId: string,
): Promise<UserProfile | null> {
  const row = await db.prepare(`
    SELECT * FROM user_profiles WHERE channel = ? AND user_id = ?
  `).bind(channel, userId).first<UserProfileRow>();
  return row ? mapUserProfile(row) : null;
}

export async function listEnabledDailyPlanProfiles(db: D1Database): Promise<UserProfile[]> {
  const result = await db.prepare(`
    SELECT * FROM user_profiles
    WHERE daily_plan_enabled = 1
    ORDER BY channel, user_id
  `).all<UserProfileRow>();
  return result.results.map(mapUserProfile);
}

export async function updateUserProfile(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  input: UserProfileUpdate,
  now = new Date(),
): Promise<UserProfile> {
  const current = await getUserProfile(db, channel, userId);
  if (!current) throw new Error("User profile not found");
  if (input.timezone !== undefined) assertTimezone(input.timezone);
  if (input.dailyPlanTime !== undefined) assertClock(input.dailyPlanTime, "daily plan time");
  if (input.targetWakeTime !== undefined && input.targetWakeTime !== null) assertClock(input.targetWakeTime, "target wake time");
  if (input.targetSleepTime !== undefined && input.targetSleepTime !== null) assertClock(input.targetSleepTime, "target sleep time");
  if (input.chronotype !== undefined && !CHRONOTYPES.includes(input.chronotype)) throw new Error("Invalid chronotype");

  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  const add = (column: string, value: string | number | null): void => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (input.userCallName !== undefined) add("user_call_name", normalizedNullable(input.userCallName));
  if (input.assistantCallName !== undefined) add("assistant_call_name", requiredText(input.assistantCallName, "assistant call name", 80));
  if (input.timezone !== undefined) add("timezone", input.timezone);
  if (input.locale !== undefined) add("locale", requiredText(input.locale, "locale", 40));
  if (input.dailyPlanEnabled !== undefined) add("daily_plan_enabled", input.dailyPlanEnabled ? 1 : 0);
  if (input.dailyPlanTime !== undefined) add("daily_plan_time", input.dailyPlanTime);
  if (input.chronotype !== undefined) add("chronotype", input.chronotype);
  if (input.targetWakeTime !== undefined) add("target_wake_time", input.targetWakeTime);
  if (input.targetSleepTime !== undefined) add("target_sleep_time", input.targetSleepTime);
  if (input.routineCoaching !== undefined) add("routine_coaching", input.routineCoaching ? 1 : 0);
  if (input.communicationStyle !== undefined) add("communication_style", requiredText(input.communicationStyle, "communication style", 500));
  if (input.preferences !== undefined) {
    add("preferences", JSON.stringify({ ...current.preferences, ...validatePreferences(input.preferences) }));
  }
  if (assignments.length === 0) return current;
  add("updated_at", now.toISOString());
  values.push(channel, userId);
  await db.prepare(`
    UPDATE user_profiles SET ${assignments.join(", ")}
    WHERE channel = ? AND user_id = ?
  `).bind(...values).run();
  const updated = await getUserProfile(db, channel, userId);
  if (!updated) throw new Error("User profile disappeared after update");
  return updated;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function assertTimezone(timezone: string): void {
  if (!isValidTimezone(timezone)) throw new Error("Invalid timezone");
}

function assertClock(value: string, label: string): void {
  if (!clockPattern.test(value)) throw new Error(`Invalid ${label}`);
}

function requiredText(value: string, label: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new Error(`Invalid ${label}`);
  return trimmed;
}

function normalizedNullable(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length > 80) throw new Error("Invalid user call name");
  return trimmed || null;
}

function validatePreferences(
  preferences: Record<string, UserPreferenceValue>,
): Record<string, UserPreferenceValue> {
  const entries = Object.entries(preferences);
  if (entries.length > 30) throw new Error("Too many profile preferences");
  for (const [key, value] of entries) {
    if (!key.trim() || key.length > 80) throw new Error("Invalid preference key");
    if (typeof value === "string" && value.length > 500) throw new Error("Preference text is too long");
    if (Array.isArray(value) && (value.length > 20 || value.some((entry) => entry.length > 200))) {
      throw new Error("Preference list is too large");
    }
  }
  return preferences;
}

function parsePreferences(value: string): Record<string, UserPreferenceValue> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isUnknownRecord(parsed)) return {};
    const result: Record<string, UserPreferenceValue> = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (
        entry === null
        || typeof entry === "string"
        || typeof entry === "number"
        || typeof entry === "boolean"
        || (Array.isArray(entry) && entry.every((item) => typeof item === "string"))
      ) result[key] = entry;
    }
    return result;
  } catch {
    return {};
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapUserProfile(row: UserProfileRow): UserProfile {
  return {
    channel: row.channel,
    userId: row.user_id,
    userCallName: row.user_call_name,
    assistantCallName: row.assistant_call_name,
    timezone: row.timezone,
    locale: row.locale,
    dailyPlanEnabled: row.daily_plan_enabled === 1,
    dailyPlanTime: row.daily_plan_time,
    chronotype: row.chronotype,
    targetWakeTime: row.target_wake_time,
    targetSleepTime: row.target_sleep_time,
    routineCoaching: row.routine_coaching === 1,
    communicationStyle: row.communication_style,
    preferences: parsePreferences(row.preferences),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
