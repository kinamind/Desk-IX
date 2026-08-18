import { describe, expect, it } from "vitest";
import { QQAdapter } from "../src/channels/qq";
import { testConfig } from "./helpers";

const officialSecret = "naOC0ocQE3shWLAfffVLB1rhYPG7";
const officialChallengeSecret = "DG5g3B4j9X2KOErG";

function qqRequest(body: string, signature: string, timestamp = "1725442341"): Request {
  return new Request("https://worker.test/webhooks/qq", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bot-Appid": "test-app",
      "X-Signature-Timestamp": timestamp,
      "X-Signature-Ed25519": signature,
    },
    body,
  });
}

describe("QQ adapter", () => {
  it("matches the official webhook challenge signature vector", async () => {
    const adapter = new QQAdapter(testConfig(), officialChallengeSecret);
    const body = JSON.stringify({ op: 13, d: { plain_token: "Arq0D5A61EgUu4OxUvOp", event_ts: "1725442341" } });
    const parsed = await adapter.parseWebhook(qqRequest(body, "unused"));
    expect(parsed.kind).toBe("challenge");
    if (parsed.kind !== "challenge") throw new Error("Expected challenge");
    expect(parsed.response.status).toBe(200);
    expect(parsed.response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    await expect(parsed.response.json()).resolves.toEqual({
      plain_token: "Arq0D5A61EgUu4OxUvOp",
      signature: "87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706",
    });
  });

  it("checks the app id before exposing the challenge signer", async () => {
    const adapter = new QQAdapter(testConfig(), officialSecret);
    const request = new Request("https://worker.test/webhooks/qq", {
      method: "POST",
      headers: { "X-Bot-Appid": "another-app" },
      body: JSON.stringify({ op: 13, d: { plain_token: "token", event_ts: "1" } }),
    });
    await expect(adapter.parseWebhook(request)).resolves.toEqual({ kind: "unauthorized" });
  });

  it("verifies and normalizes a C2C message", async () => {
    const adapter = new QQAdapter(testConfig(), officialSecret);
    const body = JSON.stringify({
      id: "event-1",
      op: 0,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "message-1",
        author: { user_openid: "qq-user-42" },
        content: "提醒我明天交报告",
        timestamp: "2026-08-15T02:00:00.000Z",
        message_scene: { ext: ["msg_idx=2"] },
      },
    });
    const signature = adapter.signChallenge("1725442341", body);
    await expect(adapter.parseWebhook(qqRequest(body, signature))).resolves.toMatchObject({
      kind: "message",
      message: {
        channel: "qq",
        eventId: "c2c:message-1:2",
        messageId: "message-1",
        userId: "qq-user-42",
      },
    });
  });

  it("extracts preview text and ordinary URLs from QQ card fields", async () => {
    const adapter = new QQAdapter(testConfig(), officialSecret);
    const body = JSON.stringify({
      id: "event-card",
      op: 0,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "message-card",
        author: { user_openid: "qq-user-42" },
        content: "这个招聘信息帮我记录一下",
        timestamp: "2026-08-15T02:00:00.000Z",
        ark_data: {
          prompt: "研究助理招聘",
          fields: { desc: "周五截止", jump_url: "https://example.com/jobs/ra" },
        },
      },
    });
    const signature = adapter.signChallenge("1725442341", body);
    const parsed = await adapter.parseWebhook(qqRequest(body, signature));
    expect(parsed).toMatchObject({ kind: "message" });
    if (parsed.kind !== "message") throw new Error("Expected message");
    expect(parsed.message.text).toContain("研究助理招聘");
    expect(parsed.message.text).toContain("https://example.com/jobs/ra");
  });

  it("preserves a QQ image as structured media without flattening its signed URL into instructions", async () => {
    const adapter = new QQAdapter(testConfig(), officialSecret);
    const imageUrl = "https://multimedia.nt.qq.com.cn/download?fileid=temporary&rkey=signed";
    const body = JSON.stringify({
      id: "event-image",
      op: 0,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "message-image",
        author: { user_openid: "qq-user-42" },
        content: "",
        timestamp: "2026-08-18T06:35:19.000Z",
        attachments: [{ url: imageUrl, content_type: "image/jpeg", filename: "meeting.jpg" }],
      },
    });
    const signature = adapter.signChallenge("1725442341", body);
    const parsed = await adapter.parseWebhook(qqRequest(body, signature));

    expect(parsed).toMatchObject({ kind: "message" });
    if (parsed.kind !== "message") throw new Error("Expected message");
    expect(parsed.message.text).toContain("附件");
    expect(parsed.message.text).not.toContain(imageUrl);
    expect(parsed.message.attachments).toEqual([{
      kind: "image",
      context: "current",
      url: imageUrl,
      mediaType: "image/jpeg",
      filename: "meeting.jpg",
    }]);
  });

  it("preserves the quoted message body for QQ reference messages", async () => {
    const adapter = new QQAdapter(testConfig(), officialSecret);
    const body = JSON.stringify({
      id: "event-reference",
      op: 0,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "message-reference",
        author: { user_openid: "qq-user-42" },
        content: "这个还没完成，明天继续提醒我",
        timestamp: "2026-08-17T02:00:00.000Z",
        message_type: 103,
        message_scene: {
          ext: ["ref_msg_idx=reference-reminder", "msg_idx=current-message"],
        },
        msg_elements: [
          {
            msg_idx: "reference-reminder",
            message_type: 0,
            content: "🔔 找人帮忙转发 ResWork 实验招募被试",
          },
        ],
      },
    });
    const signature = adapter.signChallenge("1725442341", body);
    const parsed = await adapter.parseWebhook(qqRequest(body, signature));

    expect(parsed).toMatchObject({ kind: "message" });
    if (parsed.kind !== "message") throw new Error("Expected message");
    expect(parsed.message.text).toBe([
      "[引用消息]",
      "🔔 找人帮忙转发 ResWork 实验招募被试",
      "[/引用消息]",
      "[当前消息]",
      "这个还没完成，明天继续提醒我",
    ].join("\n"));
    expect(parsed.message.eventId).toBe("c2c:message-reference:current-message");
  });

  it("preserves quoted image attachments as reference evidence", async () => {
    const adapter = new QQAdapter(testConfig(), officialSecret);
    const imageUrl = "https://multimedia.nt.qq.com.cn/download?fileid=quoted&rkey=signed";
    const body = JSON.stringify({
      id: "event-reference-image",
      op: 0,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "message-reference-image",
        author: { user_openid: "qq-user-42" },
        content: "组会要讲这个，记录一下",
        timestamp: "2026-08-18T06:35:50.000Z",
        message_type: 103,
        message_scene: { ext: ["ref_msg_idx=reference-image", "msg_idx=current-image-instruction"] },
        msg_elements: [{
          msg_idx: "reference-image",
          attachments: [{ url: imageUrl, content_type: "image/jpeg" }],
        }],
      },
    });
    const signature = adapter.signChallenge("1725442341", body);
    const parsed = await adapter.parseWebhook(qqRequest(body, signature));

    expect(parsed).toMatchObject({ kind: "message" });
    if (parsed.kind !== "message") throw new Error("Expected message");
    expect(parsed.message.text).toContain("[引用消息]");
    expect(parsed.message.text).toContain("[附件]");
    expect(parsed.message.text).toContain("组会要讲这个，记录一下");
    expect(parsed.message.text).not.toContain(imageUrl);
    expect(parsed.message.attachments).toEqual([
      expect.objectContaining({ kind: "image", context: "quoted", url: imageUrl }),
    ]);
  });

  it("never truncates the current instruction behind a long quoted message", async () => {
    const adapter = new QQAdapter(testConfig(), officialSecret);
    const body = JSON.stringify({
      id: "event-long-reference",
      op: 0,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "message-long-reference",
        author: { user_openid: "qq-user-42" },
        content: "把引用的这件事改到明晚，不是新建",
        timestamp: "2026-08-17T02:00:00.000Z",
        message_type: 103,
        message_scene: { ext: ["ref_msg_idx=long-reference", "msg_idx=current-long-message"] },
        msg_elements: [{
          msg_idx: "long-reference",
          message_type: 0,
          content: `旧事项 ${"背景".repeat(20_000)}`,
        }],
      },
    });
    const signature = adapter.signChallenge("1725442341", body);
    const parsed = await adapter.parseWebhook(qqRequest(body, signature));

    expect(parsed).toMatchObject({ kind: "message" });
    if (parsed.kind !== "message") throw new Error("Expected message");
    expect(parsed.message.text).toContain("[引用消息]");
    expect(parsed.message.text).toContain("[当前消息]\n把引用的这件事改到明晚，不是新建");
  });

  it("rejects a tampered body", async () => {
    const adapter = new QQAdapter(testConfig(), officialSecret);
    const valid = JSON.stringify({ op: 0, t: "UNKNOWN", d: {} });
    const signature = adapter.signChallenge("1725442341", valid);
    const tampered = JSON.stringify({ op: 0, t: "OTHER", d: {} });
    await expect(adapter.parseWebhook(qqRequest(tampered, signature))).resolves.toEqual({ kind: "unauthorized" });
  });

  it("fetches an app token and sends a C2C keyboard", async () => {
    const calls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      if (url.endsWith("/app/getAppAccessToken")) return Response.json({ access_token: "access", expires_in: "7200" });
      return Response.json({ id: "qq-reply-1", timestamp: "2026-08-15T02:00:01.000Z" });
    };
    const adapter = new QQAdapter(testConfig(), officialSecret, fetcher);
    const receipt = await adapter.send({ channel: "qq", userId: "qq-user-42" }, {
      text: "提醒",
      buttons: [[{ label: "完成", action: "done:item-1", style: "primary" }]],
    });
    expect(calls[0]).toMatchObject({ body: { appId: "test-app", clientSecret: officialSecret }, authorization: null });
    expect(calls[1]).toMatchObject({
      url: "https://api.bot.qq.com/v2/users/qq-user-42/messages",
      authorization: "QQBot access",
      body: { content: "提醒", msg_type: 0 },
    });
    expect(calls[1]?.body).toHaveProperty("keyboard.content.rows.0.buttons.0.action.data", "done:item-1");
    expect(receipt).toEqual({ channel: "qq", messageId: "qq-reply-1", deliveredAt: "2026-08-15T02:00:01.000Z" });
  });

  it("falls back to text when the QQ app lacks custom-keyboard permission", async () => {
    const messageBodies: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/app/getAppAccessToken")) return Response.json({ access_token: "access", expires_in: 7200 });
      if (typeof init?.body !== "string") throw new Error("Expected JSON body");
      messageBodies.push(JSON.parse(init.body) as unknown);
      if (messageBodies.length === 1) return new Response("keyboard denied", { status: 403 });
      return Response.json({ id: "plain-reply" });
    };
    const adapter = new QQAdapter(testConfig(), officialSecret, fetcher);
    await expect(adapter.send({ channel: "qq", userId: "qq-user-42" }, {
      text: "提醒",
      buttons: [[{ label: "完成", action: "done:item-1" }]],
    })).resolves.toMatchObject({ messageId: "plain-reply" });
    expect(messageBodies[0]).toHaveProperty("keyboard");
    expect(messageBodies[1]).not.toHaveProperty("keyboard");
  });
});
