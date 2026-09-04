import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AgentPrincipal } from "../src/agent/context";
import { loadTurnItemContext } from "../src/agent/turn-context";
import { createItem } from "../src/db/items";

const principal: AgentPrincipal = {
  channel: "qq",
  userId: "adaptive-context-owner",
  eventId: "adaptive-context-event",
  receivedAt: "2026-09-02T05:08:05.000Z",
};

describe("adaptive turn context", () => {
  it("surfaces an older paraphrased item as evidence without resolving identity in code", async () => {
    const existing = await createItem(env.DB, {
      type: "task",
      title: "给由雪伟发送更新后的简历（待处理）",
      content: "更新简历，补充实习经历部分；尽量尽早发送给由雪伟。",
      rawMessage: "更新简历并发送给由雪伟",
      status: "open",
      priority: "high",
      estimatedDuration: 60,
      temporalRole: "none",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "existing-resume-item",
    }, new Date("2026-08-24T04:43:56.401Z"));
    for (let index = 0; index < 35; index += 1) {
      await createItem(env.DB, {
        type: "resource",
        title: `新招聘记录 ${index}`,
        content: "之后再看具体岗位。",
        rawMessage: "招聘卡片",
        sourceChannel: principal.channel,
        sourceUserId: principal.userId,
        sourceMessageId: `context-noise-${index}`,
      }, new Date(`2026-09-01T${String(index % 24).padStart(2, "0")}:00:00.000Z`));
    }

    const context = await loadTurnItemContext(
      env,
      principal,
      "简历要更新一下，增加实习部分的内容，我现在有个meeting，等会结束优先做这个",
    );

    expect(context).toContain("候选证据");
    expect(context).toContain('"provenance":"historical_candidate_only"');
    expect(context).toContain('"identityResolved":false');
    expect(context).toContain("同名人物或相似关键词不足以建立关联");
    expect(context).toContain(existing.id);
    expect(context).toContain(existing.title);
    expect(context).toContain('"matchMode":"fuzzy"');
    expect(context).not.toContain("新招聘记录 34");
  });

  it("does not inject unrelated recency fallback rows", async () => {
    await createItem(env.DB, {
      type: "note",
      title: "最近但无关的记录",
      content: "不应因更新时间被注入",
      rawMessage: "无关记录",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "unrelated-context-row",
    });

    await expect(loadTurnItemContext(env, principal, "完全不存在的独特对象"))
      .resolves.toBe("");
  });
});
