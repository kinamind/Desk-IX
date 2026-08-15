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
});
