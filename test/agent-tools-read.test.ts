import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AgentPrincipal } from "../src/agent/context";
import { loadOwnedItem, memorySearch, readOwnedWebPages } from "../src/agent/tools/read";
import { createItem } from "../src/db/items";
import { replaceWorkSessions } from "../src/db/work-sessions";

const principal: AgentPrincipal = {
  channel: "qq",
  userId: "qq-user-42",
  eventId: "agent-read-event",
  receivedAt: "2026-08-16T08:00:00.000Z",
};

describe("agent read capabilities", () => {
  it("resolves a natural reference to the user's existing recruitment item", async () => {
    const item = await createItem(env.DB, {
      type: "resource",
      title: "这个招聘信息帮我记录一下",
      content: "后续需要查看 https://jobs.example/notice",
      rawMessage: "招聘信息 https://jobs.example/notice",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "recruitment-old-message",
    });
    await createItem(env.DB, {
      type: "resource",
      title: "别人的招聘信息",
      content: "不能看到",
      rawMessage: "不能看到",
      sourceChannel: "qq",
      sourceUserId: "another-user",
      sourceMessageId: "recruitment-other-user",
    });

    const result = await memorySearch(env, principal, "深圳理工大学 招聘", 8);

    expect(result.items[0]).toMatchObject({ id: item.id, title: "这个招聘信息帮我记录一下" });
    expect(result.items.some((candidate) => candidate.title === "别人的招聘信息")).toBe(false);
  });

  it("labels recency-only candidates instead of presenting them as lexical matches", async () => {
    await createItem(env.DB, {
      type: "task",
      title: "最近更新但无关的事项",
      content: "不要因为更新时间较近就把它当作用户所指的对象",
      rawMessage: "最近更新但无关的事项",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "unrelated-recent-item",
    });

    const result = await memorySearch(env, principal, "这个", 8);
    expect(result).toMatchObject({
      matchMode: "lexical",
      requiresConversationContext: false,
    });

    const unmatched = await memorySearch(env, principal, "完全不存在的专有名词", 8);
    expect(unmatched).toMatchObject({
      matchMode: "recent_fallback",
      requiresConversationContext: true,
    });
    expect(unmatched.items.length).toBeGreaterThan(0);
  });

  it("reads links stored on the exact owned item and returns bounded content", async () => {
    const item = await createItem(env.DB, {
      type: "resource",
      title: "深圳理工大学招聘",
      content: "来源一 https://jobs.example/one 来源二 https://jobs.example/two",
      rawMessage: "记录招聘网页",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "recruitment-pages",
    });
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(
        `<html><head><title>招聘公告</title></head><body><main>${url} 教学科研岗位，申请材料包括简历和研究计划。</main></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    };

    const result = await readOwnedWebPages(env, principal, { itemId: item.id }, fetcher);

    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]).toMatchObject({ title: "招聘公告", truncated: false });
    expect(result.pages[0]?.text).toContain("教学科研岗位");
  });

  it("rejects cross-user item IDs", async () => {
    const item = await createItem(env.DB, {
      type: "note",
      title: "私有记录",
      content: "仅另一位用户可见",
      rawMessage: "私有记录",
      sourceChannel: "qq",
      sourceUserId: "another-user",
      sourceMessageId: "private-item",
    });

    await expect(loadOwnedItem(env, principal, item.id)).rejects.toThrow("not found");
    await expect(readOwnedWebPages(env, principal, { itemId: item.id })).rejects.toThrow("not found");
  });

  it("loads the owned item's concrete work sessions", async () => {
    const item = await createItem(env.DB, {
      type: "task",
      title: "准备 proposal",
      content: "不要拖到截止前",
      rawMessage: "准备 proposal",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "read-work-sessions",
    });
    await replaceWorkSessions(env.DB, item.id, [{
      startAt: "2026-08-18T11:00:00.000Z",
      endAt: "2026-08-18T13:00:00.000Z",
      label: "proposal 框架",
    }], "先搭框架", new Date("2026-08-17T00:00:00.000Z"));

    await expect(loadOwnedItem(env, principal, item.id)).resolves.toMatchObject({
      workSessions: [{
        itemId: item.id,
        startAt: "2026-08-18T11:00:00.000Z",
        endAt: "2026-08-18T13:00:00.000Z",
        label: "proposal 框架",
        status: "planned",
      }],
    });
  });

  it("finds an older lexical match outside the recent-context window", async () => {
    const old = await createItem(env.DB, {
      type: "project",
      title: "Fiona 的 ResWork proposal",
      content: "需要在截止前准备后续研究方案",
      rawMessage: "ResWork proposal",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "older-lexical-target",
    }, new Date("2026-01-01T00:00:00.000Z"));
    for (let index = 0; index < 35; index += 1) {
      await createItem(env.DB, {
        type: "note",
        title: `无关的近期记录 ${index}`,
        content: "与目标项目无关",
        rawMessage: "无关",
        sourceChannel: "qq",
        sourceUserId: principal.userId,
        sourceMessageId: `newer-unrelated-${index}`,
      }, new Date(`2026-08-${String((index % 15) + 1).padStart(2, "0")}T00:00:00.000Z`));
    }

    const result = await memorySearch(env, principal, "Fiona ResWork proposal", 8);
    expect(result).toMatchObject({ matchMode: "lexical" });
    expect(result.items[0]?.id).toBe(old.id);
  });

  it("recalls an older Chinese item when the user paraphrases it", async () => {
    const existing = await createItem(env.DB, {
      type: "task",
      title: "给由雪伟发送更新后的简历（待处理）",
      content: "更新简历，补充实习经历部分，然后尽早发送给由雪伟。",
      rawMessage: "简历更新后发给由雪伟",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "older-resume-target",
    }, new Date("2026-08-24T04:43:56.401Z"));
    for (let index = 0; index < 35; index += 1) {
      await createItem(env.DB, {
        type: "resource",
        title: `近期招聘记录 ${index}`,
        content: "岗位信息已经整理，之后再看。",
        rawMessage: "招聘分享卡片",
        sourceChannel: "qq",
        sourceUserId: principal.userId,
        sourceMessageId: `newer-recruitment-${index}`,
      }, new Date(`2026-09-01T${String(index % 24).padStart(2, "0")}:00:00.000Z`));
    }

    const result = await memorySearch(env, principal, "等会要给由雪伟发简历", 8);

    expect(result).toMatchObject({
      matchMode: "fuzzy",
      requiresConversationContext: true,
    });
    expect(result.items[0]?.id).toBe(existing.id);
  });

  it("reads every explicitly supplied link instead of stopping at three", async () => {
    const urls = [1, 2, 3, 4].map((index) => `https://example.com/page-${index}`);
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(`<html><body>${url}</body></html>`, { headers: { "content-type": "text/html" } });
    };

    const result = await readOwnedWebPages(env, principal, { urls }, fetcher);
    expect(result.requestedUrls).toEqual(urls);
    expect(result.pages).toHaveLength(4);
  });
});
