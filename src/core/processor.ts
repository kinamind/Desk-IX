import { z } from "zod";
import { getConfig, isAIEnabled } from "../config";
import { resolveScheduleChange, routeMessage } from "../ai/intent";
import { OpenAICompatibleProvider, parseAIJson } from "../ai/openai-compatible";
import { SECRETARY_STYLE, URL_ENRICHMENT_PROMPT } from "../ai/prompts";
import type { AIProvider } from "../ai/provider";
import { getChannelAdapter } from "../channels/registry";
import {
  archiveItem,
  completeItem,
  createItem,
  getItem,
  getItemBySource,
  getOwnedItem,
  listAgentContextItems,
  mergeItemEnrichment,
  restoreItem,
  searchOwnedItems,
  updateItem,
  updateItemSchedule,
} from "../db/items";
import { failMessage, finishMessage, claimMessage, listRecentConversation } from "../db/messages";
import { setPendingAction, takePendingAction } from "../db/pending-actions";
import { cancelOpenReminders } from "../db/reminders";
import { discoverUrls, readWebPage } from "../url/reader";
import { handleCallback } from "./callbacks";
import { generateDeadlineMilestones } from "./milestones";
import { scheduleReminder } from "./reminder-service";
import type { CreateItemAgentAction, IncomingMessage, Item, OutgoingMessage, ParsedIntent, ReminderMode } from "./types";
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

export async function processIncoming(
  env: Env,
  incoming: IncomingMessage,
  fetcher: typeof fetch = fetch,
  now = new Date(),
  providerOverride?: AIProvider | null,
): Promise<void> {
  const claim = await claimMessage(env.DB, incoming, now);
  if (!claim.claimed) {
    log("info", "message_duplicate", { channel: incoming.channel, eventId: incoming.eventId, status: claim.status });
    return;
  }

  const config = getConfig(env);
  const adapter = getChannelAdapter(env, incoming.channel, fetcher);
  const provider = providerOverride === undefined
    ? isAIEnabled(env) ? new OpenAICompatibleProvider(env.DB, config, env.AI_API_KEY, fetcher, () => now) : null
    : providerOverride;

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
        const item = await getOwnedItem(env.DB, pending.itemId, incoming.channel, incoming.userId);
        if (!item) throw new Error("Pending reschedule item no longer exists");
        const schedule = await resolveScheduleChange(incoming.text, { title: item.title, dueAt: item.dueAt }, provider, now, config.timezone);
        if (schedule.question || !schedule.reminderAt) {
          await setPendingAction(env.DB, {
            channel: pending.channel,
            userId: pending.userId,
            action: pending.action,
            itemId: pending.itemId,
          }, now);
          output = { text: schedule.question ?? "我还不能确定新时间，能再说具体一点吗？" };
          itemId = pending.itemId;
        } else {
          const dueAt = schedule.dueAt ?? schedule.reminderAt;
          await updateItemSchedule(env.DB, item.id, dueAt, schedule.originalTimeExpression ?? incoming.text.slice(0, 200), now);
          await cancelOpenReminders(env.DB, item.id);
          await scheduleReminder(env, {
            itemId: item.id,
            remindAt: schedule.reminderAt,
            kind: "rescheduled",
            target: { channel: incoming.channel, userId: incoming.userId },
          }, now);
          output = { text: formatScheduleConfirmation(item.title, dueAt, schedule.reminderAt, config.timezone, "已改好", schedule.reminderMode) };
          itemId = item.id;
        }
      } else {
        const contextItems = await listAgentContextItems(env.DB, incoming.channel, incoming.userId);
        const conversation = await listRecentConversation(env.DB, incoming.channel, incoming.userId);
        const intent = await routeMessage(incoming.text, provider, now, config.timezone, contextItems, conversation);
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
  if (intent.intent === "clarify" || intent.intent === "unavailable") {
    return { output: { text: intent.question ?? "我还不能确定你的意思，能再说具体一点吗？" }, itemId: null };
  }
  if (intent.intent === "help") {
    return {
      output: { text: "直接像和助理说话一样发给我：记事、安排提醒、读链接、查找、分析都可以。\n也可以说“这个做完了”“那件事不做了”“把它改到周五”；我会结合近期记录处理。" },
      itemId: null,
    };
  }

  if (intent.intent === "respond") {
    return { output: { text: intent.reply?.trim() || "我在。" }, itemId: null };
  }

  if (intent.intent === "query") {
    const items = await searchOwnedItems(env.DB, incoming.channel, incoming.userId, intent.query ?? { limit: 10 });
    return { output: { text: formatSearchResults(items, config.timezone) }, itemId: null };
  }

  if (intent.intent === "analyze") {
    if (!provider) return { output: { text: "AI 还未配置；设置 AI_API_KEY 后可以展开分析。" }, itemId: null };
    let webContext: Record<string, unknown> | null = null;
    const contextItems = await listAgentContextItems(env.DB, incoming.channel, incoming.userId, 12);
    const url = discoverUrls(incoming.text, 1)[0];
    if (url) {
      try {
        const reading = await readWebPage(url, config, fetcher);
        webContext = {
          url: reading.finalUrl,
          title: reading.title,
          description: reading.description,
          source: reading.source,
          text: reading.text.slice(0, 12_000),
        };
      } catch (error) {
        log("warn", "web_reader_failed", { url, error: error instanceof Error ? error.message : String(error) });
      }
    }
    try {
      const response = await provider.generate({
        purpose: "analysis",
        maxTokens: Math.min(config.aiMaxTokens, 1200),
        messages: [
          { role: "system", content: `${SECRETARY_STYLE}\n用户这次明确要求分析，可以展开，但保持结构清楚。若提供了网页正文，只根据真实正文分析。` },
          {
            role: "user",
            content: JSON.stringify({
              message: incoming.text,
              webpage: webContext,
              recent_items: contextItems.map((item) => ({
                id: item.id,
                title: item.title,
                content: item.content.slice(0, 500),
                status: item.status,
                due_at: item.dueAt,
              })),
            }),
          },
        ],
      });
      return { output: { text: response.text.slice(0, 3500) }, itemId: null };
    } catch (error) {
      log("warn", "ai_analysis_failed", { error: error instanceof Error ? error.message : String(error) });
      return { output: { text: "模型这次没有成功完成分析，请稍后重试。" }, itemId: null };
    }
  }

  if (intent.intent !== "act" || !intent.actions?.length) {
    return { output: { text: "我还不能确定要执行什么，没有改动任何记录。" }, itemId: null };
  }

  const targetItems = new Map<string, Item>();
  for (const action of intent.actions) {
    if (action.action === "create_item") continue;
    const item = await getOwnedItem(env.DB, action.targetItemId, incoming.channel, incoming.userId);
    if (!item) {
      return { output: { text: "我没能安全地对应到那条记录，没有改动任何事项。你可以再说一下标题。" }, itemId: null };
    }
    targetItems.set(item.id, item);
  }

  const confirmations: string[] = [];
  let resultItemId: string | null = null;
  for (const [actionIndex, action] of intent.actions.entries()) {
    if (action.action === "create_item") {
      const result = await executeCreateAction(env, incoming, action, actionIndex, intent.aiEnrichment ?? {}, provider, fetcher, now);
      confirmations.push(result.text);
      resultItemId ??= result.item.id;
      continue;
    }

    const item = targetItems.get(action.targetItemId);
    if (!item) throw new Error("Validated item disappeared during action execution");
    resultItemId ??= item.id;

    if (action.action === "complete_item") {
      const changed = await completeItem(env.DB, item.id, now);
      await cancelOpenReminders(env.DB, item.id);
      confirmations.push(changed ? `✓ 已完成：${item.title}` : `✓ 已是完成状态：${item.title}`);
      continue;
    }
    if (action.action === "archive_item") {
      const changed = await archiveItem(env.DB, item.id, now);
      await cancelOpenReminders(env.DB, item.id);
      confirmations.push(changed ? `✓ 已舍弃：${item.title}` : `✓ 已是舍弃状态：${item.title}`);
      continue;
    }
    if (action.action === "restore_item") {
      const changed = await restoreItem(env.DB, item.id, now);
      confirmations.push(changed ? `↩ 已恢复：${item.title}` : `↩ 这条记录当前无需恢复：${item.title}`);
      continue;
    }

    if (action.action !== "update_item") throw new Error("Unsupported agent action");
    const { reminderAt, reminderMode } = action;
    await updateItem(env.DB, item.id, action, now);
    const changesReminder = Object.hasOwn(action, "reminderAt") || Object.hasOwn(action, "reminderMode");
    if (changesReminder) {
      await cancelOpenReminders(env.DB, item.id);
      if (reminderAt) {
        await scheduleReminder(env, {
          itemId: item.id,
          remindAt: reminderAt,
          kind: reminderMode ?? "updated",
          target: { channel: incoming.channel, userId: incoming.userId },
        }, now);
      }
    }
    const updated = await getItem(env.DB, item.id) ?? item;
    confirmations.push(reminderAt
      ? formatScheduleConfirmation(updated.title, updated.dueAt, reminderAt, config.timezone, "已更新", reminderMode)
      : `✓ 已更新：${updated.title}`);
  }

  return { output: { text: confirmations.join("\n") }, itemId: resultItemId };
}

async function executeCreateAction(
  env: Env,
  incoming: IncomingMessage,
  action: CreateItemAgentAction,
  actionIndex: number,
  aiEnrichment: Record<string, unknown>,
  provider: AIProvider | null,
  fetcher: typeof fetch,
  now: Date,
): Promise<{ text: string; item: Item }> {
  const config = getConfig(env);
  const discoveredUrl = action.url ?? discoverUrls(incoming.text, 1)[0] ?? null;
  const type = action.type ?? (discoveredUrl ? "resource" : "note");
  let item = await getItemBySource(env.DB, incoming.channel, incoming.eventId, actionIndex);
  if (!item) {
    item = await createItem(env.DB, {
      type,
      title: action.title?.trim().slice(0, 100) || incoming.text.slice(0, 60),
      content: action.content ?? incoming.text,
      rawMessage: incoming.text,
      url: discoveredUrl,
      tags: action.tags ?? [],
      ...(action.status ? { status: action.status } : {}),
      ...(action.priority ? { priority: action.priority } : {}),
      ...(action.estimatedDuration !== undefined ? { estimatedDuration: action.estimatedDuration } : {}),
      ...(action.dueAt !== undefined ? { dueAt: action.dueAt } : {}),
      ...(action.startAfter !== undefined ? { startAfter: action.startAfter } : {}),
      ...(action.originalTimeExpression !== undefined ? { originalTimeExpression: action.originalTimeExpression } : {}),
      sourceChannel: incoming.channel,
      sourceUserId: incoming.userId,
      sourceMessageId: incoming.eventId,
      sourceActionIndex: actionIndex,
      aiEnrichment,
    }, now);
  }

  let urlFetchFailed = false;
  if (item.url) {
    try {
      const reading = await readWebPage(item.url, config, fetcher);
      const enrichment: Record<string, unknown> = {};
      if (provider && reading.text) {
        try {
          const response = await provider.generate({
            purpose: "url_enrichment",
            expectJson: true,
            maxTokens: 400,
            messages: [
              { role: "system", content: URL_ENRICHMENT_PROMPT },
              { role: "user", content: JSON.stringify({ url: reading.finalUrl, title: reading.title, description: reading.description, text: reading.text.slice(0, 12_000) }) },
            ],
          });
          Object.assign(enrichment, urlEnrichmentSchema.parse(parseAIJson(response.text)), { provider: "openai-compatible", model: response.model });
        } catch (error) {
          log("warn", "url_ai_enrichment_failed", { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      await mergeItemEnrichment(env.DB, item.id, enrichment, {
        fetched_url: reading.finalUrl,
        canonical_url: reading.canonicalUrl,
        source: reading.source,
        description: reading.description,
        reader: "basic-html",
        truncated: reading.truncated,
        fetch_status: "ok",
      }, reading.title ?? undefined, now);
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

  if (action.reminderAt) {
    await scheduleReminder(env, {
      itemId: item.id,
      remindAt: action.reminderAt,
      kind: action.reminderMode ?? "reminder",
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

  return { text: confirmation(item, action.reminderAt, action.reminderMode, urlFetchFailed, config.timezone), item };
}

function confirmation(item: Item, reminderAt: string | null | undefined, reminderMode: ReminderMode | null | undefined, urlFetchFailed: boolean, timezone: string): string {
  if (reminderMode === "explicit_now") {
    const due = item.dueAt ? `\n截止：${formatConfirmation(item.dueAt, timezone)}` : "";
    return `🔔 ${item.title}${due}`;
  }
  if (reminderAt) return formatScheduleConfirmation(item.title, item.dueAt, reminderAt, timezone, "已安排", reminderMode);
  if (item.type === "resource") return urlFetchFailed ? "✓ 已保存链接（网页暂时无法解析）。" : `✓ 已保存：${item.title}`;
  if (item.type === "idea") return `✓ 已记录 Idea：${item.title}`;
  if (item.type === "project" && item.dueAt) return `✓ 已记录项目，截止 ${formatConfirmation(item.dueAt, timezone)}。`;
  if (item.type === "task") {
    const due = item.dueAt ? `\n时间：${formatConfirmation(item.dueAt, timezone)}（未设置提醒）` : "";
    return `✓ 已添加任务：${item.title}${due}`;
  }
  return `✓ 已记录：${item.title}`;
}

function formatScheduleConfirmation(
  title: string,
  dueAt: string | null,
  reminderAt: string,
  timezone: string,
  verb: string,
  reminderMode?: ReminderMode | null,
): string {
  const reminder = formatConfirmation(reminderAt, timezone);
  if (!dueAt) return `⏰ ${verb}：${reminder}\n${title}`;
  const due = formatConfirmation(dueAt, timezone);
  const leadMinutes = Math.round((new Date(dueAt).getTime() - new Date(reminderAt).getTime()) / 60_000);
  if (reminderMode === "deferred_action" || leadMinutes > 24 * 60) {
    return `⏰ ${verb}：${title}\n提醒：${reminder} · 截止：${due}`;
  }
  if (leadMinutes > 0) {
    return `⏰ ${verb}：${title}\n事项：${due} · 提前${formatDuration(leadMinutes)}提醒（${reminder}）`;
  }
  return `⏰ ${verb}：${due}\n${title}`;
}

function formatDuration(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
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
