import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  listOwnedItemParticipants,
  listOwnedSelfFacts,
  rememberContext,
  retractOwnedContext,
  searchOwnedContext,
} from "../src/db/context-memory";
import { createItem } from "../src/db/items";

describe("context memory", () => {
  it("stores provenance-backed entities, aliases, facts, and item participants", async () => {
    const owner = { channel: "qq" as const, userId: "context-owner" };
    const meeting = await createItem(env.DB, {
      type: "task",
      title: "和 Ivy 的 meeting",
      content: "讨论 Amiya APP 项目进展",
      rawMessage: "和 Ivy meeting",
      dueAt: "2026-08-18T05:30:00.000Z",
      temporalRole: "event",
      sourceChannel: owner.channel,
      sourceUserId: owner.userId,
      sourceMessageId: "context-meeting",
    });

    const remembered = await rememberContext(env.DB, owner, {
      entities: [
        { key: "ivy", kind: "person", name: "Ivy", aliases: ["艾薇"] },
        { key: "neudm", kind: "team", name: "NEUDM" },
      ],
      facts: [
        { subject: "ivy", predicate: "collaborates_on", value: "Amiya APP", confidence: 0.9, contextItemId: meeting.id },
        { subject: "self", predicate: "work_context", value: "参与 NEUDM 组会", confidence: 1 },
      ],
      itemLinks: [{ itemId: meeting.id, entity: "ivy", role: "participant", confidence: 1 }],
    }, "context-source-message");

    expect(remembered.factIds).toHaveLength(2);
    await expect(searchOwnedContext(env.DB, owner.channel, owner.userId, "明天和艾薇继续聊")).resolves.toMatchObject({
      entities: [{ name: "Ivy", facts: [{ predicate: "collaborates_on", value: "Amiya APP" }] }],
    });
    await expect(listOwnedSelfFacts(env.DB, owner.channel, owner.userId)).resolves.toEqual([
      expect.objectContaining({ predicate: "work_context", value: "参与 NEUDM 组会" }),
    ]);
    const participants = await listOwnedItemParticipants(env.DB, owner.channel, owner.userId, [meeting.id]);
    expect(participants.get(meeting.id)).toEqual([
      expect.objectContaining({ name: "Ivy", role: "participant", confidence: 1 }),
    ]);
  });

  it("isolates users and excludes expired or retracted facts", async () => {
    const owner = { channel: "qq" as const, userId: "context-private-owner" };
    const other = { channel: "qq" as const, userId: "context-other-owner" };
    const remembered = await rememberContext(env.DB, owner, {
      entities: [{ key: "ivy", kind: "person", name: "Ivy" }],
      facts: [
        { subject: "ivy", predicate: "meeting_delay", value: "今天延迟一小时", validUntil: "2026-08-18T08:00:00.000Z" },
        { subject: "ivy", predicate: "project", value: "Amiya APP" },
      ],
    }, "context-expiry", new Date("2026-08-18T07:00:00.000Z"));

    expect((await searchOwnedContext(env.DB, owner.channel, owner.userId, "Ivy", new Date("2026-08-19T07:00:00.000Z"))).entities[0]?.facts)
      .toEqual([expect.objectContaining({ predicate: "project" })]);
    await expect(searchOwnedContext(env.DB, other.channel, other.userId, "Ivy")).resolves.toEqual({ entities: [] });

    await expect(retractOwnedContext(env.DB, other, { factIds: [remembered.factIds[1]!] })).resolves.toEqual({
      retractedFacts: 0,
      deletedEntities: 0,
    });
    await expect(retractOwnedContext(env.DB, owner, { factIds: [remembered.factIds[1]!] })).resolves.toEqual({
      retractedFacts: 1,
      deletedEntities: 0,
    });
    expect((await searchOwnedContext(env.DB, owner.channel, owner.userId, "Ivy", new Date("2026-08-19T07:00:00.000Z"))).entities[0]?.facts)
      .toEqual([]);
  });

  it("rejects cross-user item links", async () => {
    const item = await createItem(env.DB, {
      type: "task",
      title: "private meeting",
      content: "private",
      rawMessage: "private",
      temporalRole: "event",
      sourceChannel: "qq",
      sourceUserId: "another-owner",
      sourceMessageId: "private-item",
    });
    await expect(rememberContext(env.DB, { channel: "qq", userId: "context-owner" }, {
      entities: [{ key: "ivy", kind: "person", name: "Ivy" }],
      itemLinks: [{ itemId: item.id, entity: "ivy", role: "participant" }],
    }, "cross-user-link")).rejects.toThrow("does not belong");
  });
});
