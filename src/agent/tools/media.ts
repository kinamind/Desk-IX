import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getConfig } from "../../config";
import {
  getOwnedMediaAssets,
  markOwnedMediaAnalyzed,
  markOwnedMediaFailed,
} from "../../db/media";
import { fetchPublicImage } from "../../media/fetch";
import { analyzeImages, type VisionAnalysis, type VisionInput } from "../../media/vision";
import type { AgentPrincipal } from "../context";

type PrincipalProvider = () => AgentPrincipal;

export interface MediaReadInput {
  attachmentIds?: string[] | undefined;
  urls?: string[] | undefined;
  instruction?: string | undefined;
}

export type MediaAnalyzer = (
  inputs: VisionInput[],
  options: { abortSignal?: AbortSignal; instruction?: string },
) => Promise<VisionAnalysis>;

export async function readOwnedMedia(
  env: Env,
  principal: AgentPrincipal,
  input: MediaReadInput,
  fetcher: typeof fetch = fetch,
  analyzer: MediaAnalyzer = (images, options) => analyzeImages(env, images, options),
  abortSignal?: AbortSignal,
) {
  const requestedIds = Array.from(new Set(input.attachmentIds ?? []));
  const requestedUrls = Array.from(new Set(input.urls ?? []));
  const assets = await getOwnedMediaAssets(env.DB, principal.channel, principal.userId, requestedIds);
  const foundIds = new Set(assets.map((asset) => asset.id));
  const failures: Array<{ source: string; error: string }> = requestedIds
    .filter((id) => !foundIds.has(id))
    .map((id) => ({ source: `attachment:${id}`, error: "Attachment was not found in the current user's media" }));
  const cachedTexts = Array.from(new Set(assets
    .filter((asset) => asset.analysisStatus === "analyzed" && asset.analysisText)
    .map((asset) => asset.analysisText!)));
  const pending = [
    ...assets.filter((asset) => asset.analysisStatus !== "analyzed").map((asset) => ({
      source: `attachment:${asset.id}`,
      attachmentId: asset.id,
      url: asset.sourceUrl,
      filename: asset.filename ?? undefined,
    })),
    ...requestedUrls.map((url, index) => ({ source: `url:${index + 1}`, url, filename: undefined })),
  ];
  const config = getConfig(env);
  const visionInputs: VisionInput[] = [];
  const analyzedSources: Array<{ source: string; attachmentId: string | null; mediaType: string }> = [];
  for (const entry of pending) {
    try {
      const image = await fetchPublicImage(entry.url, {
        timeoutMs: config.urlFetchTimeoutMs,
        maxBytes: config.mediaMaxBytes,
        ...(abortSignal ? { abortSignal } : {}),
      }, fetcher);
      visionInputs.push({
        data: image.bytes,
        mediaType: image.mediaType,
        ...(entry.filename ? { filename: entry.filename } : {}),
        label: entry.source,
      });
      analyzedSources.push({
        source: entry.source,
        attachmentId: "attachmentId" in entry ? entry.attachmentId : null,
        mediaType: image.mediaType,
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      failures.push({ source: entry.source, error: message });
      if ("attachmentId" in entry) {
        await markOwnedMediaFailed(env.DB, principal.channel, principal.userId, entry.attachmentId, message);
      }
    }
  }

  let fresh: VisionAnalysis | null = null;
  if (visionInputs.length > 0) {
    try {
      fresh = await analyzer(visionInputs, {
        ...(abortSignal ? { abortSignal } : {}),
        ...(input.instruction ? { instruction: input.instruction } : {}),
      });
      const ownedIds = analyzedSources.flatMap((source) => source.attachmentId ? [source.attachmentId] : []);
      if (ownedIds.length > 0) {
        await markOwnedMediaAnalyzed(env.DB, principal.channel, principal.userId, ownedIds, {
          text: fresh.text,
          model: fresh.model,
        });
      }
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      failures.push({ source: "vision", error: message });
      for (const source of analyzedSources) {
        if (source.attachmentId) {
          await markOwnedMediaFailed(env.DB, principal.channel, principal.userId, source.attachmentId, message);
        }
      }
    }
  }
  const analysisText = [...cachedTexts, ...(fresh ? [fresh.text] : [])].join("\n\n").trim();
  return {
    analysisText: analysisText || null,
    cachedAttachmentCount: assets.filter((asset) => asset.analysisStatus === "analyzed").length,
    analyzed: analyzedSources,
    failures,
  };
}

export function createMediaTools(
  env: Env,
  principal: PrincipalProvider,
  fetcher: typeof fetch = fetch,
  analyzer?: MediaAnalyzer,
): ToolSet {
  return {
    media_read: tool({
      description: "Read image attachments already present in this QQ conversation or explicit public image URLs from ordinary web pages and GitHub. Use attachmentIds from the [媒体附件] block; do not ask the user to re-upload an attachment before trying this tool. It accepts public HTTP and HTTPS, validates every redirect and the actual image bytes, uses the configured multimodal model, caches owned attachment analysis, and never returns signed source URLs.",
      inputSchema: z.object({
        attachmentIds: z.array(z.string().uuid()).optional(),
        urls: z.array(z.string().url()).optional(),
        instruction: z.string().trim().min(1).max(2_000).optional(),
      }).refine((value) => Boolean(value.attachmentIds?.length || value.urls?.length), "Provide attachmentIds or urls"),
      execute: (input, options) => readOwnedMedia(
        env,
        principal(),
        input,
        fetcher,
        analyzer ?? ((images, visionOptions) => analyzeImages(env, images, visionOptions)),
        options.abortSignal,
      ),
    }),
  };
}
