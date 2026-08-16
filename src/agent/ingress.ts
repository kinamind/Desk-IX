import { getAgentByName } from "agents";
import type { IncomingMessage } from "../core/types";
import { claimMessage, failMessage } from "../db/messages";
import { log } from "../observability/log";

async function sessionName(channel: IncomingMessage["channel"], userId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${channel}:${userId}`));
  const suffix = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `composa-${channel}-${suffix}`;
}

export async function submitAgentMessage(env: Env, incoming: IncomingMessage): Promise<void> {
  if (incoming.eventType !== "message") throw new Error("Only ordinary messages can enter the agent runtime");
  const claim = await claimMessage(env.DB, incoming);
  try {
    const name = await sessionName(incoming.channel, incoming.userId);
    const agent = await getAgentByName(env.COMPOSA_AGENT, name);
    const submission = await agent.receive({
      channel: incoming.channel,
      userId: incoming.userId,
      eventId: incoming.eventId,
      text: incoming.text,
      receivedAt: incoming.timestamp,
      ...(incoming.replyToMessageId ? { replyToMessageId: incoming.replyToMessageId } : {}),
    });
    log("info", "agent_message_submitted", {
      channel: incoming.channel,
      eventId: incoming.eventId,
      submissionId: submission.submissionId,
      accepted: submission.accepted,
      duplicateAudit: !claim.claimed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (claim.claimed) await failMessage(env.DB, claim.id, `submission: ${message}`);
    log("error", "agent_message_submission_failed", {
      channel: incoming.channel,
      eventId: incoming.eventId,
      error: message,
    });
    throw error;
  }
}
