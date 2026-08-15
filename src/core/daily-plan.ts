import { formatInTimeZone } from "date-fns-tz";
import { getConfig, isAIEnabled } from "../config";
import { OpenAICompatibleProvider } from "../ai/openai-compatible";
import { DAILY_PLAN_PROMPT } from "../ai/prompts";
import { getChannelAdapter } from "../channels/registry";
import { claimDailyPlanRun, failDailyPlanRun, finishDailyPlanRun } from "../db/daily-plan-runs";
import { searchItems } from "../db/items";
import { log } from "../observability/log";
import { localDate, localDayBounds, localTime } from "./time";
import type { Item } from "./types";

export function shouldRunDailyPlan(now: Date, timezone: string, configuredTime: string): boolean {
  return localTime(now, timezone) >= configuredTime;
}

export async function buildDailyPlan(env: Env, now = new Date(), fetcher: typeof fetch = fetch): Promise<string> {
  const config = getConfig(env);
  const items = await searchItems(env.DB, { statuses: ["open", "raw", "active"], limit: 50 });
  const fallback = deterministicPlan(items, now, config.timezone);
  if (!isAIEnabled(env) || items.length === 0) return fallback;

  try {
    const provider = new OpenAICompatibleProvider(env.DB, config, env.AI_API_KEY, fetcher, () => now);
    const response = await provider.generate({
      purpose: "daily_plan",
      maxTokens: 500,
      messages: [
        { role: "system", content: DAILY_PLAN_PROMPT },
        { role: "user", content: JSON.stringify({ date: localDate(now, config.timezone), timezone: config.timezone, items }) },
      ],
    });
    return response.text.slice(0, 2200);
  } catch (error) {
    log("warn", "daily_plan_ai_fallback", { error: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

export async function runDailyPlan(env: Env, now = new Date(), fetcher: typeof fetch = fetch, force = false): Promise<void> {
  const config = getConfig(env);
  if (!force && !shouldRunDailyPlan(now, config.timezone, config.dailyPlanTime)) return;
  if (config.dailyPlanTargets.length === 0) {
    log("warn", "daily_plan_no_targets");
    return;
  }

  const day = localDate(now, config.timezone);
  const claims = await Promise.all(config.dailyPlanTargets.map(async (target) => ({
    target,
    claimed: await claimDailyPlanRun(env.DB, day, target.channel, target.userId, now),
  })));
  const pending = claims.filter((entry) => entry.claimed);
  if (pending.length === 0) return;

  const content = await buildDailyPlan(env, now, fetcher);
  for (const { target } of pending) {
    try {
      const adapter = getChannelAdapter(env, target.channel, fetcher);
      await adapter.send(target, { text: content });
      await finishDailyPlanRun(env.DB, day, target.channel, target.userId, content, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failDailyPlanRun(env.DB, day, target.channel, target.userId, message, now);
      log("error", "daily_plan_delivery_failed", { channel: target.channel, userId: target.userId, error: message });
    }
  }
}

function deterministicPlan(items: Item[], now: Date, timezone: string): string {
  const today = localDayBounds(now, timezone);
  const weekEnd = new Date(new Date(today.end).getTime() + 6 * 86_400_000).toISOString();
  const must: Item[] = [];
  const should: Item[] = [];
  const ifTime: Item[] = [];

  for (const item of items) {
    if (item.priority === "urgent" || item.priority === "high" || (item.dueAt && item.dueAt < today.end)) must.push(item);
    else if (item.dueAt && item.dueAt <= weekEnd) should.push(item);
    else if (item.priority === "low" || item.type === "idea" || item.type === "resource") ifTime.push(item);
    else should.push(item);
  }

  const date = formatInTimeZone(now, timezone, "M/d");
  if (items.length === 0) return `${date} 今日安排\n\n今天没有未完成事项。`;
  const lines = [`${date} 今日安排`];
  appendSection(lines, "Must", must);
  appendSection(lines, "Should", should);
  appendSection(lines, "If time", ifTime);
  return lines.slice(0, 12).join("\n");
}

function appendSection(lines: string[], label: string, items: Item[]): void {
  if (items.length === 0) return;
  lines.push("", label);
  for (const item of items.slice(0, 3)) lines.push(`• ${item.title}`);
}
