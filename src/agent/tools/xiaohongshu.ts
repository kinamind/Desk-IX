import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getConfig } from "../../config";
import { getOwnedItem } from "../../db/items";
import { discoverUrls } from "../../url/reader";
import { isXiaohongshuUrl } from "../../xiaohongshu/fetch";
import { readXiaohongshuPost } from "../../xiaohongshu/reader";
import type { XiaohongshuImageAnalysis, XiaohongshuVisionOptions } from "../../xiaohongshu/vision";
import { analyzeXiaohongshuImages } from "../../xiaohongshu/vision";
import type { XiaohongshuMedia, XiaohongshuReadResult } from "../../xiaohongshu/types";
import type { AgentPrincipal } from "../context";

type PrincipalProvider = () => AgentPrincipal;
export type XiaohongshuMediaAnalyzer = (
  media: XiaohongshuMedia[],
  options?: Pick<XiaohongshuVisionOptions, "abortSignal">,
) => Promise<XiaohongshuImageAnalysis>;

export interface XiaohongshuReadInput {
  itemId?: string | undefined;
  urls?: string[] | undefined;
}

export async function readOwnedXiaohongshuPosts(
  env: Env,
  principal: AgentPrincipal,
  input: XiaohongshuReadInput,
  fetcher: typeof fetch = fetch,
  mediaAnalyzer?: XiaohongshuMediaAnalyzer,
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
      const result = await readXiaohongshuPost(requestedUrl, config, env.XHS_COOKIE ?? "", fetcher);
      posts.push({ requestedUrl, result: await addMediaAnalysis(result, mediaAnalyzer) });
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
  mediaAnalyzer: XiaohongshuMediaAnalyzer = (media, options) => analyzeXiaohongshuImages(env, media, options),
): ToolSet {
  return {
    xiaohongshu_read: tool({
      description: "Read explicitly shared Xiaohongshu posts with the configured account session, then use the configured multimodal model to extract visible text and facts from every trusted post image. Supply direct share URLs or an owned itemId whose saved URL/content contains them. Use this instead of ordinary web_read for Xiaohongshu. A matching existing item only prevents duplicate creation: call this again whenever that item is raw, partial, or its previous read failed. It returns separate page-text and mediaText statuses, degrades without losing successful text, and never exposes credentials.",
      inputSchema: z.object({
        itemId: z.string().uuid().optional(),
        urls: z.array(z.string().url()).optional(),
      }).refine((value) => Boolean(value.itemId || value.urls?.length), "Provide itemId or urls"),
      execute: (input, options) => readOwnedXiaohongshuPosts(
        env,
        principal(),
        input,
        fetcher,
        (media) => mediaAnalyzer(media, { abortSignal: options.abortSignal }),
      ),
    }),
  };
}

async function addMediaAnalysis(
  result: XiaohongshuReadResult,
  mediaAnalyzer?: XiaohongshuMediaAnalyzer,
): Promise<XiaohongshuReadResult> {
  const imageCount = result.status === "read"
    ? result.media.filter((entry) => entry.type === "image").length
    : 0;
  if (result.status !== "read" || imageCount === 0 || !mediaAnalyzer) return result;
  try {
    const analysis = await mediaAnalyzer(result.media);
    return {
      ...result,
      mediaTextStatus: analysis.skippedImageCount > 0 ? "partially_extracted" : "extracted",
      mediaText: analysis.text,
      analyzedImageCount: analysis.analyzedImageCount,
      skippedImageCount: analysis.skippedImageCount,
    };
  } catch {
    return {
      ...result,
      mediaTextStatus: "analysis_failed",
      analyzedImageCount: 0,
      skippedImageCount: imageCount,
      mediaAnalysisError: "The configured AI model could not analyze this post's images.",
    };
  }
}
