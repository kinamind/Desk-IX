export interface MilestoneSuggestion {
  label: string;
  remindAt: string;
}

const DAY = 86_400_000;

export function generateDeadlineMilestones(dueAt: string, now = new Date()): MilestoneSuggestion[] {
  const deadline = new Date(dueAt);
  if (Number.isNaN(deadline.getTime()) || deadline <= now) return [];

  const candidates = [
    { label: "开始准备", offset: 30 * DAY },
    { label: "完成主要工作", offset: 7 * DAY },
    { label: "最终检查", offset: DAY },
  ];

  return candidates
    .map(({ label, offset }) => ({ label, remindAt: new Date(deadline.getTime() - offset).toISOString() }))
    .filter(({ remindAt }) => new Date(remindAt) > now)
    .slice(0, 3);
}
