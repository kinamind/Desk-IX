import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getConfig } from "../../config";
import { findCalendarAvailability } from "../../core/calendar";
import { loadCalendarSnapshot } from "../../db/calendar";
import { ensureUserProfile } from "../../db/user-profiles";
import type { AgentPrincipal } from "../context";

type PrincipalProvider = () => AgentPrincipal;

const intervalSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

export async function calendarSnapshot(
  env: Env,
  principal: AgentPrincipal,
  input: z.infer<typeof intervalSchema>,
) {
  const config = getConfig(env);
  const profile = await ensureUserProfile(env.DB, principal.channel, principal.userId, {
    timezone: config.timezone,
    locale: config.locale,
    dailyPlanTime: config.dailyPlanTime,
  });
  const snapshot = await loadCalendarSnapshot(
    env.DB,
    principal.channel,
    principal.userId,
    input.from,
    input.to,
  );
  return { timezone: profile.timezone, ...snapshot };
}

export async function findOwnedAvailability(
  env: Env,
  principal: AgentPrincipal,
  input: {
    from: string;
    to: string;
    minimumMinutes: number;
    excludeItemIds: string[];
  },
) {
  const snapshot = await calendarSnapshot(env, principal, input);
  return {
    timezone: snapshot.timezone,
    ...findCalendarAvailability(
      snapshot.entries,
      snapshot.from,
      snapshot.to,
      input.minimumMinutes,
      input.excludeItemIds,
    ),
    conflicts: snapshot.conflicts,
  };
}

export function createCalendarTools(env: Env, principal: PrincipalProvider): ToolSet {
  return {
    calendar_snapshot: tool({
      description: "Return the current user's canonical internal calendar for an explicit interval. It keeps fixed events, deadlines, work sessions, and reminders distinct, marks which entries actually block time, and reports real overlaps. Use it for day/week agendas, schedule changes, review, and any request where time semantics matter.",
      inputSchema: intervalSchema,
      execute: (input) => calendarSnapshot(env, principal(), input),
    }),
    availability_find: tool({
      description: "Return every free interval of at least the requested duration inside an explicit range. It subtracts only fixed events and planned work sessions; deadlines and reminders stay visible but do not consume time. This tool performs interval math only and never ranks or selects a preferred slot for the Agent.",
      inputSchema: intervalSchema.extend({
        minimumMinutes: z.number().int().min(1).default(30),
        excludeItemIds: z.array(z.string().uuid()).default([]),
      }),
      execute: (input) => findOwnedAvailability(env, principal(), input),
    }),
  };
}
