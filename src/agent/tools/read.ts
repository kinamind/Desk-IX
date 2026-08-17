import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getConfig } from "../../config";
import type { Item } from "../../core/types";
import { getOwnedItem, listOwnedItemReminders, searchOwnedItemsNatural } from "../../db/items";
import { ensureUserProfile, getUserProfile } from "../../db/user-profiles";
import { listOwnedWorkSessions } from "../../db/work-sessions";
import { discoverUrls, readWebPagesFromText } from "../../url/reader";
import type { AgentPrincipal } from "../context";

type PrincipalProvider = () => AgentPrincipal;

function compactItem(item: Item) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    content: item.content,
    url: item.url,
    tags: item.tags,
    status: item.status,
    priority: item.priority,
    estimatedDuration: item.estimatedDuration,
    dueAt: item.dueAt,
    startAfter: item.startAfter,
    temporalRole: item.temporalRole,
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
  const result = await searchOwnedItemsNatural(env.DB, principal.channel, principal.userId, query, limit);
  return {
    query,
    count: result.items.length,
    matchMode: result.matchMode,
    requiresConversationContext: result.matchMode === "recent_fallback",
    items: result.items.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      status: item.status,
      dueAt: item.dueAt,
      updatedAt: item.updatedAt,
      url: item.url,
      snippet: item.content,
      links: discoverUrls([item.url ?? "", item.content, item.rawMessage].join("\n")),
    })),
  };
}

export async function loadOwnedItem(env: Env, principal: AgentPrincipal, itemId: string) {
  const item = await getOwnedItem(env.DB, itemId, principal.channel, principal.userId);
  if (!item) throw new Error("Item not found in the current user's memory");
  const reminders = await listOwnedItemReminders(env.DB, item.id, principal.channel, principal.userId);
  const workSessions = await listOwnedWorkSessions(env.DB, item.id, principal.channel, principal.userId);
  return { item: compactItem(item), reminders, workSessions };
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
  const urls = discoverUrls(sourceText);
  if (urls.length === 0) throw new Error("No readable public URL was found");
  const batch = await readWebPagesFromText(urls.join("\n"), getConfig(env), fetcher, urls.length);
  return {
    requestedUrls: batch.requestedUrls,
    pages: batch.pages.map((page) => ({
      url: page.finalUrl,
      title: page.title,
      description: page.description,
      canonicalUrl: page.canonicalUrl,
      source: page.source,
      text: page.text,
      truncated: page.truncated,
    })),
    failures: batch.failures,
  };
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
      description: "Search this user's saved tasks, notes, resources, ideas, and projects. Resolve 上一条/刚才那个 from the actual conversation first, and use concrete content from a [引用消息] block as a strong anchor. matchMode=lexical is a real text match. matchMode=recent_fallback only supplies context candidates and is not sufficient evidence by itself; use conversation history to disambiguate before changing anything.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(2_000),
        limit: z.number().int().min(1).default(8),
      }),
      execute: ({ query, limit }) => memorySearch(env, principal(), query, limit),
    }),
    item_get: tool({
      description: "Load one saved item, its reminders, and its concrete work sessions after memory_search identifies its exact ID. Access is restricted to the current user.",
      inputSchema: z.object({ itemId: z.string().uuid() }),
      execute: ({ itemId }) => loadOwnedItem(env, principal(), itemId),
    }),
    web_read: tool({
      description: "Read ordinary public web pages. Supply explicit URLs or an owned itemId to read every relevant link stored on that item. Use this whenever the requested operation depends on what linked pages actually say; the fetcher retains SSRF, timeout, and per-page byte protections.",
      inputSchema: z.object({
        itemId: z.string().uuid().optional(),
        urls: z.array(z.string().url()).optional(),
      }).refine((value) => Boolean(value.itemId || value.urls?.length), "Provide itemId or urls"),
      execute: (input) => readOwnedWebPages(env, principal(), input),
    }),
    profile_get: tool({
      description: "Read this user's persistent forms of address, timezone, daily-plan subscription and time, chronotype, optional sleep goals, coaching preference, communication style, and other planning preferences.",
      inputSchema: z.object({}),
      execute: () => loadOwnedProfile(env, principal()),
    }),
  };
}
