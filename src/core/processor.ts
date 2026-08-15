import { z } from "zod";
import { getConfig, isAIEnabled } from "../config";
import { routeMessage } from "../ai/intent";
import { OpenAICompatibleProvider, parseAIJson } from "../ai/openai-compatible";
import { SECRETARY_STYLE, URL_ENRICHMENT_PROMPT } from "../ai/prompts";
import type { AIProvider } from "../ai/provider";
import { getChannelAdapter } from "../channels/registry";
import { createItem, getItem, getItemBySource, mergeItemEnrichment, searchItems, updateItemSchedule } from "../db/items";
import { failMessage, finishMessage, claimMessage } from "../db/messages";
import { setPendingAction, takePendingAction } from "../db/pending-actions";
import { extractPageMetadata } from "../url/extract";
import { fetchPage } from "../url/fetch";
import { handleCallback } from "./callbacks";
import { generateDeadlineMilestones } from "./milestones";
import { scheduleReminder } from "./reminder-service";
import { parseNaturalTime } from "./time";
import type { IncomingMessage, Item, OutgoingMessage, ParsedIntent } from "./types";
import { log } from "../observability/log";

const urlEnrichmentSchema = z.object({
  title: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  tags: z.array(z.string()).optional().default([]),
  organization: z.string().nullable().optional(),
  venue: z.string().nullable().optional(),
  potential_deadline: z.string().nullable().optional(),
});

export async function processIncoming(env: Env, incoming: IncomingMessage, fetcher: typeof fetch = fetch, now = new Date()): Promise<void> {
  const claim = await claimMessage(env.DB, incoming, now);
  if (!claim.claimed) {
    log("info", "message_duplicate", { channel: incoming.channel, eventId: incoming.eventId, status: claim.status });
    return;
  }

  const config = getConfig(env);
  const adapter = getChannelAdapter(env, incoming.channel, fetcher);
  const provider = isAIEnabled(env) ? new OpenAICompatibleProvider(env.DB, config, env.AI_API_KEY, fetcher, () => now) : null;

  try {
    let output: OutgoingMessage;
    let itemId: string | null = null;

    if (incoming.eventType === "callback") {
      const result = await handleCallback(env, incoming, now);
      output = result.output;
      itemId = result.itemId;
      if (incoming.callback?.interactionId && adapter.acknowledge) {
        await adapter.acknowledge(incoming.callback.interactionId, result.acknowledgeCode);
      }
    } else {
      const pending = await takePendingAction(env.DB, incoming.channel, incoming.userId, now);
      if (pending?.action === "reschedule") {
        const parsed = parseNaturalTime(incoming.text, now, config.timezone);
        if (!parsed) {
          await setPendingAction(env.DB, {
            channel: pending.channel,
            userId: pending.userId,
            action: pending.action,
            itemId: pending.itemId,
          }, now);
          output = { text: "没识别到时间，请再发一次，例如“明天下午 3 点”。" };
          itemId = pending.itemId;
        } else {
          const item = await getItem(env.DB, pending.itemId);
          if (!item) throw new Error("Pending reschedule item no longer exists");
          await updateItemSchedule(env.DB, item.id, parsed.at, parsed.originalExpression, now);
          await scheduleReminder(env, {
            itemId: item.id,
            remindAt: parsed.at,
            kind: "rescheduled",
            target: { channel: incoming.channel, userId: incoming.userId },
          }, now);
          output = { text: `⏰ 已改到 ${formatConfirmation(parsed.at, config.timezone)}：${item.title}` };
          itemId = item.id;
        }
      } else {
        const intent = await routeMessage(incoming.text, provider, now, config.timezone);
        const result = await executeIntent(env, incoming, intent, provider, fetcher, now);
        output = result.output;
        itemId = result.itemId;
      }
    }

    const reply: OutgoingMessage = incoming.eventType === "message" && incoming.replyToMessageId
      ? { ...output, replyToMessageId: incoming.replyToMessageId }
      : output;
    await adapter.send({ channel: incoming.channel, userId: incoming.userId }, reply);
    await finishMessage(env.DB, claim.id, output.text, itemId, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failMessage(env.DB, claim.id, message, now);
    log("error", "message_processing_failed", { channel: incoming.channel, eventId: incoming.eventId, error: message });
    throw error;
  }
}

async function executeIntent(
  env: Env,
  incoming: IncomingMessage,
  intent: ParsedIntent,
  provider: AIProvider | null,
  fetcher: typeof fetch,
  now: Date,
): Promise<{ output: OutgoingMessage; itemId: string | null }> {
  const config = getConfig(env);
  if (intent.intent === "help") {
    return {
      output: { text: "直接发给我：链接、idea、待办、deadline 或提醒。也可以问“这周还有什么？”\n按钮可直接完成、延后或改期。" },
      itemId: null,
    };
  }

  if (intent.intent === "query") {
    const items = await searchItems(env.DB, intent.query ?? { limit: 10 });
    return { output: { text: formatSearchResults(items, config.timezone) }, itemId: null };
  }

  if (intent.intent === "analyze") {
    if (!provider) return { output: { text: "AI 还未配置；设置 AI_API_KEY 后可以展开分析。" }, itemId: null };
    const response = await provider.generate({
      purpose: "analysis",
      maxTokens: Math.min(config.aiMaxTokens, 1200),
      messages: [
        { role: "system", content: `${SECRETARY_STYLE}\n用户这次明确要求分析，可以展开，但保持结构清楚。` },
        { role: "user", content: incoming.text },
      ],
    });
    return { output: { text: response.text.slice(0, 3500) }, itemId: null };
  }

  const type = intent.type ?? "note";
  let item = await getItemBySource(env.DB, incoming.channel, incoming.eventId);
  if (!item) {
    item = await createItem(env.DB, {
      type,
      title: intent.title?.trim().slice(0, 100) || incoming.text.slice(0, 60),
      content: intent.content ?? incoming.text,
      rawMessage: incoming.text,
      url: intent.url ?? null,
      tags: intent.tags ?? [],
      ...(intent.status ? { status: intent.status } : {}),
      ...(intent.priority ? { priority: intent.priority } : {}),
      ...(intent.estimatedDuration !== undefined ? { estimatedDuration: intent.estimatedDuration } : {}),
      ...(intent.dueAt !== undefined ? { dueAt: intent.dueAt } : {}),
      ...(intent.startAfter !== undefined ? { startAfter: intent.startAfter } : {}),
      ...(intent.originalTimeExpression !== undefined ? { originalTimeExpression: intent.originalTimeExpression } : {}),
      sourceChannel: incoming.channel,
      sourceUserId: incoming.userId,
      sourceMessageId: incoming.eventId,
      aiEnrichment: intent.aiEnrichment ?? {},
    }, now);
  }

  let urlFetchFailed = false;
  if (type === "resource" && item.url) {
    try {
      const page = await fetchPage(item.url, { timeoutMs: config.urlFetchTimeoutMs, maxBytes: config.urlMaxBytes }, fetcher);
      const metadata = extractPageMetadata(page.body, page.url);
      const enrichment: Record<string, unknown> = {};
      if (provider && metadata.text) {
        try {
          const response = await provider.generate({
            purpose: "url_enrichment",
            expectJson: true,
            maxTokens: 400,
            messages: [
              { role: "system", content: URL_ENRICHMENT_PROMPT },
              { role: "user", content: JSON.stringify({ url: page.url, title: metadata.title, description: metadata.description, text: metadata.text.slice(0, 12_000) }) },
            ],
          });
          Object.assign(enrichment, urlEnrichmentSchema.parse(parseAIJson(response.text)), { provider: "openai-compatible", model: response.model });
        } catch (error) {
          log("warn", "url_ai_enrichment_failed", { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      await mergeItemEnrichment(env.DB, item.id, enrichment, {
        fetched_url: page.url,
        canonical_url: metadata.canonicalUrl,
        source: metadata.source,
        description: metadata.description,
        truncated: page.truncated,
        fetch_status: "ok",
      }, metadata.title ?? undefined, now);
      item = await getItem(env.DB, item.id) ?? item;
    } catch (error) {
      urlFetchFailed = true;
      await mergeItemEnrichment(env.DB, item.id, {}, {
        fetch_status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }, undefined, now);
      log("warn", "url_fetch_failed", { itemId: item.id, url: item.url, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (intent.reminderAt) {
    await scheduleReminder(env, {
      itemId: item.id,
      remindAt: intent.reminderAt,
      target: { channel: incoming.channel, userId: incoming.userId },
    }, now);
  }
  if (type === "project" && item.dueAt) {
    for (const milestone of generateDeadlineMilestones(item.dueAt, now)) {
      await scheduleReminder(env, {
        itemId: item.id,
        remindAt: milestone.remindAt,
        kind: `milestone-${milestone.label}`,
        target: { channel: incoming.channel, userId: incoming.userId },
      }, now);
    }
  }

  return { output: { text: confirmation(item, intent.reminderAt, urlFetchFailed, config.timezone) }, itemId: item.id };
}

function confirmation(item: Item, reminderAt: string | null | undefined, urlFetchFailed: boolean, timezone: string): string {
  if (reminderAt) return `⏰ 已设置：${formatConfirmation(reminderAt, timezone)}\n${item.title}`;
  if (item.type === "resource") return urlFetchFailed ? "✓ 已保存链接（网页暂时无法解析）。" : `✓ 已保存：${item.title}`;
  if (item.type === "idea") return `✓ 已记录 Idea：${item.title}`;
  if (item.type === "project" && item.dueAt) return `✓ 已记录项目，截止 ${formatConfirmation(item.dueAt, timezone)}。`;
  if (item.type === "task") return `✓ 已添加任务：${item.title}`;
  return `✓ 已记录：${item.title}`;
}

function formatSearchResults(items: Item[], timezone: string): string {
  if (items.length === 0) return "没有找到相关记录。";
  return items.map((item) => {
    const marker = item.status === "completed" ? "✓" : "•";
    const due = item.dueAt ? ` · ${formatConfirmation(item.dueAt, timezone)}` : "";
    return `${marker} ${item.title}${due}`;
  }).join("\n");
}

function formatConfirmation(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}
