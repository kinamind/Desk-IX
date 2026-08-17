import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { env } from "cloudflare:workers";
import { SkillRegistry } from "agents/skills";
import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentPrincipal } from "../src/agent/context";
import { xiaohongshuSkillSource } from "../src/agent/skills/xiaohongshu";
import { loadOwnedItem, memorySearch } from "../src/agent/tools/read";
import { updateOwnedItem } from "../src/agent/tools/write";
import { readOwnedXiaohongshuPosts } from "../src/agent/tools/xiaohongshu";
import { createItem, getItem } from "../src/db/items";

const usage: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const noteId = "6a827aa90000000033019519";
const postUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=test-share`;

class XiaohongshuLoopModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "desk-ix-test";
  readonly modelId = "xiaohongshu-skill-loop";
  readonly supportedUrls = {};
  readonly prompts: LanguageModelV4CallOptions["prompt"][] = [];
  private call = 0;

  public constructor(private readonly itemId: string) {}

  doGenerate(options: LanguageModelV4CallOptions): PromiseLike<LanguageModelV4GenerateResult> {
    this.prompts.push(options.prompt);
    this.call += 1;
    if (this.call === 1) return Promise.resolve(this.toolCall("skill-1", "activate_skill", { name: "xiaohongshu-organize" }));
    if (this.call === 2) return Promise.resolve(this.toolCall("search-1", "memory_search", { query: "AiAT 招聘信息" }));
    if (this.call === 3) return Promise.resolve(this.toolCall("get-1", "item_get", { itemId: this.itemId }));
    if (this.call === 4) return Promise.resolve(this.toolCall("xhs-1", "xiaohongshu_read", { itemId: this.itemId }));
    if (this.call === 5) {
      return Promise.resolve(this.toolCall("update-1", "item_update", {
        itemId: this.itemId,
        title: "西湖大学 AiAT 人工智能艺术诊疗研究中心招聘研究助理",
        content: "西湖大学 AiAT 人工智能艺术诊疗研究中心招聘研究助理，申请要求包括个人简历和研究经历说明。",
        tags: ["招聘", "西湖大学", "AiAT", "研究助理"],
        status: "open",
        primaryUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
        structuredData: {
          organization: "西湖大学 AiAT 人工智能艺术诊疗研究中心",
          role: "研究助理",
          applicationMaterials: ["个人简历", "研究经历说明"],
          sourceReadStatus: "full_text",
          mediaTextStatus: "extracted",
          imageRequirements: ["个人简历", "代表作", "研究经历说明"],
        },
        provenance: { sourceUrls: [`https://www.xiaohongshu.com/explore/${noteId}`] },
      }));
    }
    return Promise.resolve({
      content: [{
        type: "text",
        text: "已读完正文和配图并整理到原来的那条招聘记录里：岗位是研究助理，配图列出的申请材料包括个人简历、代表作和研究经历说明。",
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

describe("Xiaohongshu card-to-instruction Agent loop", () => {
  it("continues from the prior QQ card and enriches the same raw record", async () => {
    const principal: AgentPrincipal = {
      channel: "qq",
      userId: "xhs-loop-owner",
      eventId: "xhs-organize-instruction",
      receivedAt: "2026-08-17T12:10:47.000Z",
    };
    const item = await createItem(env.DB, {
      type: "resource",
      title: "西湖大学 AiAT 人工智能艺术诊疗研究中心招聘",
      content: `小红书卡片可见：招聘信息；正文和申请要求待核实。${postUrl}`,
      rawMessage: `QQ 小红书分享卡片 ${postUrl}`,
      url: postUrl,
      status: "raw",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "xhs-card-message",
    });
    const fetcher: typeof fetch = async () => new Response(`<script>window.__INITIAL_STATE__={
      "user":{"loggedIn":true},
      "note":{"noteDetailMap":{"${noteId}":{"note":{
        "noteId":"${noteId}",
        "title":"AiAT 招聘研究助理",
        "desc":"西湖大学 AiAT 人工智能艺术诊疗研究中心招聘研究助理。申请材料：个人简历、研究经历说明。",
        "user":{"nickname":"AiAT"},
        "tagList":[{"name":"招聘"}],
        "imageList":[{"urlDefault":"https://sns-img.example/recruitment.jpg"}]
      }}}}}
    }</script>`, { headers: { "content-type": "text/html" } });

    const registry = new SkillRegistry([xiaohongshuSkillSource]);
    await registry.load();
    const tools: ToolSet = {
      ...registry.tools(),
      memory_search: tool({
        description: "Search memory",
        inputSchema: z.object({ query: z.string() }),
        execute: ({ query }) => memorySearch(env, principal, query),
      }),
      item_get: tool({
        description: "Load item",
        inputSchema: z.object({ itemId: z.string().uuid() }),
        execute: ({ itemId }) => loadOwnedItem(env, principal, itemId),
      }),
      xiaohongshu_read: tool({
        description: "Read Xiaohongshu item links",
        inputSchema: z.object({ itemId: z.string().uuid() }),
        execute: ({ itemId }) => readOwnedXiaohongshuPosts(env, principal, { itemId }, fetcher, async () => ({
          text: "图片 1：申请材料包括个人简历、代表作和研究经历说明。",
          analyzedImageCount: 1,
          skippedImageCount: 0,
        })),
      }),
      item_update: tool({
        description: "Update the existing item",
        inputSchema: z.object({
          itemId: z.string().uuid(),
          title: z.string(),
          content: z.string(),
          tags: z.array(z.string()),
          status: z.enum(["open", "raw", "active"]),
          primaryUrl: z.string().url(),
          structuredData: z.record(z.string(), z.unknown()),
          provenance: z.object({ sourceUrls: z.array(z.string().url()) }),
        }),
        execute: (input) => updateOwnedItem(env, principal, input),
      }),
    };
    const model = new XiaohongshuLoopModel(item.id);
    const result = await generateText({
      model,
      tools,
      stopWhen: stepCountIs(7),
      messages: [
        { role: "user", content: `QQ 小红书分享卡片：西湖大学 AiAT 招聘 ${postUrl}` },
        { role: "assistant", content: "我先按卡片可见信息记下了，正文与申请要求待核实。" },
        { role: "user", content: "帮我整理记录一下这个招聘信息" },
      ],
    });

    expect(result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName))).toEqual([
      "activate_skill",
      "memory_search",
      "item_get",
      "xiaohongshu_read",
      "item_update",
    ]);
    expect(JSON.stringify(model.prompts[1])).toContain("不得要求用户重发");
    expect(result.text).not.toContain("重新发");
    expect(result.text).toContain("原来的那条");
    await expect(getItem(env.DB, item.id)).resolves.toMatchObject({
      id: item.id,
      status: "open",
      title: "西湖大学 AiAT 人工智能艺术诊疗研究中心招聘研究助理",
      aiEnrichment: {
        role: "研究助理",
        sourceReadStatus: "full_text",
        mediaTextStatus: "extracted",
      },
    });
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM items WHERE source_channel = ? AND source_user_id = ?",
    ).bind(principal.channel, principal.userId).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
});
