import { describe, expect, it } from "vitest";
import { resolveScheduleChange, routeMessage } from "../src/ai/intent";
import type { AIProvider } from "../src/ai/provider";
import type { Item, ScheduleWindow } from "../src/core/types";
import type { WebPageReading } from "../src/url/reader";

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

  it("provides bounded recruitment enrichment to the planner", async () => {
    const recruitment: Item = {
      id: "59e020fd-14de-41fa-b1e9-46ce4ac59c49",
      type: "note",
      title: "深圳理工大学人工智能研究院招聘",
      content: "三条招聘来源链接",
      rawMessage: "记录一下招聘信息",
      url: "https://jobs.example/notice",
      tags: ["招聘", "人工智能", "深圳"],
      status: "open",
      priority: "normal",
      estimatedDuration: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null,
      dueAt: "2026-08-31T15:59:59.000Z",
      startAfter: null,
      originalTimeExpression: null,
      sourceChannel: "qq",
      sourceUserId: "me",
      sourceMessageId: "recruitment",
      sourceActionIndex: 0,
      aiEnrichment: {
        category: "recruitment",
        summary: "人工智能研究院招聘教学科研人员。",
        organizations: ["深圳理工大学人工智能研究院"],
        roles: ["教学科研人员"],
        locations: ["深圳"],
        deadline: "2026-08-31T15:59:59.000Z",
        source_urls: ["https://jobs.example/notice"],
        ignored_private_detail: "should-not-be-sent",
      },
      metadata: { reader_error: "should-not-be-sent" },
      parentId: null,
      embeddingId: null,
    };
    const calls: string[] = [];

    await routeMessage("现在有哪些招聘信息？", jsonProvider({
      intent: "query",
      query: { keyword: "招聘", limit: 10 },
      confidence: 0.96,
    }, calls), now, "Asia/Singapore", [recruitment]);

    expect(calls[0]).toContain("深圳理工大学人工智能研究院");
    expect(calls[0]).toContain("organizations");
    expect(calls[0]).toContain("source_urls");
    expect(calls[0]).not.toContain("ignored_private_detail");
    expect(calls[0]).not.toContain("reader_error");
  });

  it("receives webpage observations before deciding what action to take", async () => {
    const calls: string[] = [];
    const webpages: WebPageReading[] = [{
      requestedUrl: "https://paper.example/method",
      finalUrl: "https://paper.example/method",
      title: "Agent Memory Paper",
      description: "A paper about memory",
      canonicalUrl: null,
      source: "paper.example",
      text: "We propose a bounded episodic retrieval method and evaluate it on three tasks.",
      truncated: false,
    }];

    await routeMessage(
      "记录这篇论文，重点看方法 https://paper.example/method",
      jsonProvider({
        intent: "act",
        actions: [{ action: "create_item", type: "resource", title: "Agent Memory Paper", content: "有界情景检索方法" }],
        confidence: 0.97,
      }, calls),
      now,
      "Asia/Singapore",
      [],
      [],
      [],
      webpages,
    );

    expect(calls[0]).toContain("webpages");
    expect(calls[0]).toContain("Agent Memory Paper");
    expect(calls[0]).toContain("bounded episodic retrieval method");
    expect(calls[0]).toContain("重点看方法");
  });

  it("can request the links stored on a referenced item before deciding", async () => {
    const item: Item = {
      id: "59e020fd-14de-41fa-b1e9-46ce4ac59c49",
      type: "note",
      title: "这个招聘信息帮我记录一下",
      content: "招聘信息：https://jobs.example/notice",
      rawMessage: "这个招聘信息帮我记录一下",
      url: null,
      tags: [],
      status: "open",
      priority: "normal",
      estimatedDuration: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null,
      dueAt: null,
      startAfter: null,
      originalTimeExpression: null,
      sourceChannel: "qq",
      sourceUserId: "me",
      sourceMessageId: "stored-recruitment",
      sourceActionIndex: 0,
      aiEnrichment: {},
      metadata: {},
      parentId: null,
      embeddingId: null,
    };

    const intent = await routeMessage(
      "根据刚才的链接内容更新一下深圳理工大学的招聘信息",
      jsonProvider({
        intent: "observe",
        tool: { name: "read_item_links", target_item_id: item.id },
        confidence: 0.98,
      }, []),
      now,
      "Asia/Singapore",
      [item],
    );

    expect(intent).toMatchObject({
      intent: "observe",
      toolRequest: { name: "read_item_links", targetItemId: item.id },
    });
  });

  it("repairs a generally invalid plan once using the original context and validation error", async () => {
    const item: Item = {
      id: "66d62c80-9e60-4d11-bda0-06f13fe7d41e",
      type: "note",
      title: "深圳理工大学招聘",
      content: "待整理",
      rawMessage: "记录招聘信息",
      url: null,
      tags: [],
      status: "open",
      priority: "normal",
      estimatedDuration: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null,
      dueAt: null,
      startAfter: null,
      originalTimeExpression: null,
      sourceChannel: "qq",
      sourceUserId: "me",
      sourceMessageId: "repair-recruitment",
      sourceActionIndex: 0,
      aiEnrichment: {},
      metadata: {},
      parentId: null,
      embeddingId: null,
    };
    const pages: WebPageReading[] = [{
      requestedUrl: "https://jobs.example/notice",
      finalUrl: "https://jobs.example/notice",
      title: "深圳理工大学招聘",
      description: "招聘教学科研人员",
      canonicalUrl: null,
      source: "jobs.example",
      text: "深圳理工大学招聘教学科研人员。",
      truncated: false,
    }];
    const calls: string[] = [];

    const intent = await routeMessage(
      "https://jobs.example/notice",
      sequenceProvider([
        { intent: "act", actions: [], confidence: 0.6 },
        {
          intent: "act",
          actions: [{
            action: "update_item",
            target_item_id: item.id,
            title: "深圳理工大学教学科研人员招聘",
            content: "深圳理工大学招聘教学科研人员。",
          }],
          confidence: 0.96,
        },
      ], calls),
      now,
      "Asia/Singapore",
      [item],
      [{ user: "根据刚才的链接更新招聘信息", assistant: "请重新发送链接", receivedAt: now.toISOString() }],
      [],
      pages,
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("validation_error");
    expect(calls[1]).toContain("act requires at least one valid action");
    expect(calls[1]).toContain("recent_conversation");
    expect(intent).toMatchObject({ intent: "act", actions: [{ action: "update_item", targetItemId: item.id }] });
  });
});
