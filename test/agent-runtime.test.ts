import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseTurnPrincipal, stampTurnPrincipal, type AgentPrincipal } from "../src/agent/context";
import { reminderInputSchema } from "../src/agent/tools/write";

describe("ComposaAgent runtime", () => {
  it("uses a bounded, queued Think runtime without broad tools", async () => {
    const agent = await getAgentByName(env.COMPOSA_AGENT, "qq:user-42");
    const profile = await agent.getRuntimeProfile();

    expect(profile).toEqual({
      runtime: "cloudflare-think",
      maxSteps: 6,
      messageConcurrency: "queue",
      recovery: true,
      recoveryPolicy: "bounded",
      streamStallTimeoutMs: 45_000,
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
    expect(z.toJSONSchema(reminderInputSchema)).toMatchObject({ type: "object" });
  });
});
