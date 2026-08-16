import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AgentPrincipal } from "../src/agent/context";
import { loadOwnedItem, memorySearch, readOwnedWebPages } from "../src/agent/tools/read";
import { createItem } from "../src/db/items";

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
});
