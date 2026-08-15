import { describe, expect, it } from "vitest";
import { TelegramAdapter } from "../src/channels/telegram";
import { testConfig } from "./helpers";

describe("Telegram adapter", () => {
  it("rejects a missing webhook secret before parsing", async () => {
    const adapter = new TelegramAdapter(testConfig(), "token", "secret");
    const request = new Request("https://worker.test/webhooks/telegram", { method: "POST", body: "not-json" });
    await expect(adapter.parseWebhook(request)).resolves.toEqual({ kind: "unauthorized" });
  });

  it("normalizes an allowlisted message", async () => {
    const adapter = new TelegramAdapter(testConfig(), "token", "secret");
    const request = new Request("https://worker.test/webhooks/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: JSON.stringify({ update_id: 7, message: { message_id: 8, date: 1_786_756_800, text: "记一下", from: { id: 42 }, chat: { id: 42 } } }),
    });
    const parsed = await adapter.parseWebhook(request);
    expect(parsed).toMatchObject({
      kind: "message",
      message: { channel: "telegram", eventId: "update:7", messageId: "8", userId: "42", text: "记一下" },
    });
  });

  it("serializes inline actions", async () => {
    let body: unknown;
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON body");
      body = JSON.parse(init.body) as unknown;
      return Response.json({ ok: true, result: { message_id: 99 } });
    };
    const adapter = new TelegramAdapter(testConfig(), "token", "secret", fetcher);
    const receipt = await adapter.send({ channel: "telegram", userId: "42" }, {
      text: "提醒",
      buttons: [[{ label: "Done", action: "done:item-1", style: "primary" }]],
    });
    expect(body).toMatchObject({
      chat_id: "42",
      reply_markup: { inline_keyboard: [[{ text: "Done", callback_data: "done:item-1" }]] },
    });
    expect(receipt).toMatchObject({ channel: "telegram", messageId: "99" });
  });
});
