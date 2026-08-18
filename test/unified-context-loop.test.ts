import type {
  LanguageModelV4,
  LanguageModelV4GenerateResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { env } from "cloudflare:workers";
import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentPrincipal } from "../src/agent/context";
import { readOwnedMedia } from "../src/agent/tools/media";
import { rememberContextSchema, rememberOwnedPlanningContext } from "../src/agent/tools/context-memory";
import { updateOwnedItem, updateItemSchema } from "../src/agent/tools/write";
import type { IncomingMessage } from "../src/core/types";
import { searchOwnedContext } from "../src/db/context-memory";
import { createItem, getItem } from "../src/db/items";
import { saveIncomingMediaAssets } from "../src/db/media";

const usage: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

class UnifiedContextModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "composa-test";
  readonly modelId = "unified-context-loop";
  readonly supportedUrls = {};
  private call = 0;

  public constructor(
    private readonly attachmentId: string,
    private readonly meetingId: string,
  ) {}

  doGenerate(): PromiseLike<LanguageModelV4GenerateResult> {
    this.call += 1;
    if (this.call === 1) return Promise.resolve(this.toolCall("media-1", "media_read", { attachmentIds: [this.attachmentId] }));
    if (this.call === 2) {
      return Promise.resolve(this.toolCall("update-1", "item_update", {
        itemId: this.meetingId,
        content: "NEUDM 组会材料：图片展示 Amiya APP 当前 issues、PRs 与周五成品展示要求。",
        structuredData: { people: ["Ivy"], organizations: ["NEUDM"], topics: ["Amiya APP"] },
      }));
    }
    if (this.call === 3) {
      return Promise.resolve(this.toolCall("context-1", "context_remember", {
        entities: [
          { key: "ivy", kind: "person", name: "Ivy", aliases: [] },
          { key: "neudm", kind: "team", name: "NEUDM", aliases: [] },
        ],
        facts: [{
          subject: "ivy",
          predicate: "project_context",
          value: "Amiya APP",
          contextItemId: this.meetingId,
          confidence: 0.9,
        }],
        itemLinks: [
          { itemId: this.meetingId, entity: "ivy", role: "participant", confidence: 1 },
          { itemId: this.meetingId, entity: "neudm", role: "organizer", confidence: 1 },
        ],
      }));
    }
    return Promise.resolve({
      content: [{ type: "text", text: "已读取图片并更新组会材料；Ivy 和 NEUDM 已作为这次会议的上下文保存。" }],
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

describe("unified media and context Agent loop", () => {
  it("turns one image message into durable item content and planning relationships", async () => {
    const principal: AgentPrincipal = {
      channel: "qq",
      userId: "unified-loop-owner",
      eventId: "unified-loop-event",
      receivedAt: "2026-08-18T06:35:19.000Z",
    };
    const incoming: IncomingMessage = {
      channel: principal.channel,
      eventId: principal.eventId,
      messageId: "unified-loop-message",
      userId: principal.userId,
      text: "组会要讲这个，记录一下",
      timestamp: principal.receivedAt,
      eventType: "message",
      attachments: [{
        kind: "image",
        context: "quoted",
        url: "https://multimedia.nt.qq.com.cn/download?temporary=signed",
        mediaType: null,
        filename: null,
      }],
    };
    const [asset] = await saveIncomingMediaAssets(env.DB, incoming);
    if (!asset) throw new Error("Expected asset");
    const meeting = await createItem(env.DB, {
      type: "note",
      title: "NEUDM 组会材料",
      content: "待读取图片",
      rawMessage: incoming.text,
      temporalRole: "none",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "unified-loop-note",
    });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const tools: ToolSet = {
      media_read: tool({
        description: "Read media",
        inputSchema: z.object({ attachmentIds: z.array(z.string().uuid()) }),
        execute: () => readOwnedMedia(
          env,
          principal,
          { attachmentIds: [asset.id] },
          async () => new Response(jpeg),
          async () => ({ text: "图片 1：Amiya APP issues、PRs 和周五展示", model: "test-model", analyzedImageCount: 1 }),
        ),
      }),
      item_update: tool({
        description: "Update item",
        inputSchema: updateItemSchema,
        execute: (input) => updateOwnedItem(env, principal, input),
      }),
      context_remember: tool({
        description: "Remember context",
        inputSchema: rememberContextSchema,
        execute: (input) => rememberOwnedPlanningContext(env, principal, input),
      }),
    };
    const model = new UnifiedContextModel(asset.id, meeting.id);
    const result = await generateText({
      model,
      tools,
      stopWhen: stepCountIs(6),
      prompt: incoming.text,
    });

    expect(result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName))).toEqual([
      "media_read",
      "item_update",
      "context_remember",
    ]);
    const updatedMeeting = await getItem(env.DB, meeting.id);
    expect(updatedMeeting).toMatchObject({
      type: "note",
      status: "open",
    });
    expect(updatedMeeting?.content).toContain("Amiya APP 当前 issues");
    await expect(searchOwnedContext(env.DB, principal.channel, principal.userId, "下次和 Ivy 讨论 Amiya APP"))
      .resolves.toMatchObject({
        entities: [expect.objectContaining({ name: "Ivy", linkedItems: [expect.objectContaining({ itemId: meeting.id })] })],
      });
    expect(result.text).toContain("已读取图片");
  });
});
