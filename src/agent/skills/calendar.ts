import { skills } from "@cloudflare/think";
import type { SkillManifestEntry, SkillSource } from "agents/skills";
import calendarManageRaw from "./calendar-manage/SKILL.md";
import calendarPlanRaw from "./calendar-plan/SKILL.md";
import calendarReadRaw from "./calendar-read/SKILL.md";
import calendarReviewRaw from "./calendar-review/SKILL.md";

export const CALENDAR_SKILL_NAMES = [
  "calendar-read",
  "calendar-plan",
  "calendar-manage",
  "calendar-review",
] as const;

const rawSkills = [calendarReadRaw, calendarPlanRaw, calendarManageRaw, calendarReviewRaw];
const manifestEntries = rawSkills.map(parseManifestEntry);

export const calendarSkillSource: SkillSource = skills.fromManifest({
  id: "desk-ix-calendar",
  fingerprint: "desk-ix-calendar-v1",
  skills: manifestEntries,
});

function parseManifestEntry(rawContent: string): SkillManifestEntry {
  const parsed = skills.parseSkillMarkdown(rawContent);
  if (!parsed) throw new Error("Invalid bundled Desk-IX calendar skill");
  return { ...parsed, rawContent, version: "1" };
}
