import { addDays, addWeeks, getDay, startOfDay } from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

export function localDate(now: Date, timezone: string): string {
  return formatInTimeZone(now, timezone, "yyyy-MM-dd");
}

export function localTime(now: Date, timezone: string): string {
  return formatInTimeZone(now, timezone, "HH:mm");
}

export function localDayBounds(now: Date, timezone: string, offsetDays = 0): { start: string; end: string } {
  const local = addDays(startOfDay(toZonedTime(now, timezone)), offsetDays);
  return {
    start: fromZonedTime(local, timezone).toISOString(),
    end: fromZonedTime(addDays(local, 1), timezone).toISOString(),
  };
}

export function localWeekBounds(now: Date, timezone: string, next = false): { start: string; end: string } {
  const local = startOfDay(toZonedTime(now, timezone));
  const weekday = getDay(local);
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  const monday = addWeeks(addDays(local, -daysSinceMonday), next ? 1 : 0);
  return {
    start: fromZonedTime(monday, timezone).toISOString(),
    end: fromZonedTime(addDays(monday, 7), timezone).toISOString(),
  };
}
