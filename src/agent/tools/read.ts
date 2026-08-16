import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getConfig } from "../../config";
import type { Item, ScheduleWindow } from "../../core/types";
import { getOwnedItem, listOwnedItemReminders, searchOwnedItemsNatural } from "../../db/items";
import { listScheduleWindows } from "../../db/schedule";
import { ensureUserProfile, getUserProfile } from "../../db/user-profiles";
import { discoverUrls, readWebPagesFromText } from "../../url/reader";
import type { AgentPrincipal } from "../context";

type PrincipalProvider = () => AgentPrincipal;

function compactItem(item: Item) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    content: item.content.slice(0, 8_000),
    url: item.url,
    tags: item.tags,
    status: item.status,
    priority: item.priority,
    estimatedDuration: item.estimatedDuration,
    dueAt: item.dueAt,
    startAfter: item.startAfter,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    aiEnrichment: item.aiEnrichment,
    metadata: item.metadata,
  };
}

export async function memorySearch(
  env: Env,
  principal: AgentPrincipal,
  query: string,
  limit = 8,
) {
  const items = await searchOwnedItemsNatural(env.DB, principal.channel, principal.userId, query, limit);
  return {
    query,
    count: items.length,
    items: items.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      status: item.status,
      dueAt: item.dueAt,
      updatedAt: item.updatedAt,
      url: item.url,
      snippet: item.content.slice(0, 500),
      links: discoverUrls([item.url ?? "", item.content, item.rawMessage].join("\n"), 3),
    })),
  };
}

export async function loadOwnedItem(env: Env, principal: AgentPrincipal, itemId: string) {
  const item = await getOwnedItem(env.DB, itemId, principal.channel, principal.userId);
  if (!item) throw new Error("Item not found in the current user's memory");
  const reminders = await listOwnedItemReminders(env.DB, item.id, principal.channel, principal.userId);
  return { item: compactItem(item), reminders };
}

export async function readOwnedWebPages(
  env: Env,
  principal: AgentPrincipal,
  input: { itemId?: string | undefined; urls?: string[] | undefined },
  fetcher: typeof fetch = fetch,
) {
  let sourceText = (input.urls ?? []).join("\n");
  if (input.itemId) {
    const item = await getOwnedItem(env.DB, input.itemId, principal.channel, principal.userId);
    if (!item) throw new Error("Item not found in the current user's memory");
    sourceText = [sourceText, item.url ?? "", item.content, item.rawMessage].join("\n");
  }
  const urls = discoverUrls(sourceText, 3);
  if (urls.length === 0) throw new Error("No readable public URL was found");
  const batch = await readWebPagesFromText(urls.join("\n"), getConfig(env), fetcher, 3);
  return {
    requestedUrls: batch.requestedUrls,
    pages: batch.pages.map((page) => ({
      url: page.finalUrl,
      title: page.title,
      description: page.description,
      canonicalUrl: page.canonicalUrl,
      source: page.source,
      text: page.text.slice(0, 8_000),
      truncated: page.truncated || page.text.length > 8_000,
    })),
    failures: batch.failures,
  };
}

export async function loadSchedule(
  env: Env,
  principal: AgentPrincipal,
  input: { from?: string | undefined; horizonDays?: number | undefined },
): Promise<{ timezone: string; windows: ScheduleWindow[] }> {
  const config = getConfig(env);
  const profile = await ensureUserProfile(env.DB, principal.channel, principal.userId, {
    timezone: config.timezone,
    locale: config.locale,
    dailyPlanTime: config.dailyPlanTime,
  });
  const from = input.from ? new Date(input.from) : new Date();
  if (Number.isNaN(from.getTime())) throw new Error("Invalid schedule start time");
  const windows = await listScheduleWindows(
    env.DB,
    principal.channel,
    principal.userId,
    from,
    input.horizonDays ?? 14,
  );
  return { timezone: profile.timezone, windows };
}

export async function loadOwnedProfile(env: Env, principal: AgentPrincipal) {
  const config = getConfig(env);
  return getUserProfile(env.DB, principal.channel, principal.userId)
    ?? ensureUserProfile(env.DB, principal.channel, principal.userId, {
      timezone: config.timezone,
      locale: config.locale,
      dailyPlanTime: config.dailyPlanTime,
    });
}

export function createReadTools(env: Env, principal: PrincipalProvider): ToolSet {
  return {
    memory_search: tool({
      description: "Search this user's saved tasks, notes, resources, ideas, and projects. Use it to resolve references such as 刚才那个/招聘信息 before reading or changing anything. Returns stable item IDs.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(12).default(8),
      }),
      execute: ({ query, limit }) => memorySearch(env, principal(), query, limit),
    }),
    item_get: tool({
      description: "Load one saved item and its reminders after memory_search identifies its exact ID. Access is restricted to the current user.",
      inputSchema: z.object({ itemId: z.string().uuid() }),
      execute: ({ itemId }) => loadOwnedItem(env, principal(), itemId),
    }),
    web_read: tool({
      description: "Read up to three ordinary public web pages. Supply explicit URLs or an owned itemId to read links stored on that item. Use this whenever the requested operation depends on what linked pages actually say.",
      inputSchema: z.object({
        itemId: z.string().uuid().optional(),
        urls: z.array(z.string().url()).max(3).optional(),
      }).refine((value) => Boolean(value.itemId || value.urls?.length), "Provide itemId or urls"),
      execute: (input) => readOwnedWebPages(env, principal(), input),
    }),
    schedule_list: tool({
      description: "List this user's busy and reminder windows before choosing a reminder time. Use it when the user asks to avoid existing plans or leaves the reminder time to your judgment.",
      inputSchema: z.object({
        from: z.string().datetime().optional(),
        horizonDays: z.number().int().min(1).max(30).default(14),
      }),
      execute: (input) => loadSchedule(env, principal(), input),
    }),
    profile_get: tool({
      description: "Read this user's persistent forms of address, timezone, daily-plan subscription and time, chronotype, optional sleep goals, coaching preference, communication style, and other planning preferences.",
      inputSchema: z.object({}),
      execute: () => loadOwnedProfile(env, principal()),
    }),
  };
}
