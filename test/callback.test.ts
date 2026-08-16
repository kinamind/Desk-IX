import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleCallback } from "../src/core/callbacks";
import type { IncomingMessage, ReminderWorkflowPayload } from "../src/core/types";
import { createItem, getItem } from "../src/db/items";
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

function callbackMessage(itemId: string, name: "done" | "archive" | "restore" | "later", value?: string): IncomingMessage {
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
    await createReminder(env.DB, {
      itemId: item.id,
      remindAt: "2026-08-15T02:30:00.000Z",
      kind: "deferred_action",
      targetChannel: "telegram",
      targetUserId: "42",
    }, now);
    const workflow = new FakeWorkflow();
    const callbackEnv: Env = { ...env, REMINDER_WORKFLOW: workflow };
    const result = await handleCallback(callbackEnv, callbackMessage(item.id, "later", "1h"), now);
    expect(result).toMatchObject({ acknowledgeCode: 0, itemId: item.id });
    expect(workflow.creates).toHaveLength(1);
    const params = workflow.creates[0]?.params;
    expect(typeof params?.reminderId).toBe("string");
    expect(params?.remindAt).toBe("2026-08-15T03:00:00.000Z");
    const rows = await env.DB.prepare(
      "SELECT status, remind_at, workflow_id FROM reminders WHERE item_id = ? ORDER BY remind_at ASC",
    ).bind(item.id).all<{ status: string; remind_at: string; workflow_id: string | null }>();
    expect(rows.results).toEqual([
      expect.objectContaining({ status: "canceled", remind_at: "2026-08-15T02:30:00.000Z" }),
      expect.objectContaining({ status: "pending", remind_at: "2026-08-15T03:00:00.000Z" }),
    ]);
  });

  it("archives an item without deleting it and can restore it", async () => {
    const item = await createTask("callback-archive");
    const archived = await handleCallback(env, callbackMessage(item.id, "archive"), now);
    expect(archived).toMatchObject({ acknowledgeCode: 0, itemId: item.id });
    expect(await getItem(env.DB, item.id)).toMatchObject({ status: "archived", completedAt: null });

    const restored = await handleCallback(env, callbackMessage(item.id, "restore"), now);
    expect(restored).toMatchObject({ acknowledgeCode: 0, itemId: item.id });
    expect(await getItem(env.DB, item.id)).toMatchObject({ status: "open", completedAt: null });
  });

  it("cannot act on another user's item", async () => {
    const item = await createTask("callback-owner-check");
    const incoming = callbackMessage(item.id, "done");
    incoming.userId = "someone-else";
    const result = await handleCallback(env, incoming, now);
    expect(result).toMatchObject({ acknowledgeCode: 1, itemId: null });
    expect(await getItem(env.DB, item.id)).toMatchObject({ status: "open" });
  });

  it("moves Later past another scheduled item", async () => {
    const item = await createTask("callback-later-conflict");
    await createItem(env.DB, {
      type: "task",
      title: "三点会议",
      content: "三点会议",
      rawMessage: "三点会议",
      sourceChannel: "telegram",
      sourceUserId: "42",
      sourceMessageId: "callback-busy-meeting",
      dueAt: "2026-08-15T03:00:00.000Z",
      estimatedDuration: 60,
    }, now);
    const workflow = new FakeWorkflow();
    const callbackEnv: Env = { ...env, REMINDER_WORKFLOW: workflow };

    const result = await handleCallback(callbackEnv, callbackMessage(item.id, "later", "1h"), now);

    expect(result.output.text).toContain("已避开日程冲突");
    expect(workflow.creates[0]?.params?.remindAt).toBe("2026-08-15T04:15:00.000Z");
  });
});
