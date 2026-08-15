import {
  addDays,
  addHours,
  addMinutes,
  addMonths,
  addWeeks,
  endOfMonth,
  getDay,
  isBefore,
  set,
  startOfDay,
} from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import type { ParsedTime } from "./types";

const WEEKDAYS: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

interface Clock {
  hour: number;
  minute: number;
  defaulted: boolean;
}

function parseClock(text: string): Clock {
  const colon = text.match(/(?:上午|早上|下午|晚上|今晚|中午)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
  const hourWord = text.match(/(上午|早上|下午|晚上|今晚|中午)?\s*(\d{1,2})\s*点\s*(半|\d{1,2}分?)?/);
  const period = text.match(/明天上午|明天早上|上午|早上|明天下午|下午|今晚|晚上|中午/)?.[0] ?? "";

  if (colon) {
    let hour = Number(colon[1]);
    const minute = Number(colon[2]);
    const prefix = colon[0];
    if (/下午|晚上|今晚/.test(prefix) && hour < 12) hour += 12;
    if (/中午/.test(prefix) && hour < 11) hour += 12;
    return { hour: Math.min(hour, 23), minute: Math.min(minute, 59), defaulted: false };
  }

  if (hourWord) {
    let hour = Number(hourWord[2]);
    const prefix = hourWord[1] ?? "";
    if (/下午|晚上|今晚/.test(prefix) && hour < 12) hour += 12;
    if (/中午/.test(prefix) && hour < 11) hour += 12;
    const rawMinute = hourWord[3];
    const minute = rawMinute === "半" ? 30 : Number.parseInt(rawMinute ?? "0", 10);
    return { hour: Math.min(hour, 23), minute: Math.min(minute, 59), defaulted: false };
  }

  if (/上午|早上/.test(period)) return { hour: 9, minute: 0, defaulted: true };
  if (/下午/.test(period)) return { hour: 15, minute: 0, defaulted: true };
  if (/今晚|晚上/.test(period)) return { hour: 20, minute: 0, defaulted: true };
  if (/中午/.test(period)) return { hour: 12, minute: 0, defaulted: true };
  return { hour: 9, minute: 0, defaulted: true };
}

function localToUtc(localDate: Date, timezone: string): string {
  return fromZonedTime(localDate, timezone).toISOString();
}

function withClock(date: Date, clock: Clock): Date {
  return set(date, { hours: clock.hour, minutes: clock.minute, seconds: 0, milliseconds: 0 });
}

function result(date: Date, timezone: string, expression: string, clock: Clock, confidence: ParsedTime["confidence"]): ParsedTime {
  return {
    at: localToUtc(withClock(date, clock), timezone),
    originalExpression: expression.trim(),
    confidence,
    defaultedTime: clock.defaulted,
  };
}

function applyLeadOffset(date: Date, text: string): Date {
  if (/提前\s*(?:一个月|1\s*个?月)|(?:deadline|截止)\s*前\s*(?:一个月|1\s*个?月)/i.test(text)) {
    return addMonths(date, -1);
  }
  if (/提前\s*(?:一周|1\s*个?周)|(?:deadline|截止)\s*前\s*(?:一周|1\s*个?周)/i.test(text)) {
    return addDays(date, -7);
  }
  if (/提前\s*(?:一天|1\s*天)|(?:deadline|截止)\s*前\s*(?:一天|1\s*天)/i.test(text)) {
    return addDays(date, -1);
  }
  return date;
}

export function parseNaturalTime(text: string, now = new Date(), timezone = "Asia/Singapore"): ParsedTime | null {
  const localNow = toZonedTime(now, timezone);

  const halfHour = text.match(/半\s*(?:个)?\s*小时(?:以|之)?后/);
  if (halfHour) {
    return {
      at: addMinutes(now, 30).toISOString(),
      originalExpression: halfHour[0],
      confidence: "high",
      defaultedTime: false,
    };
  }

  const duration = text.match(/(\d+(?:\.\d+)?)\s*(?:个)?\s*(小时|分钟)(?:以|之)?后/i);
  if (duration) {
    const amount = Number(duration[1]);
    const at = duration[2] === "小时" ? addMinutes(now, Math.round(amount * 60)) : addMinutes(now, Math.round(amount));
    return {
      at: at.toISOString(),
      originalExpression: duration[0],
      confidence: "high",
      defaultedTime: false,
    };
  }

  const englishDuration = text.match(/(?:in\s+)?(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)\s*(?:later)?/i);
  if (englishDuration && /\bin\b|later/i.test(englishDuration[0])) {
    const amount = Number(englishDuration[1]);
    const at = /^h/i.test(englishDuration[2] ?? "") ? addHours(now, amount) : addMinutes(now, amount);
    return {
      at: at.toISOString(),
      originalExpression: englishDuration[0],
      confidence: "high",
      defaultedTime: false,
    };
  }

  const clock = parseClock(text);
  const absolute = text.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (absolute) {
    let year = absolute[1] ? Number(absolute[1]) : localNow.getFullYear();
    let date = new Date(localNow);
    date = set(date, { year, month: Number(absolute[2]) - 1, date: Number(absolute[3]) });
    date = withClock(date, clock);
    if (!absolute[1] && isBefore(date, localNow)) {
      year += 1;
      date = set(date, { year });
    }
    date = applyLeadOffset(date, text);
    return result(date, timezone, absolute[0] + (clock.defaulted ? "" : text.slice(absolute.index! + absolute[0].length)), clock, "high");
  }

  const numericDate = text.match(/(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})(?!\d)/);
  if (numericDate) {
    let year = numericDate[1] ? Number(numericDate[1]) : localNow.getFullYear();
    let date = set(new Date(localNow), { year, month: Number(numericDate[2]) - 1, date: Number(numericDate[3]) });
    date = withClock(date, clock);
    if (!numericDate[1] && isBefore(date, localNow)) {
      year += 1;
      date = set(date, { year });
    }
    date = applyLeadOffset(date, text);
    return result(date, timezone, numericDate[0], clock, "high");
  }

  if (/月底/.test(text)) {
    let date = endOfMonth(localNow);
    if (isBefore(withClock(date, clock), localNow)) date = endOfMonth(addDays(date, 1));
    return result(date, timezone, "月底", clock, "medium");
  }

  if (/大后天/.test(text)) return result(addDays(startOfDay(localNow), 3), timezone, "大后天", clock, "high");
  if (/后天/.test(text)) return result(addDays(startOfDay(localNow), 2), timezone, "后天", clock, "high");
  if (/明天|tomorrow/i.test(text)) return result(addDays(startOfDay(localNow), 1), timezone, text.match(/明天(?:上午|早上|下午|晚上)?|tomorrow/i)?.[0] ?? "明天", clock, "high");
  if (/今晚|今天|today/i.test(text)) {
    const todayClock = /今晚/.test(text) && clock.defaulted ? { hour: 20, minute: 0, defaulted: true } : clock;
    let date = withClock(startOfDay(localNow), todayClock);
    if (isBefore(date, localNow) && /今晚/.test(text)) date = addDays(date, 1);
    return result(date, timezone, text.match(/今晚|今天|today/i)?.[0] ?? "今天", todayClock, "high");
  }

  const weekday = text.match(/(下周|下星期)?(?:周|星期)([一二三四五六日天])/);
  if (weekday) {
    const target = WEEKDAYS[weekday[2] ?? "一"] ?? 1;
    const current = getDay(localNow);
    let days: number;
    if (weekday[1]) {
      const daysToNextMonday = ((1 - current + 7) % 7) || 7;
      const offsetFromMonday = target === 0 ? 6 : target - 1;
      days = daysToNextMonday + offsetFromMonday;
    } else {
      days = (target - current + 7) % 7;
      if (days === 0 && isBefore(withClock(startOfDay(localNow), clock), localNow)) days = 7;
    }
    return result(addDays(startOfDay(localNow), days), timezone, weekday[0], clock, "high");
  }

  if (/下周|下星期|next week/i.test(text)) {
    const current = getDay(localNow);
    const daysToMonday = ((1 - current + 7) % 7) || 7;
    return result(addDays(startOfDay(localNow), daysToMonday), timezone, text.match(/下周|下星期|next week/i)?.[0] ?? "下周", clock, "medium");
  }

  if (!clock.defaulted) {
    let date = withClock(startOfDay(localNow), clock);
    if (isBefore(date, localNow)) date = addDays(date, 1);
    return result(date, timezone, text.match(/(?:上午|早上|下午|晚上|今晚|中午)?\s*\d{1,2}\s*(?::\s*\d{2}|点(?:半|\d{1,2}分?)?)/)?.[0] ?? text, clock, "medium");
  }

  return null;
}

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
