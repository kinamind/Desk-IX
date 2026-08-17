export interface XiaohongshuAuthor {
  nickname: string;
}

export interface XiaohongshuMedia {
  type: "image" | "video";
  url: string;
  width?: number;
  height?: number;
}

interface XiaohongshuReadBase {
  accountConfigured: boolean;
  authenticated: boolean;
  noteId: string | null;
  canonicalUrl: string | null;
}

export interface XiaohongshuPost extends XiaohongshuReadBase {
  status: "read";
  noteId: string;
  canonicalUrl: string;
  title: string | null;
  description: string;
  author: XiaohongshuAuthor | null;
  tags: string[];
  publishedAt: string | null;
  media: XiaohongshuMedia[];
  mediaTextStatus: "not_extracted";
}

export interface XiaohongshuReadFailure extends XiaohongshuReadBase {
  status: "login_required" | "session_expired" | "unavailable";
  reason: string;
}

export type XiaohongshuReadResult = XiaohongshuPost | XiaohongshuReadFailure;

export interface FetchedXiaohongshuPage {
  url: string;
  body: string;
  truncated: boolean;
}
