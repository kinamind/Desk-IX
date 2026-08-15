import nacl from "tweetnacl";
import { z } from "zod";
import type { RuntimeConfig } from "../config";
import type { CallbackAction, ChannelTarget, DeliveryReceipt, IncomingMessage, OutgoingMessage } from "../core/types";
import { readBoundedText } from "../http/body";
import { log } from "../observability/log";
import { bytesToHex, constantTimeEqual, hexToBytes } from "../security/crypto";
import { ChannelHttpError, fetchWithRetry } from "./http";
import type { ChannelAdapter, WebhookResult } from "./types";

const payloadSchema = z.object({
  id: z.string().optional(),
  op: z.number(),
  t: z.string().optional(),
  d: z.unknown(),
});
const challengeSchema = z.object({ plain_token: z.string(), event_ts: z.string() });
const c2cSchema = z.object({
  id: z.string(),
  author: z.object({ id: z.string().optional(), user_openid: z.string().optional() }),
  content: z.string().default(""),
  timestamp: z.string(),
  message_scene: z.object({ ext: z.array(z.string()).optional() }).optional(),
  attachments: z.array(z.object({ url: z.string().url().optional(), asr_refer_text: z.string().optional() })).optional(),
  ark_data: z.object({ prompt: z.string().optional(), fields: z.record(z.string(), z.unknown()).optional() }).optional(),
});
const interactionSchema = z.object({
  id: z.string(),
  type: z.number(),
  scene: z.string(),
  user_openid: z.string().optional(),
  timestamp: z.string(),
  data: z.object({ resolved: z.object({ button_data: z.string().optional() }) }),
});
const tokenSchema = z.object({ access_token: z.string(), expires_in: z.union([z.string(), z.number()]) });
const sendSchema = z.object({ id: z.string(), timestamp: z.string().optional() });

function deriveKeyPair(secret: string): nacl.SignKeyPair {
  if (!secret) throw new Error("QQ_BOT_SECRET is not configured");
  let seedText = secret;
  while (new TextEncoder().encode(seedText).byteLength < 32) seedText += seedText;
  const seed = new TextEncoder().encode(seedText).slice(0, 32);
  return nacl.sign.keyPair.fromSeed(seed);
}

function concatBytes(left: string, right: string): Uint8Array {
  return new TextEncoder().encode(left + right);
}

function parseAction(data: string, interactionId: string): CallbackAction | null {
  const [name, itemId, value] = data.split(":");
  if (!name || !itemId || !["done", "later", "reschedule", "details"].includes(name)) return null;
  return {
    name: name as CallbackAction["name"],
    itemId,
    ...(value ? { value } : {}),
    interactionId,
  };
}

function messageIndex(ext: string[] | undefined): string | null {
  const entry = ext?.find((value) => value.startsWith("msg_idx="));
  return entry ? entry.slice("msg_idx=".length) : null;
}

export class QQAdapter implements ChannelAdapter {
  public constructor(
    private readonly config: RuntimeConfig,
    private readonly botSecret: string,
    private readonly clientSecret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async parseWebhook(request: Request): Promise<WebhookResult> {
    if (this.config.qqAppId && !await constantTimeEqual(request.headers.get("X-Bot-Appid") ?? "", this.config.qqAppId)) {
      return { kind: "unauthorized" };
    }
    const raw = await readBoundedText(request, 1_000_000);
    const payload = payloadSchema.parse(JSON.parse(raw) as unknown);

    if (payload.op === 13) {
      const challenge = challengeSchema.parse(payload.d);
      const signature = this.signChallenge(challenge.event_ts, challenge.plain_token);
      return { kind: "challenge", response: Response.json({ plain_token: challenge.plain_token, signature }) };
    }

    if (!this.verifyRequest(
      request.headers.get("X-Signature-Timestamp") ?? "",
      raw,
      request.headers.get("X-Signature-Ed25519") ?? "",
    )) {
      return { kind: "unauthorized" };
    }

    if (payload.t === "C2C_MESSAGE_CREATE") {
      const data = c2cSchema.parse(payload.d);
      const userId = data.author.user_openid ?? data.author.id ?? "";
      if (!this.config.qqAllowedUserOpenIds.has(userId)) {
        log("warn", "qq_user_not_allowlisted", { userId });
        return { kind: "unauthorized" };
      }
      const index = messageIndex(data.message_scene?.ext);
      const attachmentText = data.attachments?.map((attachment) => attachment.asr_refer_text ?? attachment.url ?? "").filter(Boolean).join("\n") ?? "";
      const cardText = data.ark_data?.prompt ?? "";
      const text = [data.content, cardText, attachmentText].filter(Boolean).join("\n").trim();
      if (!text) return { kind: "ignored" };
      const incoming: IncomingMessage = {
        channel: "qq",
        eventId: `c2c:${data.id}:${index ?? payload.id ?? "0"}`,
        messageId: data.id,
        userId,
        text,
        timestamp: new Date(data.timestamp).toISOString(),
        eventType: "message",
        replyToMessageId: data.id,
      };
      return { kind: "message", message: incoming };
    }

    if (payload.t === "INTERACTION_CREATE") {
      const data = interactionSchema.parse(payload.d);
      if (data.scene !== "c2c" || !data.user_openid || !this.config.qqAllowedUserOpenIds.has(data.user_openid)) {
        if (data.user_openid) log("warn", "qq_user_not_allowlisted", { userId: data.user_openid });
        return { kind: "unauthorized" };
      }
      const callback = parseAction(data.data.resolved.button_data ?? "", data.id);
      if (!callback) return { kind: "ignored" };
      return {
        kind: "message",
        message: {
          channel: "qq",
          eventId: `interaction:${data.id}`,
          messageId: data.id,
          userId: data.user_openid,
          text: data.data.resolved.button_data ?? "",
          timestamp: new Date(data.timestamp).toISOString(),
          eventType: "callback",
          callback,
        },
      };
    }

    return { kind: "ignored" };
  }

  public signChallenge(eventTimestamp: string, plainToken: string): string {
    const signature = nacl.sign.detached(concatBytes(eventTimestamp, plainToken), deriveKeyPair(this.botSecret).secretKey);
    return bytesToHex(signature);
  }

  public verifyRequest(timestamp: string, rawBody: string, signatureHex: string): boolean {
    const signature = hexToBytes(signatureHex);
    if (!timestamp || !signature || signature.byteLength !== nacl.sign.signatureLength) return false;
    return nacl.sign.detached.verify(concatBytes(timestamp, rawBody), signature, deriveKeyPair(this.botSecret).publicKey);
  }

  public async send(target: ChannelTarget, message: OutgoingMessage): Promise<DeliveryReceipt> {
    const accessToken = await this.getAccessToken();
    const payload: Record<string, unknown> = { content: message.text, msg_type: 0 };
    if (message.replyToMessageId) {
      payload.msg_id = message.replyToMessageId;
      payload.msg_seq = 1;
    }
    if (message.buttons && message.buttons.length > 0) {
      payload.keyboard = {
        content: {
          rows: message.buttons.slice(0, 5).map((row, rowIndex) => ({
            buttons: row.slice(0, 5).map((button, buttonIndex) => ({
              id: `c${rowIndex}-${buttonIndex}`,
              render_data: {
                label: button.label.slice(0, 10),
                visited_label: button.label.slice(0, 10),
                style: button.style === "primary" ? 3 : 0,
              },
              action: {
                type: 1,
                permission: { type: 0, specify_user_ids: [target.userId] },
                data: button.action,
                unsupport_tips: "请发送文字指令操作",
              },
            })),
          })),
        },
      };
    }

    const url = `${this.config.qqApiBaseUrl}/v2/users/${encodeURIComponent(target.userId)}/messages`;
    const sendPayload = () => fetchWithRetry(this.fetcher, url, {
      method: "POST",
      headers: { "Authorization": `QQBot ${accessToken}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    let response: Response;
    try {
      response = await sendPayload();
    } catch (error) {
      const keyboardUnsupported = "keyboard" in payload
        && error instanceof ChannelHttpError
        && (error.status === 400 || error.status === 403);
      if (!keyboardUnsupported) throw error;
      delete payload.keyboard;
      log("warn", "qq_keyboard_fallback", { status: error.status });
      response = await sendPayload();
    }
    const parsed = sendSchema.parse(await response.json());
    return { channel: "qq", messageId: parsed.id, deliveredAt: parsed.timestamp ?? new Date().toISOString() };
  }

  public async acknowledge(interactionId: string, code: number): Promise<void> {
    const accessToken = await this.getAccessToken();
    await fetchWithRetry(this.fetcher, `${this.config.qqApiBaseUrl}/interactions/${encodeURIComponent(interactionId)}`, {
      method: "PUT",
      headers: { "Authorization": `QQBot ${accessToken}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ code }),
    });
  }

  private async getAccessToken(): Promise<string> {
    if (!this.config.qqAppId || !this.clientSecret) throw new Error("QQ_APP_ID/QQ_CLIENT_SECRET is not configured");
    const response = await fetchWithRetry(this.fetcher, `${this.config.qqApiBaseUrl}/app/getAppAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.config.qqAppId, clientSecret: this.clientSecret }),
    });
    return tokenSchema.parse(await response.json()).access_token;
  }
}
