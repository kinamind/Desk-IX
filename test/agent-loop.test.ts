import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { env } from "cloudflare:workers";
import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentPrincipal } from "../src/agent/context";
import { loadOwnedItem, memorySearch, readOwnedWebPages } from "../src/agent/tools/read";
import { updateOwnedItem } from "../src/agent/tools/write";
import { createItem, getItem } from "../src/db/items";

const usage: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

class RecruitmentLoopModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "composa-test";
  readonly modelId = "native-tool-loop";
  readonly supportedUrls = {};
  readonly prompts: LanguageModelV4CallOptions["prompt"][] = [];
  private call = 0;

  constructor(private readonly itemId: string) {}

  doGenerate(options: LanguageModelV4CallOptions): PromiseLike<LanguageModelV4GenerateResult> {
    this.prompts.push(options.prompt);
    this.call += 1;
    if (this.call === 1) return Promise.resolve(this.toolCall("search-1", "memory_search", { query: "深圳理工大学 招聘" }));
    if (this.call === 2) return Promise.resolve(this.toolCall("get-1", "item_get", { itemId: this.itemId }));
    if (this.call === 3) return Promise.resolve(this.toolCall("read-1", "web_read", { itemId: this.itemId }));
    if (this.call === 4) {
      return Promise.resolve(this.toolCall("update-1", "item_update", {
        itemId: this.itemId,
        title: "深圳理工大学人工智能研究院招聘",
        content: "招聘教学科研人员，申请材料包括简历与研究计划。",
        structuredData: {
          category: "recruitment",
          organizations: ["深圳理工大学人工智能研究院"],
          roles: ["教学科研人员"],
        },
        provenance: { sourceUrls: ["https://jobs.example/notice"] },
      }));
    }
    return Promise.resolve({
      content: [{ type: "text", text: "已读取原记录中的招聘网页，并更新了同一条深圳理工大学招聘信息。" }],
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

describe("native agent tool loop", () => {
  it("chains memory, item, web, and update tools instead of matching a scenario branch", async () => {
    const principal: AgentPrincipal = {
      channel: "qq",
      userId: "qq-user-42",
      eventId: "loop-update-recruitment",
      receivedAt: "2026-08-16T09:39:33.000Z",
    };
    const item = await createItem(env.DB, {
      type: "resource",
      title: "这个招聘信息帮我记录一下",
      content: "招聘信息 https://jobs.example/notice",
      rawMessage: "招聘信息 https://jobs.example/notice",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "old-recruitment-message",
    });
    const fetcher: typeof fetch = async () => new Response(
      "<html><head><title>人才招聘</title></head><body>深圳理工大学人工智能研究院招聘教学科研人员，申请材料包括简历与研究计划。</body></html>",
      { headers: { "content-type": "text/html" } },
    );
    const tools: ToolSet = {
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
      web_read: tool({
        description: "Read item links",
        inputSchema: z.object({ itemId: z.string().uuid() }),
        execute: ({ itemId }) => readOwnedWebPages(env, principal, { itemId }, fetcher),
      }),
      item_update: tool({
        description: "Update item",
        inputSchema: z.object({
          itemId: z.string().uuid(),
          title: z.string(),
          content: z.string(),
          structuredData: z.record(z.string(), z.unknown()),
          provenance: z.object({ sourceUrls: z.array(z.string().url()) }),
        }),
        execute: (input) => updateOwnedItem(env, principal, input),
      }),
    };
    const model = new RecruitmentLoopModel(item.id);

    const result = await generateText({
      model,
      tools,
      stopWhen: stepCountIs(6),
      prompt: "根据刚才的链接内容更新一下深圳理工大学的招聘信息",
    });

    expect(result.text).toContain("更新了同一条");
    expect(result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName))).toEqual([
      "memory_search",
      "item_get",
      "web_read",
      "item_update",
    ]);
    expect(model.prompts).toHaveLength(5);
    await expect(getItem(env.DB, item.id)).resolves.toMatchObject({
      id: item.id,
      title: "深圳理工大学人工智能研究院招聘",
      aiEnrichment: {
        category: "recruitment",
        roles: ["教学科研人员"],
      },
    });
  });
});
