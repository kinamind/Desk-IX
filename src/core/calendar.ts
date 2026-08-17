import type {
  CalendarAvailability,
  CalendarBusyInterval,
  CalendarConflict,
  CalendarEntry,
  CalendarInterval,
} from "./types";

interface NumericBusyInterval {
  start: number;
  end: number;
  entryIds: string[];
  itemIds: string[];
}

export function findCalendarConflicts(entries: CalendarEntry[]): CalendarConflict[] {
  const busy = entries
    .filter((entry): entry is CalendarEntry & { endAt: string } => entry.blocksTime && entry.endAt !== null)
    .map((entry) => ({
      entry,
      start: parseTime(entry.startAt, "calendar entry start"),
      end: parseTime(entry.endAt, "calendar entry end"),
    }))
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const conflicts: CalendarConflict[] = [];
  for (let leftIndex = 0; leftIndex < busy.length; leftIndex += 1) {
    const left = busy[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < busy.length; rightIndex += 1) {
      const right = busy[rightIndex]!;
      if (right.start >= left.end) break;
      const overlapStart = Math.max(left.start, right.start);
      const overlapEnd = Math.min(left.end, right.end);
      if (overlapEnd <= overlapStart) continue;
      conflicts.push({
        leftEntryId: left.entry.id,
        rightEntryId: right.entry.id,
        leftItemId: left.entry.itemId,
        rightItemId: right.entry.itemId,
        overlapStart: new Date(overlapStart).toISOString(),
        overlapEnd: new Date(overlapEnd).toISOString(),
      });
    }
  }
  return conflicts;
}

export function findCalendarAvailability(
  entries: CalendarEntry[],
  from: string,
  to: string,
  minimumMinutes: number,
  excludeItemIds: string[] = [],
): CalendarAvailability {
  const fromMs = parseTime(from, "availability start");
  const toMs = parseTime(to, "availability end");
  if (toMs <= fromMs) throw new Error("Availability end must be after its start");
  if (!Number.isFinite(minimumMinutes) || minimumMinutes <= 0) {
    throw new Error("Minimum availability duration must be positive");
  }
  const excluded = new Set(excludeItemIds);
  const rawBusy = entries.flatMap((entry): NumericBusyInterval[] => {
    if (!entry.blocksTime || !entry.endAt || excluded.has(entry.itemId)) return [];
    const start = Math.max(fromMs, parseTime(entry.startAt, "calendar entry start"));
    const end = Math.min(toMs, parseTime(entry.endAt, "calendar entry end"));
    if (end <= start) return [];
    return [{ start, end, entryIds: [entry.id], itemIds: [entry.itemId] }];
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const mergedBusy = mergeBusy(rawBusy);
  const available: CalendarInterval[] = [];
  let cursor = fromMs;
  for (const busy of mergedBusy) {
    appendGap(available, cursor, busy.start, minimumMinutes);
    cursor = Math.max(cursor, busy.end);
  }
  appendGap(available, cursor, toMs, minimumMinutes);
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    minimumMinutes,
    busy: mergedBusy.map(toBusyInterval),
    available,
  };
}

function mergeBusy(intervals: NumericBusyInterval[]): NumericBusyInterval[] {
  const merged: NumericBusyInterval[] = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end) {
      merged.push({ ...interval, entryIds: [...interval.entryIds], itemIds: [...interval.itemIds] });
      continue;
    }
    previous.end = Math.max(previous.end, interval.end);
    previous.entryIds.push(...interval.entryIds.filter((id) => !previous.entryIds.includes(id)));
    previous.itemIds.push(...interval.itemIds.filter((id) => !previous.itemIds.includes(id)));
  }
  return merged;
}

function appendGap(target: CalendarInterval[], start: number, end: number, minimumMinutes: number): void {
  const durationMinutes = (end - start) / 60_000;
  if (durationMinutes < minimumMinutes) return;
  target.push({
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    durationMinutes,
  });
}

function toBusyInterval(interval: NumericBusyInterval): CalendarBusyInterval {
  return {
    startAt: new Date(interval.start).toISOString(),
    endAt: new Date(interval.end).toISOString(),
    durationMinutes: (interval.end - interval.start) / 60_000,
    entryIds: interval.entryIds,
    itemIds: interval.itemIds,
  };
}

function parseTime(value: string, label: string): number {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new Error(`Invalid ${label}`);
  return time;
}
