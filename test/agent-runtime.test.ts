import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseTurnPrincipal, stampTurnPrincipal, type AgentPrincipal } from "../src/agent/context";
import { DESK_IX_PERSONA } from "../src/agent/prompt";
import {
  lifecycleFollowupInputSchema,
  profileUpdateSchema,
  reminderInputSchema,
  updateItemSchema,
  workSessionInputSchema,
} from "../src/agent/tools/write";

describe("ComposaAgent runtime", () => {
  it("uses natural model completion instead of a step-count cutoff", async () => {
    const agent = await getAgentByName(env.COMPOSA_AGENT, "qq:user-42");
    const profile = await agent.getRuntimeProfile();

    expect(profile).toEqual({
      runtime: "cloudflare-think",
      stepLimit: null,
      messageConcurrency: "queue",
      recovery: true,
      recoveryPolicy: "bounded",
      streamStallTimeoutMs: 0,
      immediateSubmissionDrain: true,
      sessionReady: true,
      mcpTools: false,
      workspaceBash: false,
    });
  });

  it("persists the authenticated principal in Think turn metadata", () => {
    const principal: AgentPrincipal = {
      channel: "qq",
      userId: "qq-user-42",
      eventId: "qq-event-42",
      receivedAt: "2026-08-16T12:14:53.000Z",
    };
    const message = stampTurnPrincipal({
      id: "message-42",
      role: "user",
      parts: [{ type: "text", text: "更新刚才的记录" }],
    }, principal);
    expect(parseTurnPrincipal(message.metadata.turnMetadata)).toEqual(principal);
  });

  it("exposes an OpenAI-compatible object schema for reminder management", () => {
    const reminderSchema = z.toJSONSchema(reminderInputSchema);
    expect(reminderSchema.type).toBe("object");
    expect(reminderSchema.properties?.timeSelection).toMatchObject({ enum: ["agent_selected", "user_exact"] });
    expect(z.toJSONSchema(lifecycleFollowupInputSchema)).toMatchObject({ type: "object" });
  });

  it("does not cap normal multi-source records or model-selected work-session counts", () => {
    expect(updateItemSchema.safeParse({
      itemId: "34e0fd26-fe66-4b84-bc26-4474fbca116e",
      provenance: {
        sourceUrls: Array.from({ length: 12 }, (_, index) => `https://example.com/source-${index}`),
      },
    }).success).toBe(true);
    expect(workSessionInputSchema.safeParse({
      operation: "replace",
      itemId: "34e0fd26-fe66-4b84-bc26-4474fbca116e",
      sessions: Array.from({ length: 25 }, (_, index) => ({
        startAt: new Date(Date.UTC(2026, 7, 18, index, 0)).toISOString(),
        endAt: new Date(Date.UTC(2026, 7, 18, index, 30)).toISOString(),
      })),
      rationale: "数量由任务与日程决定",
    }).success).toBe(true);
  });

  it("has a stable Desk-IX persona and object-shaped profile action", () => {
    expect(DESK_IX_PERSONA).toContain("Desk-IX（拾序）");
    expect(DESK_IX_PERSONA).toContain("desk nine");
    expect(DESK_IX_PERSONA).toContain("长期搭档");
    expect(DESK_IX_PERSONA).toContain("[引用消息]");
    expect(DESK_IX_PERSONA).toContain("真实会话历史");
    expect(DESK_IX_PERSONA).toContain("recent_fallback");
    expect(DESK_IX_PERSONA).toContain("时段范围");
    expect(DESK_IX_PERSONA).toContain("不要固定套用 14:00");
    expect(DESK_IX_PERSONA).toContain("作息倾向");
    expect(DESK_IX_PERSONA).toContain("提醒密度");
    expect(DESK_IX_PERSONA).toContain("生命周期复盘");
    expect(DESK_IX_PERSONA).toContain("发生确定性");
    expect(DESK_IX_PERSONA).toContain("结果确定性");
    expect(z.toJSONSchema(profileUpdateSchema)).toMatchObject({ type: "object" });
  });
});
