import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleCallback } from "../src/core/callbacks";
import type { IncomingMessage, ReminderWorkflowPayload } from "../src/core/types";
import { createItem, getItem } from "../src/db/items";

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

  public get(id: string): Promise<WorkflowInstance> {
    return Promise.resolve(new FakeWorkflowInstance(id));
  }

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

const now = new Date("2026-08-15T02:00:00.000Z");

async function createTask(sourceMessageId: string) {
  return createItem(env.DB, {
    type: "task",
    title: "发送报告",
    content: "发送报告",
    rawMessage: "发送报告",
    sourceChannel: "telegram",
    sourceUserId: "42",
    sourceMessageId,
  }, now);
}

function callbackMessage(itemId: string, name: "done" | "later", value?: string): IncomingMessage {
  return {
    channel: "telegram",
    eventId: `callback:${name}:${itemId}`,
    messageId: "99",
    userId: "42",
    text: `${name}:${itemId}`,
    timestamp: now.toISOString(),
    eventType: "callback",
    callback: { name, itemId, ...(value ? { value } : {}), interactionId: "interaction-1" },
  };
}

describe("callback business actions", () => {
  it("completes an item idempotently", async () => {
    const item = await createTask("callback-done");
    const first = await handleCallback(env, callbackMessage(item.id, "done"), now);
    const second = await handleCallback(env, callbackMessage(item.id, "done"), now);
    expect(first).toMatchObject({ acknowledgeCode: 0, itemId: item.id });
    expect(second).toMatchObject({ acknowledgeCode: 3, itemId: item.id });
    expect(await getItem(env.DB, item.id)).toMatchObject({ status: "completed", completedAt: now.toISOString() });
  });

  it("creates one Workflow-backed Later reminder", async () => {
    const item = await createTask("callback-later");
    const workflow = new FakeWorkflow();
    const callbackEnv: Env = { ...env, REMINDER_WORKFLOW: workflow };
    const result = await handleCallback(callbackEnv, callbackMessage(item.id, "later", "1h"), now);
    expect(result).toMatchObject({ acknowledgeCode: 0, itemId: item.id });
    expect(workflow.creates).toHaveLength(1);
    const params = workflow.creates[0]?.params;
    expect(typeof params?.reminderId).toBe("string");
    expect(params?.remindAt).toBe("2026-08-15T03:00:00.000Z");
    const row = await env.DB.prepare("SELECT status, remind_at, workflow_id FROM reminders WHERE item_id = ?").bind(item.id).first();
    expect(row).toMatchObject({ status: "pending", remind_at: "2026-08-15T03:00:00.000Z" });
  });
});
