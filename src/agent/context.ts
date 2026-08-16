import { z } from "zod";
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

export function parseTurnPrincipal(metadata: Record<string, unknown> | undefined): AgentPrincipal {
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

export function safeParseTurnPrincipal(metadata: Record<string, unknown> | undefined): AgentPrincipal | null {
  try {
    return parseTurnPrincipal(metadata);
  } catch {
    return null;
  }
}
