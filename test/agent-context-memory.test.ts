import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createItem } from "../src/db/items";
import {
  forgetOwnedPlanningContext,
  loadRelevantPlanningContext,
  rememberContextSchema,
  rememberOwnedPlanningContext,
} from "../src/agent/tools/context-memory";

describe("Agent context memory tools", () => {
  it("stores Agent-selected social context and retrieves it for a later planning turn", async () => {
    const principal = {
      channel: "qq" as const,
      userId: "agent-context-owner",
      eventId: "agent-context-source",
      receivedAt: "2026-08-18T06:50:43.000Z",
    };
    const meeting = await createItem(env.DB, {
      type: "task",
      title: "和 Ivy 的 meeting",
      content: "讨论 Amiya APP",
      rawMessage: "和 Ivy meeting",
      dueAt: "2026-08-18T05:30:00.000Z",
      temporalRole: "event",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "agent-context-meeting",
    });
    const input = rememberContextSchema.parse({
      entities: [{ key: "ivy", kind: "person", name: "Ivy" }],
      facts: [{
        subject: "ivy",
        predicate: "project_context",
        value: "Amiya APP",
        contextItemId: meeting.id,
        confidence: 0.9,
      }],
      itemLinks: [{ itemId: meeting.id, entity: "ivy", role: "participant" }],
    });
    const remembered = await rememberOwnedPlanningContext(env, principal, input);

    const later = await loadRelevantPlanningContext(env, {
      ...principal,
      eventId: "later-turn",
    }, "明天继续安排 Amiya APP 的进展");
    expect(later.entities).toEqual([
      expect.objectContaining({ name: "Ivy", facts: [expect.objectContaining({ predicate: "project_context" })] }),
    ]);

    await expect(forgetOwnedPlanningContext(env, principal, { factIds: remembered.factIds, entityIds: [] }))
      .resolves.toMatchObject({ retractedFacts: 1 });
  });

  it("keeps one-off circumstances time-bounded instead of requiring fixed relationship labels", () => {
    expect(rememberContextSchema.safeParse({
      entities: [{ key: "ivy", kind: "person", name: "Ivy" }],
      facts: [{
        subject: "ivy",
        predicate: "meeting_delay",
        value: "今天的 meeting 延迟一小时",
        confidence: 0.8,
        validUntil: "2026-08-19T00:00:00.000Z",
      }],
    }).success).toBe(true);
    expect(rememberContextSchema.safeParse({
      entities: [{ key: "lab", kind: "team", name: "NEUDM" }],
      itemLinks: [],
    }).success).toBe(true);
  });
});
