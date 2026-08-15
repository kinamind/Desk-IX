import { describe, expect, it } from "vitest";
import { routeDeterministically } from "../src/core/intent-router";
import { generateDeadlineMilestones } from "../src/core/milestones";
import { buildQueryFilters } from "../src/core/query";

const now = new Date("2026-08-15T02:00:00.000Z");

describe("deterministic routing", () => {
  it("saves URLs without inventing deadlines", () => {
    const intent = routeDeterministically("保存 https://example.com/paper", now);
    expect(intent).toMatchObject({ intent: "create_item", type: "resource", url: "https://example.com/paper", dueAt: null });
  });

  it("extracts a reminder before AI is needed", () => {
    const intent = routeDeterministically("明天下午 3 点提醒我交报告", now);
    expect(intent).toMatchObject({ intent: "create_item", type: "task", reminderAt: "2026-08-16T07:00:00.000Z" });
  });

  it("routes explicit analysis separately", () => {
    expect(routeDeterministically("帮我展开分析一下这个想法", now)?.intent).toBe("analyze");
  });

  it("builds structured weekly query filters", () => {
    const filters = buildQueryFilters("这周还有哪些未完成项目？", now);
    expect(filters.type).toBe("project");
    expect(filters.statuses).toEqual(["open", "raw", "active"]);
    expect(filters.dueFrom).toBe("2026-08-09T16:00:00.000Z");
    expect(filters.dueTo).toBe("2026-08-16T16:00:00.000Z");
  });
});

describe("deadline milestones", () => {
  it("creates at most three future milestones", () => {
    expect(generateDeadlineMilestones("2026-10-15T02:00:00.000Z", now)).toEqual([
      { label: "开始准备", remindAt: "2026-09-15T02:00:00.000Z" },
      { label: "完成主要工作", remindAt: "2026-10-08T02:00:00.000Z" },
      { label: "最终检查", remindAt: "2026-10-14T02:00:00.000Z" },
    ]);
  });

  it("drops milestones already in the past", () => {
    expect(generateDeadlineMilestones("2026-08-17T02:00:00.000Z", now)).toEqual([
      { label: "最终检查", remindAt: "2026-08-16T02:00:00.000Z" },
    ]);
  });
});
