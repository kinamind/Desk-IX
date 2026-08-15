import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processIncoming } from "../src/core/processor";
import type { AIProvider } from "../src/ai/provider";
import type { IncomingMessage, ReminderWorkflowPayload } from "../src/core/types";
import { getItemBySource } from "../src/db/items";

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
      intent: "create_item",
      type: "idea",
      title: "Agent communication structure 对团队 mind flow 的影响",
      content: incoming.text,
      status: "raw",
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
      intent: "create_item",
      type: "task",
      title: "被试面试验证",
      content: incoming.text,
      due_at: "2026-08-15T07:00:00.000Z",
      reminder_at: "2026-08-15T06:45:00.000Z",
      original_time_expression: "下午三点，提前一会",
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
      intent: "create_item",
      type: "task",
      title: "查看研究数据并回答问题",
      content: incoming.text,
      due_at: "2026-08-17T15:59:59.000Z",
      reminder_at: "2026-08-16T02:00:00.000Z",
      reminder_mode: "deferred_action",
      original_time_expression: "这两天，不能拖了",
      confidence: 0.95,
    });

    await processIncoming(processorEnv, incoming, fetcher, now, provider);

    expect(workflow.creates[0]?.params?.remindAt).toBe("2026-08-16T02:00:00.000Z");
    expect(sentText).toContain("提醒：8/16 10:00 · 截止：8/17 23:59");
    expect(sentText).not.toContain("提前");
  });
});
