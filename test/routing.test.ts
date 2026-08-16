import { describe, expect, it } from "vitest";
import { resolveScheduleChange, routeMessage } from "../src/ai/intent";
import type { AIProvider } from "../src/ai/provider";
import type { Item, ScheduleWindow } from "../src/core/types";
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
      intent: "act",
      actions: [{
        action: "create_item",
        type: "task",
        title: "被试面试验证",
        content: "下午三点约了一个被试面试验证，提前一会提醒我",
        tags: null,
        priority: null,
        due_at: "2026-08-15T07:00:00.000Z",
        reminder_at: "2026-08-15T06:45:00.000Z",
        reminder_mode: "pre_event",
        original_time_expression: "下午三点，提前一会",
      }],
      confidence: 0.94,
    }, calls), now);

    expect(calls).toHaveLength(1);
    expect(intent).toMatchObject({
      intent: "act",
      actions: [{
        action: "create_item",
        type: "task",
        dueAt: "2026-08-15T07:00:00.000Z",
        reminderAt: "2026-08-15T06:45:00.000Z",
      }],
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
      intent: "act",
      confidence: 0.94,
    };
    const intent = await routeMessage("这两天看一下研究数据，不能拖了", sequenceProvider([
      { ...base, actions: [{ action: "create_item", type: "task", title: "查看研究数据并回答问题", content: "这两天看一下研究数据，不能拖了", due_at: "2026-08-17T15:59:59.000Z", reminder_at: "2026-08-15T04:30:05.000Z", reminder_mode: "deferred_action" }] },
      { ...base, actions: [{ action: "create_item", type: "task", title: "查看研究数据并回答问题", content: "这两天看一下研究数据，不能拖了", due_at: "2026-08-17T15:59:59.000Z", reminder_at: "2026-08-16T02:00:00.000Z", reminder_mode: "deferred_action" }] },
    ], calls), now);

    expect(calls).toHaveLength(2);
    expect(intent).toMatchObject({
      actions: [{ reminderAt: "2026-08-16T02:00:00.000Z", reminderMode: "deferred_action" }],
    });
    expect(calls[1]).toContain("previous_result");
  });

  it("asks the model to add a missing reminder for an actionable task", async () => {
    const calls: string[] = [];
    const intent = await routeMessage("回复研究问题", sequenceProvider([
      { intent: "act", actions: [{ action: "create_item", type: "task", title: "回复研究问题", content: "回复研究问题" }], confidence: 0.9 },
      { intent: "act", actions: [{ action: "create_item", type: "task", title: "回复研究问题", content: "回复研究问题", reminder_at: "2026-08-15T06:00:00.000Z", reminder_mode: "deferred_action" }], confidence: 0.9 },
    ], calls), now);

    expect(calls).toHaveLength(2);
    expect(intent).toMatchObject({ actions: [{ reminderAt: "2026-08-15T06:00:00.000Z", reminderMode: "deferred_action" }] });
  });

  it("keeps only the explicit help command outside the model", async () => {
    const calls: string[] = [];
    await expect(routeMessage("/help", jsonProvider({}, calls), now)).resolves.toMatchObject({ intent: "help", source: "system" });
    expect(calls).toHaveLength(0);
  });

  it("uses a first-class reminder action and receives structured schedule context", async () => {
    const scenarioNow = new Date("2026-08-16T05:56:00.000Z");
    const item: Item = {
      id: "36800049-3596-429d-9fb4-08d8df9bb637",
      type: "task",
      title: "报名 GOAIHZ",
      content: "今天要提交完",
      rawMessage: "等会提醒我要报名GOAIHZ，这个今天要提交完",
      url: null,
      tags: [],
      status: "open",
      priority: "normal",
      estimatedDuration: null,
      createdAt: scenarioNow.toISOString(),
      updatedAt: scenarioNow.toISOString(),
      completedAt: null,
      dueAt: "2026-08-16T15:59:59.000Z",
      startAfter: null,
      originalTimeExpression: "等会提醒，今天要提交完",
      sourceChannel: "qq",
      sourceUserId: "me",
      sourceMessageId: "goaihz",
      sourceActionIndex: 0,
      aiEnrichment: {},
      metadata: {},
      parentId: null,
      embeddingId: null,
    };
    const schedule: ScheduleWindow[] = [{
      itemId: item.id,
      title: "报名 GOAIHZ（提醒）",
      startAt: "2026-08-16T06:30:00.000Z",
      endAt: "2026-08-16T06:45:00.000Z",
      source: "reminder",
    }];
    const calls: string[] = [];
    const intent = await routeMessage("两点半有事，等会晚一点再提醒我", jsonProvider({
      intent: "act",
      actions: [{
        action: "set_reminder",
        target_item_id: item.id,
        reminder_at: "2026-08-16T07:45:00.000Z",
        reminder_mode: "deferred_action",
        original_time_expression: "两点半有事，晚一点提醒",
      }],
      avoid_windows: [{
        start_at: "2026-08-16T06:15:00.000Z",
        end_at: "2026-08-16T07:30:00.000Z",
        reason: "两点半有事",
      }],
      confidence: 0.97,
    }, calls), scenarioNow, "Asia/Singapore", [item], [], schedule);

    expect(intent).toMatchObject({
      intent: "act",
      actions: [{
        action: "set_reminder",
        targetItemId: item.id,
        reminderAt: "2026-08-16T07:45:00.000Z",
        reminderMode: "deferred_action",
      }],
      avoidWindows: [{
        itemId: null,
        title: "两点半有事",
        startAt: "2026-08-16T06:15:00.000Z",
        endAt: "2026-08-16T07:30:00.000Z",
        source: "message",
      }],
    });
    expect(calls[0]).toContain("schedule");
    expect(calls[0]).toContain("current_reminder_at");
    expect(calls[0]).toContain("2026-08-16T06:30:00.000Z");
  });

  it("keeps newly disclosed busy time when resolving a card reschedule", async () => {
    const scenarioNow = new Date("2026-08-16T05:56:00.000Z");
    const resolution = await resolveScheduleChange(
      "两点半有事，等会晚一点再提醒我",
      { title: "报名 GOAIHZ", dueAt: "2026-08-16T15:59:59.000Z" },
      jsonProvider({
        due_at: null,
        reminder_at: "2026-08-16T07:45:00.000Z",
        reminder_mode: "deferred_action",
        original_time_expression: "两点半有事，晚一点提醒",
        avoid_windows: [{
          start_at: "2026-08-16T06:15:00.000Z",
          end_at: "2026-08-16T07:30:00.000Z",
          reason: "两点半有事",
        }],
        clarification_question: null,
      }, []),
      scenarioNow,
      "Asia/Singapore",
    );

    expect(resolution).toMatchObject({
      reminderAt: "2026-08-16T07:45:00.000Z",
      avoidWindows: [{
        title: "两点半有事",
        startAt: "2026-08-16T06:15:00.000Z",
        endAt: "2026-08-16T07:30:00.000Z",
      }],
      question: null,
    });
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
