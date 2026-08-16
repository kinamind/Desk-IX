import { z } from "zod";

export const incomingAgentMessageSchema = z.object({
  channel: z.enum(["telegram", "qq"]),
  userId: z.string().min(1).max(256),
  eventId: z.string().min(1).max(512),
  text: z.string().trim().min(1).max(20_000),
  replyToMessageId: z.string().max(512).optional(),
  receivedAt: z.string().datetime(),
});

export type IncomingAgentMessage = z.infer<typeof incomingAgentMessageSchema>;

export interface RuntimeProfile {
  runtime: "cloudflare-think";
  maxSteps: number;
  messageConcurrency: "queue";
  recovery: boolean;
  mcpTools: boolean;
  workspaceBash: boolean;
}
