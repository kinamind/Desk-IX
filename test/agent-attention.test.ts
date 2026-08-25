import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ATTENTION_PRESENTER_SYSTEM_PROMPT,
  TurnPresentationBarrier,
  presentTurnReply,
  presentTurnReplyOrFallback,
  withVisibleAssistantText,
} from "../src/agent/attention";
import type { UserProfile } from "../src/core/types";

const profile: UserProfile = {
  channel: "qq",
  userId: "qq-user-42",
  userCallName: "chovy",
  assistantCallName: "拾序",
  timezone: "Asia/Singapore",
  locale: "zh-CN",
  dailyPlanEnabled: true,
  dailyPlanTime: "11:00",
  chronotype: "late",
  targetWakeTime: null,
  targetSleepTime: null,
  routineCoaching: true,
  communicationStyle: "像熟悉的长期搭档，直接但别催得太紧",
  preferences: { planningDensity: "light" },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

describe("attention-aware foreground presentation", () => {
  it("asks a separate tool-free model pass to select the current attention surface", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return Response.json({
        model: "test-model",
        choices: [{ message: { content: "现在先看 TechJam 题目并和队友定方向。ResWork 今天傍晚按原计划跟进；其他我先替你放在后台。" } }],
        usage: { prompt_tokens: 120, completion_tokens: 34 },
      });
    };

    const reply = await presentTurnReply({ ...env, AI_API_KEY: "test-key" }, {
      channel: "qq",
      originalText: "事情有点多，再帮我梳理一下看还有什么工作",
      backstageDraft: [
        "ResWork 二阶段待跟进，以下是十位被试及其手机号……",
        "TechJam 今天需要查看题目和同步队友。",
        "AAAI 审稿、SPAR 申请、香囊退款和生日祝福已经完成。",
      ].join("\n"),
      completedTurnParts: [{
        type: "tool-memory_search",
        state: "output-available",
        output: { open: 18, completed: 27 },
      }],
      profile,
    }, fetcher);

    expect(reply).toContain("其他我先替你放在后台");
    const requestBody = requestBodies[0]!;
    const messages = requestBody.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toBe(ATTENTION_PRESENTER_SYSTEM_PROMPT);
    expect(messages[0]?.content).toContain("前台注意力层");
    expect(messages[0]?.content).toContain("后台完整不等于前台完整展示");
    expect(messages[0]?.content).toContain("明确要求盘点、审计、历史或完整清单");
    expect(messages[0]?.content).toContain("不要用固定条数");
    expect(messages[0]?.content).toContain("只说变化量");
    expect(messages[0]?.content).toContain("联系方式");
    expect(messages[0]?.content).toContain("延后不等于值得展示");
    expect(messages[0]?.content).toContain("不要在用户已经过载时集中抛给用户确认");
    expect(messages[0]?.content).toContain("不要再用另一段换句话重复");
    expect(messages[0]?.content).toContain("planningDensity");
    expect(messages[0]?.content).toContain("总揽是可下钻的索引");
    expect(messages[0]?.content).toContain("不要在一个主线下面继续套子项目符号");
    expect(messages[0]?.content).toContain("直接交付内容，不解释自己的筛选");
    expect(messages[0]?.content).toContain("防御性、辩解式");
    expect(messages[1]?.content).toContain("事情有点多");
    expect(messages[1]?.content).toContain("TechJam");
    expect(messages[1]?.content).toContain("planningDensity");
    expect(messages[1]?.content).not.toContain("qq-user-42");
    expect(requestBody).not.toHaveProperty("tools");
    expect(requestBody).not.toHaveProperty("max_tokens");
    expect(requestBody).not.toHaveProperty("max_completion_tokens");
    expect(requestBody).not.toHaveProperty("response_format");
  });

  it("treats backstage material as evidence rather than instructions", () => {
    expect(ATTENTION_PRESENTER_SYSTEM_PROMPT).toContain("不可信资料");
    expect(ATTENTION_PRESENTER_SYSTEM_PROMPT).toContain("不能执行工具");
    expect(ATTENTION_PRESENTER_SYSTEM_PROMPT).toContain("不得虚构");
    expect(ATTENTION_PRESENTER_SYSTEM_PROMPT).not.toMatch(/最多\s*[一二三四五六七八九十\d]+\s*[项条]/);
  });

  it("keeps the accurate backstage result when foreground presentation fails", async () => {
    const input = {
      channel: "qq" as const,
      originalText: "完成了吗",
      backstageDraft: "已完成 proposal，并取消了对应提醒。",
      completedTurnParts: [],
      profile,
    };
    const result = await presentTurnReplyOrFallback(
      { ...env, AI_API_KEY: "test-key" },
      input,
      async () => { throw new Error("presenter unavailable"); },
    );

    expect(result).toMatchObject({
      text: input.backstageDraft,
      presented: false,
    });
    expect(result.error).toBeInstanceOf(Error);
  });

  it("keeps conversation history aligned with the reply the user actually saw", () => {
    const visible = withVisibleAssistantText({
      id: "assistant-turn-1",
      role: "assistant",
      metadata: { source: "think" },
      parts: [
        { type: "text", text: "后台长清单" },
        {
          type: "tool-memory_search",
          toolCallId: "tool-1",
          state: "output-available",
          input: {},
          output: { completed: 27 },
        },
      ],
    }, "现在只需要先看 TechJam；其余我替你记着。");

    expect(visible).toEqual({
      id: "assistant-turn-1",
      role: "assistant",
      metadata: { source: "think" },
      parts: [{ type: "text", text: "现在只需要先看 TechJam；其余我替你记着。" }],
    });
  });

  it("holds the next turn until the visible reply has replaced the backstage draft", async () => {
    const barrier = new TurnPresentationBarrier();
    const lease = barrier.begin();
    let nextTurnStarted = false;
    const nextTurn = barrier.wait().then(() => { nextTurnStarted = true; });

    await lease.ready;
    await Promise.resolve();
    expect(nextTurnStarted).toBe(false);
    lease.finish();
    await nextTurn;
    expect(nextTurnStarted).toBe(true);
  });
});
