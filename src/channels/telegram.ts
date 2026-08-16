import { z } from "zod";
import type { RuntimeConfig } from "../config";
import type { CallbackAction, ChannelTarget, DeliveryReceipt, IncomingMessage, OutgoingMessage } from "../core/types";
import { readBoundedText } from "../http/body";
import { constantTimeEqual } from "../security/crypto";
import { fetchWithRetry } from "./http";
import type { ChannelAdapter, WebhookResult } from "./types";

const userSchema = z.object({ id: z.union([z.number(), z.string()]) });
const messageSchema = z.object({
  message_id: z.number(),
  date: z.number().optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  from: userSchema.optional(),
  chat: z.object({ id: z.union([z.number(), z.string()]) }),
});
const updateSchema = z.object({
  update_id: z.number(),
  message: messageSchema.optional(),
  edited_message: messageSchema.optional(),
  callback_query: z.object({
    id: z.string(),
    from: userSchema,
    data: z.string().optional(),
    message: messageSchema.optional(),
  }).optional(),
});
const sendResponseSchema = z.object({ ok: z.boolean(), result: z.object({ message_id: z.number() }).optional() });

function parseCallback(data: string, interactionId: string): CallbackAction | null {
  const [name, itemId, value] = data.split(":");
  if (!name || !itemId || !["done", "archive", "restore", "later", "reschedule", "details"].includes(name)) return null;
  return {
    name: name as CallbackAction["name"],
    itemId,
    ...(value ? { value } : {}),
    interactionId,
  };
}

export class TelegramAdapter implements ChannelAdapter {
  public constructor(
    private readonly config: RuntimeConfig,
    private readonly botToken: string,
    private readonly webhookSecret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async parseWebhook(request: Request): Promise<WebhookResult> {
    if (!this.webhookSecret || !await constantTimeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", this.webhookSecret)) {
      return { kind: "unauthorized" };
    }
    const raw = await readBoundedText(request, 1_000_000);
    const update = updateSchema.parse(JSON.parse(raw) as unknown);

    if (update.callback_query) {
      const userId = String(update.callback_query.from.id);
      if (!this.config.telegramAllowedUserIds.has(userId)) return { kind: "unauthorized" };
      const callback = parseCallback(update.callback_query.data ?? "", update.callback_query.id);
      const callbackMessage = update.callback_query.message;
      if (!callback || !callbackMessage) return { kind: "ignored" };
      const incoming: IncomingMessage = {
        channel: "telegram",
        eventId: `callback:${update.callback_query.id}`,
        messageId: String(callbackMessage.message_id),
        userId,
        text: update.callback_query.data ?? "",
        timestamp: new Date().toISOString(),
        eventType: "callback",
        callback,
        replyToMessageId: String(callbackMessage.message_id),
      };
      return { kind: "message", message: incoming };
    }

    const message = update.message ?? update.edited_message;
    if (!message?.from) return { kind: "ignored" };
    const userId = String(message.from.id);
    if (!this.config.telegramAllowedUserIds.has(userId)) return { kind: "unauthorized" };
    const text = (message.text ?? message.caption ?? "").trim();
    if (!text) return { kind: "ignored" };
    return {
      kind: "message",
      message: {
        channel: "telegram",
        eventId: `update:${update.update_id}`,
        messageId: String(message.message_id),
        userId,
        text,
        timestamp: new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        eventType: "message",
        replyToMessageId: String(message.message_id),
      },
    };
  }

  public async send(target: ChannelTarget, message: OutgoingMessage): Promise<DeliveryReceipt> {
    if (!this.botToken) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
    const payload: Record<string, unknown> = {
      chat_id: target.userId,
      text: message.text,
      disable_web_page_preview: true,
    };
    if (message.replyToMessageId) {
      payload.reply_parameters = { message_id: Number(message.replyToMessageId), allow_sending_without_reply: true };
    }
    if (message.buttons && message.buttons.length > 0) {
      payload.reply_markup = {
        inline_keyboard: message.buttons.map((row) => row.map((button) => ({
          text: button.label,
          callback_data: button.action,
        }))),
      };
    }

    const response = await fetchWithRetry(
      this.fetcher,
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    );
    const parsed = sendResponseSchema.parse(await response.json());
    if (!parsed.ok || !parsed.result) throw new Error("Telegram sendMessage returned an invalid success response");
    return { channel: "telegram", messageId: String(parsed.result.message_id), deliveredAt: new Date().toISOString() };
  }

  public async acknowledge(interactionId: string, code: number): Promise<void> {
    if (!this.botToken) return;
    await fetchWithRetry(this.fetcher, `https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: interactionId, text: code === 0 ? "已处理" : "操作失败", show_alert: code !== 0 }),
    });
  }
}
