import { describe, expect, it } from "vitest";
import type { AIProvider } from "../src/ai/provider";
import { enrichItemFromUrls } from "../src/core/item-enrichment";
import type { Item } from "../src/core/types";
import { testConfig } from "./helpers";

const urls = [
  "https://jobs.example/notice",
  "https://institute.example/center",
  "https://faculty.example/team",
];

function recruitmentItem(): Item {
  return {
    id: "59e020fd-14de-41fa-b1e9-46ce4ac59c49",
    type: "note",
    title: "这个招聘信息帮我记录一下",
    content: `招聘信息：\n${urls.join("\n")}`,
    rawMessage: "这个招聘信息帮我记录一下",
    url: null,
    tags: [],
    status: "open",
    priority: "normal",
    estimatedDuration: null,
    createdAt: "2026-08-15T04:36:01.339Z",
    updatedAt: "2026-08-16T08:02:48.581Z",
    completedAt: null,
    dueAt: null,
    startAfter: null,
    originalTimeExpression: null,
    sourceChannel: "qq",
    sourceUserId: "me",
    sourceMessageId: "old-message",
    sourceActionIndex: 0,
    aiEnrichment: {},
    metadata: {},
    parentId: null,
    embeddingId: null,
  };
}

describe("item webpage enrichment", () => {
  it("reads three recruitment pages and produces one evidence-bounded dossier", async () => {
    const fetched: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetched.push(url);
      const body = url.includes("jobs")
        ? "<html><head><title>人才招聘</title></head><body>教学科研人员招聘，8月31日截止，申请入口 https://jobs.example/apply</body></html>"
        : url.includes("institute")
          ? "<html><head><title>智能医学文件中心</title></head><body>研究中心方向与岗位介绍，工作地点深圳。</body></html>"
          : "<html><head><title>师资队伍</title></head><body>人工智能研究院团队与导师介绍。</body></html>";
      return new Response(body, { headers: { "content-type": "text/html" } });
    };
    let modelInput = "";
    const provider: AIProvider = {
      generate: (request) => {
        modelInput = request.messages.at(-1)?.content ?? "";
        return Promise.resolve({
          text: JSON.stringify({
            category: "recruitment",
            title: "深圳理工大学人工智能研究院招聘",
            summary: "人工智能研究院及相关中心招聘教学科研人员。",
            organizations: ["深圳理工大学人工智能研究院"],
            roles: ["教学科研人员", "研究中心岗位"],
            locations: ["深圳"],
            requirements: ["以各岗位页面要求为准"],
            deadline: "2026-08-31T15:59:59.000Z",
            application_urls: ["https://jobs.example/apply"],
            tags: ["招聘", "人工智能", "深圳"],
          }),
          model: "test-model",
          inputTokens: 100,
          outputTokens: 80,
        });
      },
    };

    const result = await enrichItemFromUrls(
      recruitmentItem(),
      `记录一下这个招聘信息：\n${urls.join("\n")}`,
      provider,
      testConfig(),
      fetcher,
    );

    expect(fetched).toEqual(urls);
    expect(modelInput).toContain("人才招聘");
    expect(modelInput).toContain("智能医学文件中心");
    expect(modelInput).toContain("师资队伍");
    expect(result).toMatchObject({
      readableSourceCount: 3,
      failedSourceCount: 0,
      primaryUrl: urls[0],
      dossier: {
        category: "recruitment",
        title: "深圳理工大学人工智能研究院招聘",
        organizations: ["深圳理工大学人工智能研究院"],
        roles: ["教学科研人员", "研究中心岗位"],
        locations: ["深圳"],
        deadline: "2026-08-31T15:59:59.000Z",
        source_urls: urls,
      },
    });
  });

  it("keeps a partial dossier when one source cannot be read", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("faculty")) return new Response("blocked", { status: 403 });
      return new Response(`<html><head><title>招聘来源</title></head><body>深圳招聘，来源 ${url}</body></html>`, {
        headers: { "content-type": "text/html" },
      });
    };
    const provider: AIProvider = {
      generate: () => Promise.resolve({
        text: JSON.stringify({
          category: "recruitment",
          title: "深圳研究岗位招聘",
          summary: "两个公开页面可读取，一个页面被拒绝。",
          organizations: [],
          roles: ["研究岗位"],
          locations: ["深圳"],
          requirements: [],
          deadline: null,
          application_urls: [],
          tags: ["招聘"],
        }),
        model: "test-model",
        inputTokens: 50,
        outputTokens: 30,
      }),
    };

    const result = await enrichItemFromUrls(recruitmentItem(), urls.join("\n"), provider, testConfig(), fetcher);

    expect(result).toMatchObject({ readableSourceCount: 2, failedSourceCount: 1 });
    expect(result?.sources).toEqual([
      expect.objectContaining({ requested_url: urls[0], fetch_status: "ok" }),
      expect.objectContaining({ requested_url: urls[1], fetch_status: "ok" }),
      expect.objectContaining({ requested_url: urls[2], fetch_status: "failed", error: "Upstream returned HTTP 403" }),
    ]);
  });

  it("uses the user's instruction to parse a paper instead of applying recruitment fields", async () => {
    const paperItem = {
      ...recruitmentItem(),
      title: "帮我记录这篇论文",
      content: "https://paper.example/method",
      rawMessage: "帮我记录这篇论文，重点看方法",
    };
    const fetcher: typeof fetch = async () => new Response(
      "<html><head><title>Agent Memory Paper</title></head><body>Authors: A. Chen. We propose a bounded episodic retrieval method and evaluate it on three tasks.</body></html>",
      { headers: { "content-type": "text/html" } },
    );
    let modelInput = "";
    const provider: AIProvider = {
      generate: (request) => {
        modelInput = request.messages.at(-1)?.content ?? "";
        return Promise.resolve({
          text: JSON.stringify({
            category: "paper",
            title: "Agent Memory Paper",
            summary: "提出有界情景检索方法，并在三个任务上评估。",
            organizations: [],
            people: ["A. Chen"],
            topics: ["Agent memory", "episodic retrieval"],
            key_points: ["使用有界情景检索", "在三个任务上评估"],
            roles: [],
            locations: [],
            requirements: [],
            actions: [],
            deadline: null,
            application_urls: [],
            tags: ["论文", "Agent memory"],
          }),
          model: "test-model",
          inputTokens: 50,
          outputTokens: 40,
        });
      },
    };

    const result = await enrichItemFromUrls(
      paperItem,
      "帮我记录这篇论文，重点看方法 https://paper.example/method",
      provider,
      testConfig(),
      fetcher,
    );

    expect(modelInput).toContain("重点看方法");
    expect(result?.dossier).toMatchObject({
      category: "paper",
      people: ["A. Chen"],
      topics: ["Agent memory", "episodic retrieval"],
      key_points: ["使用有界情景检索", "在三个任务上评估"],
      roles: [],
    });
  });
});
