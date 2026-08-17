import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { env } from "cloudflare:workers";
import { SkillRegistry } from "agents/skills";
import { generateText, stepCountIs, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import type { AgentPrincipal } from "../src/agent/context";
import { calendarSkillSource } from "../src/agent/skills/calendar";
import { createCalendarTools } from "../src/agent/tools/calendar";
import { createItem } from "../src/db/items";

const usage: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

class CalendarSkillLoopModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "desk-ix-test";
  readonly modelId = "calendar-skill-loop";
  readonly supportedUrls = {};
  readonly prompts: LanguageModelV4CallOptions["prompt"][] = [];
  private call = 0;

  doGenerate(options: LanguageModelV4CallOptions): PromiseLike<LanguageModelV4GenerateResult> {
    this.prompts.push(options.prompt);
    this.call += 1;
    if (this.call === 1) {
      return Promise.resolve(this.toolCall("skill-1", "activate_skill", { name: "calendar-plan" }));
    }
    if (this.call === 2) {
      return Promise.resolve(this.toolCall("calendar-1", "calendar_snapshot", {
        from: "2026-08-17T05:00:00.000Z",
        to: "2026-08-17T12:00:00.000Z",
      }));
    }
    if (this.call === 3) {
      return Promise.resolve(this.toolCall("free-1", "availability_find", {
        from: "2026-08-17T05:00:00.000Z",
        to: "2026-08-17T12:00:00.000Z",
        minimumMinutes: 120,
        excludeItemIds: [],
      }));
    }
    return Promise.resolve({
      content: [{
        type: "text",
        text: "今天下午不是只能从两点开始。固定会议之后，16:00–18:00 有完整两小时空档；这只是建议，尚未写入日程。",
      }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    });
  }

  doStream(): never {
    throw new Error("This deterministic test uses generateText");
  }

  private toolCall(toolCallId: string, toolName: string, input: unknown): LanguageModelV4GenerateResult {
    return {
      content: [{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) }],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage,
      warnings: [],
    };
  }
}

describe("calendar skill tool loop", () => {
  it("activates planning instructions before reading the canonical calendar and finding every valid gap", async () => {
    const principal: AgentPrincipal = {
      channel: "qq",
      userId: "calendar-skill-loop-user",
      eventId: "calendar-skill-loop-event",
      receivedAt: "2026-08-17T05:00:00.000Z",
    };
    await createItem(env.DB, {
      type: "task",
      title: "固定会议",
      content: "固定会议",
      rawMessage: "固定会议",
      status: "active",
      temporalRole: "event",
      dueAt: "2026-08-17T06:00:00.000Z",
      estimatedDuration: 90,
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "calendar-skill-loop-source",
    });

    const registry = new SkillRegistry([calendarSkillSource]);
    await registry.load();
    const tools: ToolSet = {
      ...registry.tools(),
      ...createCalendarTools(env, () => principal),
    };
    const model = new CalendarSkillLoopModel();

    const result = await generateText({
      model,
      tools,
      stopWhen: stepCountIs(5),
      prompt: "今天下午帮我找一段完整的两小时做研究，别撞上已有安排",
    });

    expect(result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName))).toEqual([
      "activate_skill",
      "calendar_snapshot",
      "availability_find",
    ]);
    expect(JSON.stringify(model.prompts[1])).toContain("calendar-plan");
    expect(JSON.stringify(model.prompts[1])).toContain("work_session_manage");
    expect(result.text).toContain("16:00–18:00");
    expect(result.text).toContain("尚未写入");

    const availabilityResult: unknown = result.steps[2]?.toolResults[0]?.output;
    expect(availabilityResult).toMatchObject({
      busy: [
        { startAt: "2026-08-17T06:00:00.000Z", endAt: "2026-08-17T07:30:00.000Z" },
      ],
      available: [
        { startAt: "2026-08-17T07:30:00.000Z", endAt: "2026-08-17T12:00:00.000Z", durationMinutes: 270 },
      ],
    });
  });
});
