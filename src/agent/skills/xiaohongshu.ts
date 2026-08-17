import { skills } from "@cloudflare/think";
import type { SkillManifestEntry, SkillSource } from "agents/skills";
import xiaohongshuOrganizeRaw from "./xiaohongshu-organize/SKILL.md";

export const XIAOHONGSHU_SKILL_NAMES = ["xiaohongshu-organize"] as const;

const parsed = skills.parseSkillMarkdown(xiaohongshuOrganizeRaw);
if (!parsed) throw new Error("Invalid bundled Desk-IX Xiaohongshu skill");

const entry: SkillManifestEntry = {
  ...parsed,
  rawContent: xiaohongshuOrganizeRaw,
  version: "1",
};

export const xiaohongshuSkillSource: SkillSource = skills.fromManifest({
  id: "desk-ix-xiaohongshu",
  fingerprint: "desk-ix-xiaohongshu-v1",
  skills: [entry],
});
