import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

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
});
