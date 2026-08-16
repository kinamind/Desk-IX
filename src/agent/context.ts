import { z } from "zod";
import type { UIMessage } from "ai";
import type { ChannelName } from "../core/types";

const turnMetadataSchema = z.object({
  channel: z.enum(["telegram", "qq"]),
  userId: z.string().min(1),
  eventId: z.string().min(1),
  replyToMessageId: z.string().optional(),
  receivedAt: z.string().datetime(),
});

export interface AgentPrincipal {
  channel: ChannelName;
  userId: string;
  eventId: string;
  replyToMessageId?: string;
  receivedAt: string;
}

export type TurnStampedMessage = UIMessage & {
  metadata: Record<string, unknown> & { turnMetadata: AgentPrincipal };
};

export function parseTurnPrincipal(metadata: unknown): AgentPrincipal {
  const parsed = turnMetadataSchema.safeParse(metadata);
  if (!parsed.success) throw new Error("Authenticated turn metadata is missing or invalid");
  return {
    channel: parsed.data.channel,
    userId: parsed.data.userId,
    eventId: parsed.data.eventId,
    receivedAt: parsed.data.receivedAt,
    ...(parsed.data.replyToMessageId ? { replyToMessageId: parsed.data.replyToMessageId } : {}),
  };
}

export function safeParseTurnPrincipal(metadata: unknown): AgentPrincipal | null {
  try {
    return parseTurnPrincipal(metadata);
  } catch {
    return null;
  }
}

export function stampTurnPrincipal(message: UIMessage, principal: AgentPrincipal): TurnStampedMessage {
  const metadata = message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? message.metadata
    : {};
  return {
    ...message,
    metadata: {
      ...metadata,
      turnMetadata: principal,
    },
  };
}
