import type { ScheduleWindow } from "./types";

const SLOT_MS = 15 * 60_000;
const RECOVERY_BUFFER_MS = 15 * 60_000;
const MAX_CONFLICT_PASSES = 100;

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

function roundUpToSlot(timestamp: number): number {
  return Math.ceil(timestamp / SLOT_MS) * SLOT_MS;
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

  for (let pass = 0; pass < MAX_CONFLICT_PASSES; pass += 1) {
    const candidateEnd = candidate + SLOT_MS;
    const conflicts = windows.filter((window) => {
      const start = new Date(window.startAt).getTime();
      const end = new Date(window.endAt).getTime();
      return candidate < end && candidateEnd > start;
    });
    if (conflicts.length === 0) {
      if (dueTime !== null && candidate > dueTime) {
        return { reminderAt: null, adjusted: candidate !== proposed, conflicts: conflictTitles };
      }
      return {
        reminderAt: new Date(candidate).toISOString(),
        adjusted: candidate !== proposed,
        conflicts: conflictTitles,
      };
    }

    for (const conflict of conflicts) {
      if (!conflictTitles.includes(conflict.title)) conflictTitles.push(conflict.title);
    }
    const latestEnd = Math.max(...conflicts.map((window) => new Date(window.endAt).getTime()));
    candidate = roundUpToSlot(latestEnd + RECOVERY_BUFFER_MS);
    if (dueTime !== null && candidate > dueTime) {
      return { reminderAt: null, adjusted: true, conflicts: conflictTitles };
    }
  }

  return { reminderAt: null, adjusted: true, conflicts: conflictTitles };
}
