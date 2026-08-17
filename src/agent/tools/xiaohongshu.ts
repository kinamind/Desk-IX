import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getConfig } from "../../config";
import { getOwnedItem } from "../../db/items";
import { discoverUrls } from "../../url/reader";
import { isXiaohongshuUrl } from "../../xiaohongshu/fetch";
import { readXiaohongshuPost } from "../../xiaohongshu/reader";
import type { AgentPrincipal } from "../context";

type PrincipalProvider = () => AgentPrincipal;

export interface XiaohongshuReadInput {
  itemId?: string | undefined;
  urls?: string[] | undefined;
}

export async function readOwnedXiaohongshuPosts(
  env: Env,
  principal: AgentPrincipal,
  input: XiaohongshuReadInput,
  fetcher: typeof fetch = fetch,
) {
  let sourceText = (input.urls ?? []).join("\n");
  if (input.itemId) {
    const item = await getOwnedItem(env.DB, input.itemId, principal.channel, principal.userId);
    if (!item) throw new Error("Item not found in the current user's memory");
    sourceText = [sourceText, item.url ?? "", item.content, item.rawMessage].join("\n");
  }

  const requestedUrls = discoverUrls(sourceText).filter(isXiaohongshuUrl);
  const urls = Array.from(new Set(requestedUrls));
  if (urls.length === 0) throw new Error("No Xiaohongshu share URL was found");

  const config = getConfig(env);
  const posts: Array<{ requestedUrl: string; result: Awaited<ReturnType<typeof readXiaohongshuPost>> }> = [];
  const failures: Array<{ requestedUrl: string; error: string }> = [];
  for (const requestedUrl of urls) {
    try {
      posts.push({
        requestedUrl,
        result: await readXiaohongshuPost(requestedUrl, config, env.XHS_COOKIE ?? "", fetcher),
      });
    } catch (error) {
      failures.push({
        requestedUrl,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
  }
  return {
    itemId: input.itemId ?? null,
    requestedUrls: urls,
    posts,
    failures,
  };
}

export function createXiaohongshuTools(
  env: Env,
  principal: PrincipalProvider,
  fetcher: typeof fetch = fetch,
): ToolSet {
  return {
    xiaohongshu_read: tool({
      description: "Read explicitly shared Xiaohongshu posts with the configured account session. Supply direct share URLs or an owned itemId whose saved URL/content contains them. Use this instead of ordinary web_read for Xiaohongshu. It returns full textual post facts when available and explicit login/session/media limitations without exposing credentials.",
      inputSchema: z.object({
        itemId: z.string().uuid().optional(),
        urls: z.array(z.string().url()).optional(),
      }).refine((value) => Boolean(value.itemId || value.urls?.length), "Provide itemId or urls"),
      execute: (input) => readOwnedXiaohongshuPosts(env, principal(), input, fetcher),
    }),
  };
}
