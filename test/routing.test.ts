import { describe, expect, it } from "vitest";
import { routeMessage } from "../src/ai/intent";
import type { AIProvider } from "../src/ai/provider";
import { generateDeadlineMilestones } from "../src/core/milestones";

const now = new Date("2026-08-15T04:30:00.000Z");

function jsonProvider(payload: Record<string, unknown>, calls: string[]): AIProvider {
  return {
    generate: (request) => {
      calls.push(request.messages.at(-1)?.content ?? "");
      return Promise.resolve({ text: JSON.stringify(payload), model: "test-model", inputTokens: 10, outputTokens: 5 });
    },
  };
}

function sequenceProvider(payloads: Record<string, unknown>[], calls: string[]): AIProvider {
  return {
    generate: (request) => {
      calls.push(request.messages.at(-1)?.content ?? "");
      const payload = payloads.shift();
      if (!payload) throw new Error("No queued model response");
      return Promise.resolve({ text: JSON.stringify(payload), model: "test-model", inputTokens: 10, outputTokens: 5 });
    },
  };
}

describe("AI-first routing", () => {
  it("lets the model understand Chinese time and choose a transparent lead time", async () => {
    const calls: string[] = [];
    const intent = await routeMessage("下午三点约了一个被试面试验证，提前一会提醒我", jsonProvider({
      intent: "create_item",
      type: "task",
      title: "被试面试验证",
      content: "下午三点约了一个被试面试验证，提前一会提醒我",
      tags: null,
      priority: null,
      due_at: "2026-08-15T07:00:00.000Z",
      reminder_at: "2026-08-15T06:45:00.000Z",
      original_time_expression: "下午三点，提前一会",
      confidence: 0.94,
    }, calls), now);

    expect(calls).toHaveLength(1);
    expect(intent).toMatchObject({
      intent: "create_item",
      type: "task",
      dueAt: "2026-08-15T07:00:00.000Z",
      reminderAt: "2026-08-15T06:45:00.000Z",
      source: "ai",
    });
  });

  it("uses model-produced structured filters for natural-language retrieval", async () => {
    const intent = await routeMessage("这周还有哪些没完成的研究项目？", jsonProvider({
      intent: "query",
      query: {
        type: "project",
        statuses: ["open", "active"],
        due_from: "2026-08-09T16:00:00.000Z",
        due_to: "2026-08-16T16:00:00.000Z",
        keyword: "研究",
        limit: 10,
      },
      confidence: 0.92,
    }, []), now);

    expect(intent).toMatchObject({
      intent: "query",
      query: {
        type: "project",
        statuses: ["open", "active"],
        dueFrom: "2026-08-09T16:00:00.000Z",
        dueTo: "2026-08-16T16:00:00.000Z",
        keyword: "研究",
      },
    });
  });

  it("asks the model to replace a near-immediate deferred reminder with a useful future time", async () => {
    const calls: string[] = [];
    const base = {
      intent: "create_item",
      type: "task",
      title: "查看研究数据并回答问题",
      content: "这两天看一下研究数据，不能拖了",
      due_at: "2026-08-17T15:59:59.000Z",
      reminder_mode: "deferred_action",
      confidence: 0.94,
    };
    const intent = await routeMessage("这两天看一下研究数据，不能拖了", sequenceProvider([
      { ...base, reminder_at: "2026-08-15T04:30:05.000Z" },
      { ...base, reminder_at: "2026-08-16T02:00:00.000Z" },
    ], calls), now);

    expect(calls).toHaveLength(2);
    expect(intent).toMatchObject({
      reminderAt: "2026-08-16T02:00:00.000Z",
      reminderMode: "deferred_action",
    });
    expect(calls[1]).toContain("previous_result");
  });

  it("asks the model to add a missing reminder for an actionable task", async () => {
    const calls: string[] = [];
    const base = {
      intent: "create_item",
      type: "task",
      title: "回复研究问题",
      content: "回复研究问题",
      confidence: 0.9,
    };
    const intent = await routeMessage("回复研究问题", sequenceProvider([
      base,
      { ...base, reminder_at: "2026-08-15T06:00:00.000Z", reminder_mode: "deferred_action" },
    ], calls), now);

    expect(calls).toHaveLength(2);
    expect(intent).toMatchObject({ reminderAt: "2026-08-15T06:00:00.000Z", reminderMode: "deferred_action" });
  });

  it("keeps only the explicit help command outside the model", async () => {
    const calls: string[] = [];
    await expect(routeMessage("/help", jsonProvider({}, calls), now)).resolves.toMatchObject({ intent: "help", source: "system" });
    expect(calls).toHaveLength(0);
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
});
