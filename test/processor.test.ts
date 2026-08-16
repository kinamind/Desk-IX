import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processIncoming } from "../src/core/processor";
import type { AIProvider } from "../src/ai/provider";
import type { IncomingMessage, ReminderWorkflowPayload } from "../src/core/types";
import { archiveItem, createItem, getItem, getItemBySource } from "../src/db/items";
import { createReminder } from "../src/db/reminders";

class FakeWorkflowInstance implements WorkflowInstance {
  public constructor(public id: string) {}
  public pause(): Promise<void> { return Promise.resolve(); }
  public resume(): Promise<void> { return Promise.resolve(); }
  public terminate(): Promise<void> { return Promise.resolve(); }
  public restart(): Promise<void> { return Promise.resolve(); }
  public delete(): Promise<void> { return Promise.resolve(); }
  public status(): Promise<InstanceStatus> { return Promise.resolve({ status: "waiting" }); }
  public sendEvent(): Promise<void> { return Promise.resolve(); }
}

class FakeWorkflow implements Workflow<ReminderWorkflowPayload> {
  public readonly creates: WorkflowInstanceCreateOptions<ReminderWorkflowPayload>[] = [];
  public get(id: string): Promise<WorkflowInstance> { return Promise.resolve(new FakeWorkflowInstance(id)); }
  public create(options: WorkflowInstanceCreateOptions<ReminderWorkflowPayload> = {}): Promise<WorkflowInstance> {
    this.creates.push(options);
    return Promise.resolve(new FakeWorkflowInstance(options.id ?? "generated"));
  }
  public createBatch(batch: WorkflowInstanceCreateOptions<ReminderWorkflowPayload>[]): Promise<WorkflowInstance[]> {
    this.creates.push(...batch);
    return Promise.resolve(batch.map((options) => new FakeWorkflowInstance(options.id ?? "generated")));
  }
  public deleteBatch(instanceIds: string[]): Promise<WorkflowBatchDeleteResult> {
    return Promise.resolve({ deleted: instanceIds.map((id) => ({ id })), errors: [] });
  }
}

class FailingWorkflow extends FakeWorkflow {
  public override create(options: WorkflowInstanceCreateOptions<ReminderWorkflowPayload> = {}): Promise<WorkflowInstance> {
    this.creates.push(options);
    return Promise.reject(new Error("workflow unavailable"));
  }
}

function providerFor(payload: Record<string, unknown>): AIProvider {
  return {
    generate: () => Promise.resolve({
      text: JSON.stringify(payload),
      model: "test-model",
      inputTokens: 10,
      outputTokens: 5,
    }),
  };
}

function providerByPurpose(intentPayload: Record<string, unknown>, enrichmentPayload: Record<string, unknown>): AIProvider {
  return {
    generate: (request) => Promise.resolve({
      text: JSON.stringify(request.purpose === "url_enrichment" ? enrichmentPayload : intentPayload),
      model: "test-model",
      inputTokens: 10,
      outputTokens: 5,
    }),
  };
}

describe("intent to business operation", () => {
  it("faithfully stores an idea and deduplicates the webhook", async () => {
    const now = new Date("2026-08-15T02:00:00.000Z");
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:processor-idea",
      messageId: "101",
      userId: "42",
      text: "想到一个 idea：研究 Agent communication structure 对团队 mind flow 的影响",
      timestamp: now.toISOString(),
      eventType: "message",
      replyToMessageId: "101",
    };
    let sends = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("api.telegram.org")) throw new Error(`Unexpected request: ${url}`);
      sends += 1;
      return Response.json({ ok: true, result: { message_id: 202 } });
    };

    const provider = providerFor({
      intent: "act",
      actions: [{
        action: "create_item",
        type: "idea",
        title: "Agent communication structure 对团队 mind flow 的影响",
        content: incoming.text,
        status: "raw",
      }],
      confidence: 0.95,
    });

    await processIncoming(env, incoming, fetcher, now, provider);
    await processIncoming(env, incoming, fetcher, now, provider);

    const item = await getItemBySource(env.DB, "telegram", incoming.eventId);
    expect(item).toMatchObject({
      type: "idea",
      status: "raw",
      rawMessage: incoming.text,
      content: incoming.text,
      aiEnrichment: { provider: "openai-compatible", model: "test-model" },
    });
    expect(sends).toBe(1);
  });

  it("persists event and reminder times chosen by the model and schedules the Workflow", async () => {
    const now = new Date("2026-08-15T04:30:00.000Z");
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:processor-reminder",
      messageId: "102",
      userId: "42",
      text: "下午三点约了一个被试面试验证，提前一会提醒我",
      timestamp: now.toISOString(),
      eventType: "message",
      replyToMessageId: "102",
    };
    const workflow = new FakeWorkflow();
    const processorEnv: Env = { ...env, REMINDER_WORKFLOW: workflow };
    let sentText = "";
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("api.telegram.org")) throw new Error(`Unexpected request: ${url}`);
      if (typeof init?.body !== "string") throw new Error("Expected Telegram JSON body");
      const body = JSON.parse(init.body) as { text?: unknown };
      sentText = typeof body.text === "string" ? body.text : "";
      return Response.json({ ok: true, result: { message_id: 203 } });
    };
    const provider = providerFor({
      intent: "act",
      actions: [{
        action: "create_item",
        type: "task",
        title: "被试面试验证",
        content: incoming.text,
        due_at: "2026-08-15T07:00:00.000Z",
        reminder_at: "2026-08-15T06:45:00.000Z",
        reminder_mode: "pre_event",
        original_time_expression: "下午三点，提前一会",
      }],
      confidence: 0.95,
    });

    await processIncoming(processorEnv, incoming, fetcher, now, provider);

    const item = await getItemBySource(env.DB, "telegram", incoming.eventId);
    expect(item).toMatchObject({ dueAt: "2026-08-15T07:00:00.000Z", originalTimeExpression: "下午三点，提前一会" });
    expect(workflow.creates[0]?.params?.remindAt).toBe("2026-08-15T06:45:00.000Z");
    expect(sentText).toContain("提前15 分钟提醒");
  });

  it("shows a deferred action time separately from a distant deadline", async () => {
    const now = new Date("2026-08-15T15:50:00.000Z");
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:processor-deferred-reminder",
      messageId: "103",
      userId: "42",
      text: "这两天看一下研究数据，不能拖了",
      timestamp: now.toISOString(),
      eventType: "message",
      replyToMessageId: "103",
    };
    const workflow = new FakeWorkflow();
    const processorEnv: Env = { ...env, REMINDER_WORKFLOW: workflow };
    let sentText = "";
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected Telegram JSON body");
      const body = JSON.parse(init.body) as { text?: unknown };
      sentText = typeof body.text === "string" ? body.text : "";
      return Response.json({ ok: true, result: { message_id: 204 } });
    };
    const provider = providerFor({
      intent: "act",
      actions: [{
        action: "create_item",
        type: "task",
        title: "查看研究数据并回答问题",
        content: incoming.text,
        due_at: "2026-08-17T15:59:59.000Z",
        reminder_at: "2026-08-16T02:00:00.000Z",
        reminder_mode: "deferred_action",
        original_time_expression: "这两天，不能拖了",
      }],
      confidence: 0.95,
    });

    await processIncoming(processorEnv, incoming, fetcher, now, provider);

    expect(workflow.creates[0]?.params?.remindAt).toBe("2026-08-16T02:00:00.000Z");
    expect(sentText).toContain("提醒：8/16 10:00 · 截止：8/17 23:59");
    expect(sentText).not.toContain("提前");
  });

  it("uses recent context to complete the original item and cancels its reminder", async () => {
    const now = new Date("2026-08-16T02:00:00.000Z");
    const original = await createItem(env.DB, {
      type: "task",
      title: "查看Tingna的研究数据journey并解答她的问题",
      content: "查看研究数据并解答问题",
      rawMessage: "这两天看一下Tingna的研究数据journey，不能拖了",
      sourceChannel: "telegram",
      sourceUserId: "42",
      sourceMessageId: "original-tingna-task",
    }, new Date("2026-08-15T02:00:00.000Z"));
    await createReminder(env.DB, {
      itemId: original.id,
      remindAt: "2026-08-16T04:00:00.000Z",
      kind: "deferred_action",
      targetChannel: "telegram",
      targetUserId: "42",
    }, now);

    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:complete-tingna",
      messageId: "104",
      userId: "42",
      text: "婷娜那个研究数据journey的问题，已经解决完了",
      timestamp: now.toISOString(),
      eventType: "message",
      replyToMessageId: "104",
    };
    let modelInput = "";
    let sentText = "";
    const provider: AIProvider = {
      generate: (request) => {
        modelInput = request.messages.at(-1)?.content ?? "";
        return Promise.resolve({
          text: JSON.stringify({
            intent: "act",
            actions: [{ action: "complete_item", target_item_id: original.id }],
            confidence: 0.98,
          }),
          model: "test-model",
          inputTokens: 10,
          outputTokens: 5,
        });
      },
    };
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected Telegram JSON body");
      sentText = (JSON.parse(init.body) as { text: string }).text;
      return Response.json({ ok: true, result: { message_id: 205 } });
    };

    await processIncoming(env, incoming, fetcher, now, provider);

    expect(modelInput).toContain(original.id);
    expect(modelInput).toContain("查看Tingna的研究数据journey并解答她的问题");
    expect(await getItem(env.DB, original.id)).toMatchObject({ status: "completed", completedAt: now.toISOString() });
    expect(await getItemBySource(env.DB, "telegram", incoming.eventId)).toBeNull();
    expect(await env.DB.prepare("SELECT status FROM reminders WHERE item_id = ?").bind(original.id).first()).toMatchObject({ status: "canceled" });
    expect(sentText).toBe(`✓ 已完成：${original.title}`);
  });

  it("can respond conversationally without creating a record", async () => {
    const now = new Date("2026-08-16T03:00:00.000Z");
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:conversation-only",
      messageId: "105",
      userId: "42",
      text: "你觉得这个安排会不会太满？",
      timestamp: now.toISOString(),
      eventType: "message",
    };
    let sentText = "";
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected Telegram JSON body");
      sentText = (JSON.parse(init.body) as { text: string }).text;
      return Response.json({ ok: true, result: { message_id: 206 } });
    };

    await processIncoming(env, incoming, fetcher, now, providerFor({
      intent: "respond",
      reply: "有一点满。我会优先保住最临近的两件，其余留出缓冲。",
      confidence: 0.91,
    }));

    expect(sentText).toContain("有一点满");
    expect(await getItemBySource(env.DB, "telegram", incoming.eventId)).toBeNull();
  });

  it("can execute an action and answer the user's related question in the same turn", async () => {
    const now = new Date("2026-08-16T03:20:00.000Z");
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:act-and-answer",
      messageId: "105b",
      userId: "42",
      text: "把这个想法记下来，也告诉我它和普通待办有什么区别：研究 Agent 记忆边界",
      timestamp: now.toISOString(),
      eventType: "message",
    };
    let sentText = "";
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected Telegram JSON body");
      sentText = (JSON.parse(init.body) as { text: string }).text;
      return Response.json({ ok: true, result: { message_id: 2061 } });
    };

    await processIncoming(env, incoming, fetcher, now, providerFor({
      intent: "act",
      actions: [{
        action: "create_item",
        type: "idea",
        title: "研究 Agent 记忆边界",
        content: "研究 Agent 记忆边界",
        status: "raw",
      }],
      reply: "它关注的是助理应记住什么、何时取回和何时遗忘，而普通待办只描述要做什么。",
      confidence: 0.95,
    }));

    await expect(getItemBySource(env.DB, "telegram", incoming.eventId)).resolves.toMatchObject({ type: "idea" });
    expect(sentText).toContain("已记录 Idea");
    expect(sentText).toContain("普通待办只描述要做什么");
  });

  it("creates multiple records from one action plan without collisions", async () => {
    const now = new Date("2026-08-16T04:00:00.000Z");
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:multi-action",
      messageId: "106",
      userId: "42",
      text: "记下两个想法：做周报模板；整理访谈方法",
      timestamp: now.toISOString(),
      eventType: "message",
    };
    const fetcher: typeof fetch = async () => Response.json({ ok: true, result: { message_id: 207 } });
    await processIncoming(env, incoming, fetcher, now, providerFor({
      intent: "act",
      actions: [
        { action: "create_item", type: "idea", title: "做周报模板", content: "做周报模板", status: "raw" },
        { action: "create_item", type: "idea", title: "整理访谈方法", content: "整理访谈方法", status: "raw" },
      ],
      confidence: 0.95,
    }));

    await expect(getItemBySource(env.DB, "telegram", incoming.eventId, 0)).resolves.toMatchObject({ title: "做周报模板" });
    await expect(getItemBySource(env.DB, "telegram", incoming.eventId, 1)).resolves.toMatchObject({ title: "整理访谈方法" });
  });

  it("can archive and restore existing records in one natural-language turn", async () => {
    const now = new Date("2026-08-16T05:00:00.000Z");
    const discard = await createItem(env.DB, {
      type: "task",
      title: "不再继续的实验",
      content: "旧实验",
      rawMessage: "旧实验",
      sourceChannel: "telegram",
      sourceUserId: "42",
      sourceMessageId: "action-discard",
    }, now);
    const restore = await createItem(env.DB, {
      type: "task",
      title: "重新启动的访谈",
      content: "访谈",
      rawMessage: "访谈",
      sourceChannel: "telegram",
      sourceUserId: "42",
      sourceMessageId: "action-restore",
    }, now);
    await archiveItem(env.DB, restore.id, now);
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:archive-and-restore",
      messageId: "107",
      userId: "42",
      text: "旧实验不做了，把访谈恢复回来",
      timestamp: now.toISOString(),
      eventType: "message",
    };
    let sentText = "";
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected Telegram JSON body");
      sentText = (JSON.parse(init.body) as { text: string }).text;
      return Response.json({ ok: true, result: { message_id: 208 } });
    };
    await processIncoming(env, incoming, fetcher, now, providerFor({
      intent: "act",
      actions: [
        { action: "archive_item", target_item_id: discard.id },
        { action: "restore_item", target_item_id: restore.id },
      ],
      confidence: 0.97,
    }));

    await expect(getItem(env.DB, discard.id)).resolves.toMatchObject({ status: "archived" });
    await expect(getItem(env.DB, restore.id)).resolves.toMatchObject({ status: "open" });
    expect(sentText).toContain("已舍弃");
    expect(sentText).toContain("已恢复");
  });

  it("updates an existing reminder and moves it past a busy window", async () => {
    const now = new Date("2026-08-16T05:56:00.000Z");
    const item = await createItem(env.DB, {
      type: "task",
      title: "报名 GOAIHZ",
      content: "今天要提交完",
      rawMessage: "等会提醒我要报名GOAIHZ，这个今天要提交完",
      sourceChannel: "telegram",
      sourceUserId: "42",
      sourceMessageId: "goaihz-original",
      dueAt: "2026-08-16T15:59:59.000Z",
    }, now);
    await createReminder(env.DB, {
      itemId: item.id,
      remindAt: "2026-08-16T06:30:00.000Z",
      kind: "deferred_action",
      targetChannel: "telegram",
      targetUserId: "42",
    }, now);
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:move-goaihz-reminder",
      messageId: "108",
      userId: "42",
      text: "两点半有事，等会晚一点再提醒我",
      timestamp: now.toISOString(),
      eventType: "message",
    };
    const workflow = new FakeWorkflow();
    const processorEnv: Env = { ...env, REMINDER_WORKFLOW: workflow };
    let sentText = "";
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected Telegram JSON body");
      sentText = (JSON.parse(init.body) as { text: string }).text;
      return Response.json({ ok: true, result: { message_id: 209 } });
    };

    await processIncoming(processorEnv, incoming, fetcher, now, providerFor({
      intent: "act",
      actions: [{
        action: "set_reminder",
        target_item_id: item.id,
        reminder_at: "2026-08-16T06:45:00.000Z",
        reminder_mode: "deferred_action",
        original_time_expression: "两点半有事，晚一点提醒",
      }],
      avoid_windows: [{
        start_at: "2026-08-16T06:15:00.000Z",
        end_at: "2026-08-16T07:30:00.000Z",
        reason: "两点半有事",
      }],
      confidence: 0.97,
    }));

    const reminders = await env.DB.prepare(
      "SELECT remind_at, status FROM reminders WHERE item_id = ? ORDER BY remind_at ASC",
    ).bind(item.id).all<{ remind_at: string; status: string }>();
    expect(reminders.results).toEqual([
      { remind_at: "2026-08-16T06:30:00.000Z", status: "canceled" },
      { remind_at: "2026-08-16T07:45:00.000Z", status: "pending" },
    ]);
    expect(workflow.creates.at(-1)?.params?.remindAt).toBe("2026-08-16T07:45:00.000Z");
    expect(await getItemBySource(env.DB, "telegram", incoming.eventId)).toBeNull();
    expect(sentText).toContain("已避开日程冲突");
  });

  it("moves a new reminder past an existing scheduled item", async () => {
    const now = new Date("2026-08-16T05:00:00.000Z");
    await createItem(env.DB, {
      type: "task",
      title: "两点半会议",
      content: "两点半有会",
      rawMessage: "两点半有会",
      sourceChannel: "telegram",
      sourceUserId: "schedule-owner",
      sourceMessageId: "busy-meeting",
      dueAt: "2026-08-16T06:30:00.000Z",
      estimatedDuration: 60,
    }, now);
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:new-reminder-conflict",
      messageId: "109",
      userId: "schedule-owner",
      text: "今天晚些时候提醒我提交报名",
      timestamp: now.toISOString(),
      eventType: "message",
    };
    const workflow = new FakeWorkflow();
    const processorEnv: Env = { ...env, REMINDER_WORKFLOW: workflow };
    let sentText = "";
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected Telegram JSON body");
      sentText = (JSON.parse(init.body) as { text: string }).text;
      return Response.json({ ok: true, result: { message_id: 210 } });
    };

    await processIncoming(processorEnv, incoming, fetcher, now, providerFor({
      intent: "act",
      actions: [{
        action: "create_item",
        type: "task",
        title: "提交报名",
        content: incoming.text,
        due_at: "2026-08-16T12:00:00.000Z",
        reminder_at: "2026-08-16T06:45:00.000Z",
        reminder_mode: "deferred_action",
      }],
      confidence: 0.96,
    }));

    expect(workflow.creates.at(-1)?.params?.remindAt).toBe("2026-08-16T07:45:00.000Z");
    expect(sentText).toContain("已避开日程冲突");
  });

  it("keeps the old reminder when replacement Workflow creation fails", async () => {
    const now = new Date("2026-08-16T05:00:00.000Z");
    const item = await createItem(env.DB, {
      type: "task",
      title: "提交关键报名",
      content: "今天提交",
      rawMessage: "今天提交",
      sourceChannel: "telegram",
      sourceUserId: "workflow-failure-owner",
      sourceMessageId: "workflow-failure-original",
      dueAt: "2026-08-16T12:00:00.000Z",
    }, now);
    await createReminder(env.DB, {
      itemId: item.id,
      remindAt: "2026-08-16T06:00:00.000Z",
      kind: "deferred_action",
      targetChannel: "telegram",
      targetUserId: "workflow-failure-owner",
    }, now);
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:workflow-failure-replacement",
      messageId: "110",
      userId: "workflow-failure-owner",
      text: "晚一点再提醒我",
      timestamp: now.toISOString(),
      eventType: "message",
    };
    const failingWorkflow = new FailingWorkflow();
    const processorEnv: Env = { ...env, REMINDER_WORKFLOW: failingWorkflow };

    await expect(processIncoming(processorEnv, incoming, async () => Response.json({ ok: true }), now, providerFor({
      intent: "act",
      actions: [{
        action: "set_reminder",
        target_item_id: item.id,
        reminder_at: "2026-08-16T07:00:00.000Z",
        reminder_mode: "deferred_action",
      }],
      confidence: 0.96,
    }))).rejects.toThrow("workflow unavailable");

    const reminders = await env.DB.prepare(
      "SELECT remind_at, status FROM reminders WHERE item_id = ? ORDER BY remind_at ASC",
    ).bind(item.id).all<{ remind_at: string; status: string }>();
    expect(reminders.results).toEqual([
      { remind_at: "2026-08-16T06:00:00.000Z", status: "pending" },
      { remind_at: "2026-08-16T07:00:00.000Z", status: "failed" },
    ]);
  });

  it("turns three recruitment links added to an existing vague note into a structured record", async () => {
    const now = new Date("2026-08-16T08:02:47.000Z");
    const existing = await createItem(env.DB, {
      type: "note",
      title: "这个招聘信息帮我记录一下",
      content: "招聘信息",
      rawMessage: "这个招聘信息帮我记录一下",
      sourceChannel: "telegram",
      sourceUserId: "recruitment-owner",
      sourceMessageId: "old-recruitment-note",
    }, new Date("2026-08-15T04:36:01.339Z"));
    const recruitmentUrls = [
      "https://jobs.example/notice",
      "https://institute.example/center",
      "https://faculty.example/team",
    ];
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:recruitment-links",
      messageId: "111",
      userId: "recruitment-owner",
      text: `记录一下这个招聘信息：\n${recruitmentUrls.join("\n")}`,
      timestamp: now.toISOString(),
      eventType: "message",
      replyToMessageId: "111",
    };
    let sentText = "";
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.telegram.org")) {
        if (typeof init?.body !== "string") throw new Error("Expected Telegram JSON body");
        sentText = (JSON.parse(init.body) as { text: string }).text;
        return Response.json({ ok: true, result: { message_id: 211 } });
      }
      const title = url.includes("jobs") ? "人才招聘" : url.includes("institute") ? "研究中心" : "师资队伍";
      return new Response(`<html><head><title>${title}</title></head><body>深圳理工大学人工智能研究院招聘教学科研人员。申请：https://jobs.example/apply</body></html>`, {
        headers: { "content-type": "text/html" },
      });
    };

    await processIncoming(env, incoming, fetcher, now, providerByPurpose({
      intent: "act",
      actions: [{
        action: "update_item",
        target_item_id: existing.id,
        title: "深圳理工大学人工智能研究院招聘",
        content: incoming.text,
      }],
      confidence: 0.98,
    }, {
      category: "recruitment",
      title: "深圳理工大学人工智能研究院招聘",
      summary: "人工智能研究院及相关中心招聘教学科研人员。",
      organizations: ["深圳理工大学人工智能研究院"],
      roles: ["教学科研人员", "研究中心岗位"],
      locations: ["深圳"],
      requirements: ["以各岗位页面要求为准"],
      deadline: "2026-08-31T15:59:59.000Z",
      application_urls: ["https://jobs.example/apply"],
      tags: ["招聘", "人工智能", "深圳"],
    }));

    const item = await getItem(env.DB, existing.id);
    expect(item).toMatchObject({
      title: "深圳理工大学人工智能研究院招聘",
      url: recruitmentUrls[0],
      dueAt: "2026-08-31T15:59:59.000Z",
    });
    expect(item?.tags).toEqual(["招聘", "人工智能", "深圳"]);
    expect(item?.aiEnrichment.category).toBe("recruitment");
    expect(item?.aiEnrichment.organizations).toEqual(["深圳理工大学人工智能研究院"]);
    expect(item?.aiEnrichment.source_urls).toEqual(recruitmentUrls);
    expect(sentText).toContain("已整理招聘信息");
    expect(sentText).toContain("截止：8/31 23:59");
    expect(sentText).toContain("来源：已读取 3/3 个网页");
  });

  it("gives analysis the current timezone and structured recruitment facts", async () => {
    const now = new Date("2026-08-16T08:03:39.000Z");
    await createItem(env.DB, {
      type: "note",
      title: "深圳理工大学人工智能研究院招聘",
      content: "招聘来源摘要",
      rawMessage: "记录招聘信息",
      sourceChannel: "telegram",
      sourceUserId: "analysis-owner",
      sourceMessageId: "analysis-recruitment",
      dueAt: "2026-08-31T15:59:59.000Z",
      aiEnrichment: {
        category: "recruitment",
        summary: "人工智能研究院招聘教学科研人员。",
        organizations: ["深圳理工大学人工智能研究院"],
        roles: ["教学科研人员"],
        locations: ["深圳"],
        deadline: "2026-08-31T15:59:59.000Z",
        source_urls: ["https://jobs.example/notice"],
      },
    }, now);
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:analyze-recruitment",
      messageId: "112",
      userId: "analysis-owner",
      text: "现在记录了哪些招聘信息，哪些快截止？",
      timestamp: now.toISOString(),
      eventType: "message",
      replyToMessageId: "112",
    };
    let analysisInput = "";
    let analysisSystem = "";
    let sentText = "";
    const provider: AIProvider = {
      generate: (request) => {
        if (request.purpose === "intent") {
          return Promise.resolve({
            text: JSON.stringify({ intent: "analyze", confidence: 0.97 }),
            model: "test-model",
            inputTokens: 10,
            outputTokens: 5,
          });
        }
        analysisSystem = request.messages[0]?.content ?? "";
        analysisInput = request.messages.at(-1)?.content ?? "";
        return Promise.resolve({
          text: "深圳理工大学人工智能研究院招聘，截止：8/31 23:59。",
          model: "test-model",
          inputTokens: 20,
          outputTokens: 10,
        });
      },
    };
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected Telegram JSON body");
      sentText = (JSON.parse(init.body) as { text: string }).text;
      return Response.json({ ok: true, result: { message_id: 212 } });
    };

    await processIncoming(env, incoming, fetcher, now, provider);

    expect(analysisSystem).toContain("Asia/Singapore");
    expect(analysisInput).toContain('"current_time":"2026-08-16T08:03:39.000Z"');
    expect(analysisInput).toContain('"timezone":"Asia/Singapore"');
    expect(analysisInput).toContain('"category":"recruitment"');
    expect(analysisInput).toContain("深圳理工大学人工智能研究院");
    expect(sentText).toContain("8/31 23:59");
  });

  it("lets the model answer from retrieval tool results instead of returning a bare row list", async () => {
    const now = new Date("2026-08-16T08:20:00.000Z");
    await createItem(env.DB, {
      type: "resource",
      title: "深圳理工大学人工智能研究院招聘",
      content: "招聘教学科研人员",
      rawMessage: "记录招聘信息",
      url: "https://jobs.example/notice",
      sourceChannel: "telegram",
      sourceUserId: "query-owner",
      sourceMessageId: "query-recruitment",
      dueAt: "2026-08-31T15:59:59.000Z",
      aiEnrichment: {
        category: "recruitment",
        organizations: ["深圳理工大学人工智能研究院"],
        roles: ["教学科研人员"],
        requirements: ["具有相关研究背景"],
        summary: "招聘教学科研人员。",
      },
    }, now);
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:query-enriched-recruitment",
      messageId: "query-1",
      userId: "query-owner",
      text: "我记过的招聘里，哪个快截止，要求是什么？",
      timestamp: now.toISOString(),
      eventType: "message",
    };
    let queryToolInput = "";
    let sentText = "";
    const provider: AIProvider = {
      generate: (request) => {
        if (request.purpose === "intent") {
          return Promise.resolve({
            text: JSON.stringify({ intent: "query", query: { keyword: "招聘", limit: 10 }, confidence: 0.97 }),
            model: "test-model",
            inputTokens: 10,
            outputTokens: 5,
          });
        }
        queryToolInput = request.messages.at(-1)?.content ?? "";
        return Promise.resolve({
          text: "最临近的是深圳理工大学人工智能研究院招聘，8 月 31 日 23:59 截止；页面写明的要求是具有相关研究背景。",
          model: "test-model",
          inputTokens: 20,
          outputTokens: 12,
        });
      },
    };
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected Telegram JSON body");
      sentText = (JSON.parse(init.body) as { text: string }).text;
      return Response.json({ ok: true, result: { message_id: 214 } });
    };

    await processIncoming(env, incoming, fetcher, now, provider);

    expect(queryToolInput).toContain("tool_results");
    expect(queryToolInput).toContain("具有相关研究背景");
    expect(queryToolInput).toContain("2026-08-31T15:59:59.000Z");
    expect(sentText).toContain("要求");
    expect(sentText).toContain("8 月 31 日 23:59");
  });

  it("reads every bounded link when the user asks for a comparison", async () => {
    const now = new Date("2026-08-16T09:00:00.000Z");
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:compare-two-links",
      messageId: "113",
      userId: "compare-owner",
      text: "比较这两篇文章的核心观点：https://article-a.example/one https://article-b.example/two",
      timestamp: now.toISOString(),
      eventType: "message",
      replyToMessageId: "113",
    };
    const fetchedPages: string[] = [];
    let plannerInput = "";
    let analysisInput = "";
    const provider: AIProvider = {
      generate: (request) => {
        if (request.purpose === "intent") {
          plannerInput = request.messages.at(-1)?.content ?? "";
          return Promise.resolve({
            text: JSON.stringify({ intent: "analyze", confidence: 0.98 }),
            model: "test-model",
            inputTokens: 10,
            outputTokens: 5,
          });
        }
        analysisInput = request.messages.at(-1)?.content ?? "";
        return Promise.resolve({
          text: "A 强调结构化记忆，B 强调按需检索。",
          model: "test-model",
          inputTokens: 30,
          outputTokens: 15,
        });
      },
    };
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.telegram.org")) {
        if (typeof init?.body !== "string") throw new Error("Expected Telegram JSON body");
        return Response.json({ ok: true, result: { message_id: 213 } });
      }
      fetchedPages.push(url);
      const isA = url.includes("article-a");
      return new Response(
        `<html><head><title>${isA ? "Article A" : "Article B"}</title></head><body>${isA ? "Structured memory" : "On-demand retrieval"}</body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    };

    await processIncoming(env, incoming, fetcher, now, provider);

    expect(fetchedPages).toEqual(["https://article-a.example/one", "https://article-b.example/two"]);
    expect(plannerInput).toContain("Article A");
    expect(plannerInput).toContain("Structured memory");
    expect(plannerInput).toContain("Article B");
    expect(plannerInput).toContain("On-demand retrieval");
    expect(analysisInput).toContain("Article A");
    expect(analysisInput).toContain("Structured memory");
    expect(analysisInput).toContain("Article B");
    expect(analysisInput).toContain("On-demand retrieval");
  });
});
