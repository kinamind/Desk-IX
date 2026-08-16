import { getConfig, isAIEnabled } from "../config";
import { resolveScheduleChange, routeMessage } from "../ai/intent";
import { OpenAICompatibleProvider } from "../ai/openai-compatible";
import { QUERY_RESPONSE_PROMPT, SECRETARY_STYLE } from "../ai/prompts";
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
import { listScheduleWindows } from "../db/schedule";
import { discoverUrls, readWebPagesFromText, type WebPageBatch } from "../url/reader";
import { handleCallback } from "./callbacks";
import { enrichItemFromUrls, summarizeItemEnrichment, type ItemEnrichmentResult } from "./item-enrichment";
import { scheduleReminder } from "./reminder-service";
import { findAvailableReminderTime } from "./schedule";
import type { CreateItemAgentAction, IncomingMessage, Item, OutgoingMessage, ParsedIntent, ReminderMode, ScheduleWindow } from "./types";
import { log } from "../observability/log";

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
        const scheduleWindows = await listScheduleWindows(env.DB, incoming.channel, incoming.userId, now);
        const availability = schedule.reminderAt ? findAvailableReminderTime(schedule.reminderAt, {
          now,
          dueAt: schedule.dueAt ?? item.dueAt,
          targetItemId: item.id,
          schedule: scheduleWindows,
          avoidWindows: schedule.avoidWindows,
        }) : null;
        if (schedule.question || !schedule.reminderAt || !availability?.reminderAt) {
          await setPendingAction(env.DB, {
            channel: pending.channel,
            userId: pending.userId,
            action: pending.action,
            itemId: pending.itemId,
          }, now);
          output = { text: schedule.question ?? "截止前没有找到合适的空闲时间，原提醒没有修改。" };
          itemId = pending.itemId;
        } else {
          const dueAt = schedule.dueAt ?? schedule.reminderAt;
          await updateItemSchedule(env.DB, item.id, dueAt, schedule.originalTimeExpression ?? incoming.text.slice(0, 200), now);
          const replacement = await scheduleReminder(env, {
            itemId: item.id,
            remindAt: availability.reminderAt,
            kind: "rescheduled",
            target: { channel: incoming.channel, userId: incoming.userId },
          }, now);
          await cancelOpenReminders(env.DB, item.id, replacement.id);
          output = {
            text: formatScheduleConfirmation(item.title, dueAt, availability.reminderAt, config.timezone, "已改好", schedule.reminderMode)
              + adjustmentSuffix(availability.adjusted),
          };
          itemId = item.id;
        }
      } else {
        const contextItems = await listAgentContextItems(env.DB, incoming.channel, incoming.userId);
        const conversation = await listRecentConversation(env.DB, incoming.channel, incoming.userId);
        const schedule = await listScheduleWindows(env.DB, incoming.channel, incoming.userId, now);
        let webObservation = await readWebPagesFromText(incoming.text, config, fetcher, 3);
        logWebFailures(webObservation);
        let intent = await routeMessage(
          incoming.text,
          provider,
          now,
          config.timezone,
          contextItems,
          conversation,
          schedule,
          webObservation.pages,
        );

        let toolFailure: { output: OutgoingMessage; itemId: string | null } | null = null;
        if (intent.intent === "observe") {
          const request = intent.toolRequest;
          const target = request
            ? await getOwnedItem(env.DB, request.targetItemId, incoming.channel, incoming.userId)
            : null;
          if (!request || !target) {
            toolFailure = {
              output: { text: "我没能安全地对应到要读取的那条记录，没有读取或修改任何内容。你可以再说一下记录标题。" },
              itemId: null,
            };
          } else {
            const storedLinks = collectItemUrls(target);
            if (storedLinks.length === 0) {
              toolFailure = {
                output: { text: `我找到了「${target.title}」，但记录里没有可读取的网页链接，所以没有修改。` },
                itemId: target.id,
              };
            } else {
              webObservation = await readWebPagesFromText(storedLinks.join("\n"), config, fetcher, 3);
              logWebFailures(webObservation);
              if (webObservation.pages.length === 0) {
                toolFailure = {
                  output: { text: `我找到了「${target.title}」里的链接，但这次都没有成功读到正文，所以没有修改原记录。` },
                  itemId: target.id,
                };
              } else {
                intent = await routeMessage(
                  incoming.text,
                  provider,
                  now,
                  config.timezone,
                  contextItems,
                  conversation,
                  schedule,
                  webObservation.pages,
                );
                if (intent.intent === "observe") {
                  toolFailure = {
                    output: { text: "我已经读到了相关网页，但模型没有继续完成判断，因此没有修改任何记录。你可以稍后重试。" },
                    itemId: target.id,
                  };
                }
              }
            }
          }
        }

        const result = toolFailure
          ?? await executeIntent(env, incoming, intent, provider, fetcher, now, schedule, webObservation);
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

function logWebFailures(observation: WebPageBatch): void {
  for (const failure of observation.failures) {
    log("warn", "web_reader_failed", { url: failure.requestedUrl, error: failure.error });
  }
}

function collectItemUrls(item: Item): string[] {
  const enrichmentUrls = Array.isArray(item.aiEnrichment.source_urls)
    ? item.aiEnrichment.source_urls.filter((value): value is string => typeof value === "string")
    : [];
  const urls = [
    ...(item.url ? [item.url] : []),
    ...discoverUrls(item.content, 3),
    ...discoverUrls(item.rawMessage, 3),
    ...enrichmentUrls,
  ];
  return [...new Set(urls)].slice(0, 3);
}

async function executeIntent(
  env: Env,
  incoming: IncomingMessage,
  intent: ParsedIntent,
  provider: AIProvider | null,
  fetcher: typeof fetch,
  now: Date,
  schedule: ScheduleWindow[],
  webObservation: WebPageBatch,
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
    const answer = await answerQuery(incoming.text, items, provider, config.timezone, now);
    return { output: { text: answer }, itemId: null };
  }

  if (intent.intent === "analyze") {
    if (!provider) return { output: { text: "AI 还未配置；设置 AI_API_KEY 后可以展开分析。" }, itemId: null };
    const contextItems = await listAgentContextItems(env.DB, incoming.channel, incoming.userId, 12);
    const webContext = webObservation.pages.map((page) => ({
      url: page.finalUrl,
      title: page.title,
      description: page.description,
      source: page.source,
      text: page.text.slice(0, 6_000),
    }));
    try {
      const response = await provider.generate({
        purpose: "analysis",
        maxTokens: Math.min(config.aiMaxTokens, 1200),
        messages: [
          {
            role: "system",
            content: `${SECRETARY_STYLE}\n用户这次明确要求分析，可以展开，但保持结构清楚。若提供了一个或多个网页正文，只根据真实正文并依照用户指令分析；比较请求必须覆盖所有成功读取的来源。\n当前时间：${now.toISOString()}\n用户时区：${config.timezone}\n展示日期与时间时必须转换到用户时区；没有明确证据的截止时间要说未知，不能补猜。`,
          },
          {
            role: "user",
            content: JSON.stringify({
              message: incoming.text,
              current_time: now.toISOString(),
              timezone: config.timezone,
              webpages: webContext,
              recent_items: contextItems.map((item) => {
                const enrichment = summarizeItemEnrichment(item.aiEnrichment);
                return {
                  id: item.id,
                  title: item.title,
                  content: item.content.slice(0, 500),
                  status: item.status,
                  due_at: item.dueAt,
                  ...(enrichment ? { enrichment } : {}),
                };
              }),
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
      const result = await executeCreateAction(
        env,
        incoming,
        action,
        actionIndex,
        intent.aiEnrichment ?? {},
        provider,
        fetcher,
        now,
        schedule,
        intent.avoidWindows ?? [],
        webObservation,
      );
      confirmations.push(result.text);
      resultItemId ??= result.item.id;
      if (result.reminderAt) schedule.push(reminderWindow(result.item, result.reminderAt));
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

    if (action.action === "set_reminder") {
      if (action.reminderMode === "none") {
        await cancelOpenReminders(env.DB, item.id);
        confirmations.push(`✓ 已取消提醒：${item.title}`);
        continue;
      }
      if (action.reminderMode === "explicit_now") {
        await cancelOpenReminders(env.DB, item.id);
        confirmations.push(`🔔 ${item.title}`);
        continue;
      }
      if (!action.reminderAt) {
        confirmations.push(`原提醒没有修改：${item.title}`);
        continue;
      }
      const availability = findAvailableReminderTime(action.reminderAt, {
        now,
        dueAt: item.dueAt,
        targetItemId: item.id,
        schedule,
        avoidWindows: intent.avoidWindows ?? [],
      });
      if (!availability.reminderAt) {
        confirmations.push(`截止前没有找到合适的空闲时间，原提醒没有修改：${item.title}`);
        continue;
      }
      const replacement = await scheduleReminder(env, {
        itemId: item.id,
        remindAt: availability.reminderAt,
        kind: action.reminderMode ?? "updated",
        target: { channel: incoming.channel, userId: incoming.userId },
      }, now);
      await cancelOpenReminders(env.DB, item.id, replacement.id);
      schedule.push(reminderWindow(item, availability.reminderAt));
      confirmations.push(
        formatScheduleConfirmation(item.title, item.dueAt, availability.reminderAt, config.timezone, "已更新", action.reminderMode)
          + adjustmentSuffix(availability.adjusted),
      );
      continue;
    }

    if (action.action !== "update_item") throw new Error("Unsupported agent action");
    const { reminderAt, reminderMode } = action;
    let selectedUpdateReminderAt = reminderAt ?? null;
    let updateReminderAdjusted = false;
    await updateItem(env.DB, item.id, action, now);
    let updatedItem = await getItem(env.DB, item.id) ?? item;
    let enrichmentResult: ItemEnrichmentResult | null = null;
    if (webObservation.requestedUrls.length > 0 || (action.content && discoverUrls(action.content, 1).length > 0)) {
      const enriched = await enrichAndPersistItem(
        env,
        updatedItem,
        incoming.text,
        provider,
        fetcher,
        now,
        false,
        webObservation.requestedUrls.length > 0 ? webObservation : undefined,
      );
      updatedItem = enriched.item;
      enrichmentResult = enriched.result;
    }
    const changesReminder = Object.hasOwn(action, "reminderAt") || Object.hasOwn(action, "reminderMode");
    if (changesReminder) {
      if (reminderAt) {
        const updatedDueAt = action.dueAt !== undefined ? action.dueAt : updatedItem.dueAt;
        const availability = findAvailableReminderTime(reminderAt, {
          now,
          dueAt: updatedDueAt,
          targetItemId: item.id,
          schedule,
          avoidWindows: intent.avoidWindows ?? [],
        });
        if (!availability.reminderAt) {
          confirmations.push(`事项已更新，但截止前没有空闲提醒时间：${item.title}`);
          continue;
        }
        selectedUpdateReminderAt = availability.reminderAt;
        updateReminderAdjusted = availability.adjusted;
        const replacement = await scheduleReminder(env, {
          itemId: item.id,
          remindAt: availability.reminderAt,
          kind: reminderMode ?? "updated",
          target: { channel: incoming.channel, userId: incoming.userId },
        }, now);
        await cancelOpenReminders(env.DB, item.id, replacement.id);
        schedule.push(reminderWindow(item, availability.reminderAt));
      } else {
        await cancelOpenReminders(env.DB, item.id);
      }
    }
    confirmations.push(selectedUpdateReminderAt
      ? formatScheduleConfirmation(updatedItem.title, updatedItem.dueAt, selectedUpdateReminderAt, config.timezone, "已更新", reminderMode)
        + adjustmentSuffix(updateReminderAdjusted)
      : enrichmentResult
        ? formatEnrichmentConfirmation(updatedItem, enrichmentResult, config.timezone)
        : `✓ 已更新：${updatedItem.title}`);
  }

  const reply = intent.reply?.trim();
  return {
    output: { text: reply ? `${confirmations.join("\n")}\n\n${reply}` : confirmations.join("\n") },
    itemId: resultItemId,
  };
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
  schedule: ScheduleWindow[],
  avoidWindows: ScheduleWindow[],
  webObservation: WebPageBatch,
): Promise<{ text: string; item: Item; reminderAt: string | null }> {
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

  const enriched = await enrichAndPersistItem(
    env,
    item,
    incoming.text,
    provider,
    fetcher,
    now,
    true,
    webObservation.requestedUrls.length > 0 ? webObservation : undefined,
  );
  item = enriched.item;
  const urlFetchFailed = enriched.result !== null && enriched.result.readableSourceCount === 0;

  let selectedReminderAt: string | null = null;
  let reminderAdjusted = false;
  if (action.reminderAt) {
    const availability = findAvailableReminderTime(action.reminderAt, {
      now,
      dueAt: item.dueAt,
      targetItemId: item.id,
      schedule,
      avoidWindows,
    });
    selectedReminderAt = availability.reminderAt;
    reminderAdjusted = availability.adjusted;
  }
  if (selectedReminderAt) {
    await scheduleReminder(env, {
      itemId: item.id,
      remindAt: selectedReminderAt,
      kind: action.reminderMode ?? "reminder",
      target: { channel: incoming.channel, userId: incoming.userId },
    }, now);
  }
  const text = (enriched.result && !selectedReminderAt
    ? formatEnrichmentConfirmation(item, enriched.result, config.timezone)
    : confirmation(item, selectedReminderAt, action.reminderMode, urlFetchFailed, config.timezone))
    + adjustmentSuffix(reminderAdjusted);
  return { text, item, reminderAt: selectedReminderAt };
}

async function enrichAndPersistItem(
  env: Env,
  item: Item,
  message: string,
  provider: AIProvider | null,
  fetcher: typeof fetch,
  now: Date,
  promoteEnrichedTitle: boolean,
  observedPages?: WebPageBatch,
): Promise<{ item: Item; result: ItemEnrichmentResult | null }> {
  const result = await enrichItemFromUrls(item, message, provider, getConfig(env), fetcher, observedPages);
  if (!result) return { item, result: null };

  const tags = [...new Set([...item.tags, ...result.dossier.tags])].slice(0, 12);
  await mergeItemEnrichment(env.DB, item.id, {
    ...item.aiEnrichment,
    ...result.dossier,
  }, {
    ...item.metadata,
    reader: "basic-html",
    web_sources: result.sources,
    readable_source_count: result.readableSourceCount,
    failed_source_count: result.failedSourceCount,
    fetch_status: result.readableSourceCount > 0 ? "ok" : "failed",
  }, {
    ...(promoteEnrichedTitle && result.dossier.title ? { title: result.dossier.title } : {}),
    primaryUrl: result.primaryUrl,
    ...(result.dossier.deadline ? { dueAtIfMissing: result.dossier.deadline } : {}),
    tags,
  }, now);
  return { item: await getItem(env.DB, item.id) ?? item, result };
}

function formatEnrichmentConfirmation(item: Item, result: ItemEnrichmentResult, timezone: string): string {
  if (result.dossier.category === "recruitment") {
    const lines = [`✓ 已整理招聘信息：${item.title}`];
    if (result.dossier.organizations.length > 0) lines.push(`机构：${result.dossier.organizations.join("、")}`);
    if (result.dossier.roles.length > 0) lines.push(`岗位：${result.dossier.roles.join("、")}`);
    if (item.dueAt) lines.push(`截止：${formatConfirmation(item.dueAt, timezone)}`);
    lines.push(`来源：已读取 ${result.readableSourceCount}/${result.sources.length} 个网页`);
    return lines.join("\n");
  }
  if (result.readableSourceCount === 0) return "✓ 已保存链接（网页暂时无法解析）。";
  const labels: Record<string, string> = {
    application: "申请信息",
    event: "活动信息",
    article: "文章",
    paper: "论文",
    documentation: "文档",
    tool: "工具信息",
    product: "产品信息",
    resource: "链接",
    other: "链接",
  };
  const label = result.dossier.category ? labels[result.dossier.category] ?? "链接" : "链接";
  const lines = [`✓ 已整理${label}：${item.title}`];
  if (result.dossier.summary) lines.push(`摘要：${result.dossier.summary}`);
  if (result.dossier.key_points.length > 0) lines.push(`要点：${result.dossier.key_points.slice(0, 3).join("；")}`);
  if (item.dueAt) lines.push(`截止：${formatConfirmation(item.dueAt, timezone)}`);
  lines.push(`来源：已读取 ${result.readableSourceCount}/${result.sources.length} 个网页`);
  return lines.join("\n");
}

function reminderWindow(item: Item, reminderAt: string): ScheduleWindow {
  return {
    itemId: item.id,
    title: `${item.title}（提醒）`,
    startAt: reminderAt,
    endAt: new Date(new Date(reminderAt).getTime() + 15 * 60_000).toISOString(),
    source: "reminder",
  };
}

function adjustmentSuffix(adjusted: boolean): string {
  return adjusted ? "\n已避开日程冲突。" : "";
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

async function answerQuery(
  message: string,
  items: Item[],
  provider: AIProvider | null,
  timezone: string,
  now: Date,
): Promise<string> {
  const fallback = formatSearchResults(items, timezone);
  if (!provider || items.length === 0) return fallback;
  try {
    const response = await provider.generate({
      purpose: "query_response",
      maxTokens: 900,
      messages: [
        {
          role: "system",
          content: `${QUERY_RESPONSE_PROMPT}\n当前时间：${now.toISOString()}\n用户时区：${timezone}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            question: message.slice(0, 2_000),
            tool_results: items.slice(0, 20).map((item) => {
              const enrichment = summarizeItemEnrichment(item.aiEnrichment);
              return {
                id: item.id,
                type: item.type,
                title: item.title,
                content: item.content.slice(0, 500),
                url: item.url,
                tags: item.tags.slice(0, 8),
                status: item.status,
                priority: item.priority,
                due_at: item.dueAt,
                ...(enrichment ? { enrichment } : {}),
              };
            }),
          }),
        },
      ],
    });
    return response.text.trim().slice(0, 3_500) || `模型这次没能整理检索结果，先给你可核对的记录：\n${fallback}`;
  } catch (error) {
    log("warn", "query_response_failed", { error: error instanceof Error ? error.message : String(error) });
    return `模型这次没能整理检索结果，先给你可核对的记录：\n${fallback}`;
  }
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
