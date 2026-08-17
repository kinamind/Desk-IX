import type { ScheduleWindow } from "./types";

interface AvailabilityOptions {
  now: Date;
  dueAt: string | null;
  targetItemId: string | null;
  schedule: ScheduleWindow[];
  avoidWindows: ScheduleWindow[];
}

export interface ReminderAvailability {
  reminderAt: string | null;
  adjusted: boolean;
  conflicts: string[];
}

function validWindow(window: ScheduleWindow): boolean {
  const start = new Date(window.startAt).getTime();
  const end = new Date(window.endAt).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

export function findAvailableReminderTime(
  proposedReminderAt: string,
  options: AvailabilityOptions,
): ReminderAvailability {
  const proposed = new Date(proposedReminderAt).getTime();
  if (!Number.isFinite(proposed)) return { reminderAt: null, adjusted: false, conflicts: [] };

  const dueTime = options.dueAt ? new Date(options.dueAt).getTime() : null;
  const windows = [...options.schedule, ...options.avoidWindows]
    .filter(validWindow)
    .filter((window) => window.itemId === null || window.itemId !== options.targetItemId)
    .sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime());
  const conflictTitles: string[] = [];
  let candidate = Math.max(proposed, options.now.getTime());

  for (const window of windows) {
    const start = new Date(window.startAt).getTime();
    const end = new Date(window.endAt).getTime();
    if (candidate >= start && candidate < end) {
      if (!conflictTitles.includes(window.title)) conflictTitles.push(window.title);
      candidate = end;
    }
  }
  if (dueTime !== null && candidate > dueTime) {
    return { reminderAt: null, adjusted: candidate !== proposed, conflicts: conflictTitles };
  }
  return {
    reminderAt: new Date(candidate).toISOString(),
    adjusted: candidate !== proposed,
    conflicts: conflictTitles,
  };
}
