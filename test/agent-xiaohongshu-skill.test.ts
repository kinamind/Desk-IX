import { env } from "cloudflare:workers";
import { SkillRegistry } from "agents/skills";
import { describe, expect, it } from "vitest";
import type { AgentPrincipal } from "../src/agent/context";
import { XIAOHONGSHU_SKILL_NAMES, xiaohongshuSkillSource } from "../src/agent/skills/xiaohongshu";
import { readOwnedXiaohongshuPosts } from "../src/agent/tools/xiaohongshu";
import { createItem } from "../src/db/items";

const noteId = "6a827aa90000000033019519";
const postUrl = `https://www.xiaohongshu.com/explore/${noteId}`;

function authenticatedPage(): string {
  return `<script>window.__INITIAL_STATE__={"user":{"loggedIn":true},"note":{"noteDetailMap":{"${noteId}":{"note":{"noteId":"${noteId}","title":"研究中心招聘","desc":"招聘研究助理","user":{"nickname":"AiAT"},"tagList":[{"name":"招聘"}],"imageList":[]}}}}}</script>`;
}

describe("Xiaohongshu Agent skill", () => {
  it("publishes an on-demand skill for links, cards, and adjacent contextual instructions", async () => {
    const descriptors = await xiaohongshuSkillSource.list();
    expect(descriptors.map((descriptor) => descriptor.name)).toEqual(XIAOHONGSHU_SKILL_NAMES);
    expect(descriptors[0]?.description).toContain("QQ 小红书分享卡片");
    expect(descriptors[0]?.description).toContain("整理这个");

    const loaded = await xiaohongshuSkillSource.load("xiaohongshu-organize");
    expect(loaded?.body).toContain("不得要求用户重发");
    expect(loaded?.body).toContain("xiaohongshu_read");
    expect(loaded?.body).toContain("status=read");
    expect(loaded?.body).toContain("mediaTextStatus=not_extracted");
    expect(loaded?.body).toContain("同一条记录");
    expect(loaded?.body).toContain("只决定不要再次 `item_create`");
    expect(loaded?.body).toContain("就必须再次调用 `xiaohongshu_read`");
    expect(loaded?.body).toContain("去重不能排在读取之前并终止流程");

    const registry = new SkillRegistry([xiaohongshuSkillSource]);
    await registry.load();
    expect((await registry.snapshot()).catalogPrompt).toContain("xiaohongshu-organize");
    expect(registry.warnings).toEqual([]);
  });

  it("reads every explicit Xiaohongshu URL from an owned item without exposing the session", async () => {
    const principal: AgentPrincipal = {
      channel: "qq",
      userId: "xhs-owner",
      eventId: "xhs-read-event",
      receivedAt: "2026-08-17T12:10:47.000Z",
    };
    const item = await createItem(env.DB, {
      type: "resource",
      title: "研究中心招聘",
      content: `待核实 ${postUrl}`,
      rawMessage: `QQ 小红书卡片 ${postUrl}`,
      status: "raw",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "xhs-card-event",
    });
    const fetcher: typeof fetch = async () => new Response(authenticatedPage(), {
      headers: { "content-type": "text/html" },
    });

    const result = await readOwnedXiaohongshuPosts(env, principal, { itemId: item.id }, fetcher);
    expect(result).toMatchObject({
      itemId: item.id,
      requestedUrls: [postUrl],
      posts: [{ requestedUrl: postUrl, result: { status: "read", title: "研究中心招聘" } }],
      failures: [],
    });
    expect(JSON.stringify(result)).not.toContain("test-session");

    await expect(readOwnedXiaohongshuPosts(env, { ...principal, userId: "someone-else" }, {
      itemId: item.id,
    }, fetcher)).rejects.toThrow("current user's memory");
  });
});
