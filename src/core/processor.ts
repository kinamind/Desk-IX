import { getChannelAdapter } from "../channels/registry";
import { claimMessage, failMessage, finishMessage } from "../db/messages";
import { log } from "../observability/log";
import { handleCallback } from "./callbacks";
import type { IncomingMessage, OutgoingMessage } from "./types";

/**
 * Deterministic callback path only. Ordinary language is handled by ComposaAgent.
 */
export async function processIncoming(
  env: Env,
  incoming: IncomingMessage,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<void> {
  if (incoming.eventType !== "callback") {
    throw new Error("Ordinary messages must be submitted to ComposaAgent");
  }
  const claim = await claimMessage(env.DB, incoming, now);
  if (!claim.claimed) {
    log("info", "callback_duplicate", {
      channel: incoming.channel,
      eventId: incoming.eventId,
      status: claim.status,
    });
    return;
  }

  const adapter = getChannelAdapter(env, incoming.channel, fetcher);
  try {
    const result = await handleCallback(env, incoming, now);
    if (incoming.callback?.interactionId && adapter.acknowledge) {
      await adapter.acknowledge(incoming.callback.interactionId, result.acknowledgeCode);
    }
    const output: OutgoingMessage = incoming.replyToMessageId
      ? { ...result.output, replyToMessageId: incoming.replyToMessageId }
      : result.output;
    await adapter.send({ channel: incoming.channel, userId: incoming.userId }, output);
    await finishMessage(env.DB, claim.id, result.output.text, result.itemId, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failMessage(env.DB, claim.id, message, now);
    log("error", "callback_processing_failed", {
      channel: incoming.channel,
      eventId: incoming.eventId,
      error: message,
    });
    throw error;
  }
}
