import { describe, expect, it } from "vitest";
import { fetchXiaohongshuPage } from "../src/xiaohongshu/fetch";
import { parseXiaohongshuPage } from "../src/xiaohongshu/parser";

const noteId = "6a827aa90000000033019519";
const sourceUrl = `https://www.xiaohongshu.com/discovery/item/${noteId}?xsec_token=share-token`;

function pageWithState(state: string): string {
  return `<html><body><script>window.__INITIAL_STATE__ = ${state}</script></body></html>`;
}

describe("Xiaohongshu page reading", () => {
  it("parses an authenticated note without evaluating page JavaScript", () => {
    const html = pageWithState(`{
      "global":{"ignored":undefined},
      "user":{"loggedIn":true},
      "note":{
        "noteDetailMap":{
          "${noteId}":{
            "note":{
              "noteId":"${noteId}",
              "title":"招聘",
              "desc":"西湖大学 AiAT 招聘研究助理。\\n周五前投递简历。",
              "time":1786968000000,
              "user":{"nickname":"人工智能艺术诊疗研究中心"},
              "tagList":[{"name":"招聘"},{"name":"人工智能"}],
              "imageList":[
                {"urlDefault":"https://sns-img.example/1.jpg","width":1080,"height":1440},
                {"urlPre":"https://sns-img.example/2.jpg"}
              ]
            }
          }
        },
        "serverRequestInfo":{"state":"success"}
      }
    }`);

    expect(parseXiaohongshuPage(html, sourceUrl, true)).toEqual({
      status: "read",
      accountConfigured: true,
      authenticated: true,
      noteId,
      canonicalUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
      title: "招聘",
      description: "西湖大学 AiAT 招聘研究助理。\n周五前投递简历。",
      author: { nickname: "人工智能艺术诊疗研究中心" },
      tags: ["招聘", "人工智能"],
      publishedAt: "2026-08-17T12:00:00.000Z",
      media: [
        { type: "image", url: "https://sns-img.example/1.jpg", width: 1080, height: 1440 },
        { type: "image", url: "https://sns-img.example/2.jpg" },
      ],
      mediaTextStatus: "not_extracted",
    });
  });

  it("distinguishes missing login, expired sessions, and unavailable posts", () => {
    const loggedOut = pageWithState(`{
      "user":{"loggedIn":false},
      "note":{"noteDetailMap":{"${noteId}":{"note":{}}},"serverRequestInfo":{"state":"fail","errorCode":-510001}}
    }`);
    expect(parseXiaohongshuPage(loggedOut, sourceUrl, false)).toMatchObject({
      status: "login_required",
      accountConfigured: false,
      authenticated: false,
      noteId,
    });
    expect(parseXiaohongshuPage(loggedOut, sourceUrl, true)).toMatchObject({
      status: "session_expired",
      accountConfigured: true,
      authenticated: false,
      noteId,
    });

    const unavailable = pageWithState(`{
      "user":{"loggedIn":true},
      "note":{"noteDetailMap":{"${noteId}":{"note":{}}},"serverRequestInfo":{"state":"fail","errorCode":-510001}}
    }`);
    expect(parseXiaohongshuPage(unavailable, sourceUrl, true)).toMatchObject({
      status: "unavailable",
      accountConfigured: true,
      authenticated: true,
      noteId,
    });
  });

  it("summarizes an exposed video URL without claiming its visual text was extracted", () => {
    const videoPage = pageWithState(`{
      "user":{"loggedIn":true},
      "note":{"noteDetailMap":{"${noteId}":{"note":{
        "noteId":"${noteId}",
        "title":"视频帖",
        "desc":"正文可读",
        "video":{"media":{"stream":{"h264":[{"masterUrl":"https://sns-video.example/main.mp4"}]}}}
      }}}}
    }`);
    expect(parseXiaohongshuPage(videoPage, sourceUrl, true)).toMatchObject({
      status: "read",
      media: [{ type: "video", url: "https://sns-video.example/main.mp4" }],
      mediaTextStatus: "not_extracted",
    });
  });

  it("reads the user and note stores even when unrelated authenticated state is not JSON", () => {
    const authenticatedWithRuntimeValues = pageWithState(`{
      "global":{"runtimeCache":new Map([["account",1]])},
      "user":{"loggedIn":true},
      "account":{"lastSeen":NaN,"quota":Infinity},
      "note":{"noteDetailMap":{"${noteId}":{"note":{
        "noteId":"${noteId}",
        "title":"登录后正文",
        "desc":"这部分应当正常读取",
        "user":{"nickname":"研究中心"},
        "tagList":[],
        "imageList":[]
      }}}}
    }`);

    expect(parseXiaohongshuPage(authenticatedWithRuntimeValues, sourceUrl, true)).toMatchObject({
      status: "read",
      authenticated: true,
      title: "登录后正文",
      description: "这部分应当正常读取",
    });
  });

  it("sends the account cookie only to Xiaohongshu hosts and revalidates redirects", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      calls.push({ url, headers });
      if (url === "https://xhslink.com/a/test") {
        return new Response(null, { status: 302, headers: { location: sourceUrl } });
      }
      return new Response("<html>ok</html>", { headers: { "content-type": "text/html" } });
    };

    await expect(fetchXiaohongshuPage("https://xhslink.com/a/test", {
      cookie: "web_session=test-session",
      timeoutMs: 1_000,
      maxBytes: 20_000,
    }, fetcher)).resolves.toMatchObject({ url: sourceUrl, body: "<html>ok</html>" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.get("Cookie")).toBeNull();
    expect(calls[1]?.headers.get("Cookie")).toBe("web_session=test-session");
  });

  it("rejects unrelated hosts, unsafe redirect targets, and oversized pages without exposing the cookie", async () => {
    await expect(fetchXiaohongshuPage("https://example.com/post", {
      cookie: "web_session=sensitive",
      timeoutMs: 1_000,
      maxBytes: 100,
    })).rejects.toThrow("Xiaohongshu");

    const redirectFetcher: typeof fetch = async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/private" },
    });
    await expect(fetchXiaohongshuPage("https://xhslink.com/a/test", {
      cookie: "web_session=sensitive",
      timeoutMs: 1_000,
      maxBytes: 100,
    }, redirectFetcher)).rejects.not.toThrow("sensitive");

    const oversizedFetcher: typeof fetch = async () => new Response("too large", {
      headers: { "content-type": "text/html", "content-length": "500" },
    });
    await expect(fetchXiaohongshuPage(sourceUrl, {
      cookie: "web_session=sensitive",
      timeoutMs: 1_000,
      maxBytes: 100,
    }, oversizedFetcher)).rejects.toThrow("size");
  });
});
