import type { ChannelTarget, DeliveryReceipt, IncomingMessage, OutgoingMessage } from "../core/types";

export type WebhookResult =
  | { kind: "message"; message: IncomingMessage }
  | { kind: "challenge"; response: Response }
  | { kind: "ignored"; response?: Response }
  | { kind: "unauthorized" };

export interface ChannelAdapter {
  parseWebhook(request: Request): Promise<WebhookResult>;
  send(target: ChannelTarget, message: OutgoingMessage): Promise<DeliveryReceipt>;
  acknowledge?(interactionId: string, code: number): Promise<void>;
}
