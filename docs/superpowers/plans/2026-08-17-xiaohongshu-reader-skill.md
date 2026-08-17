# Xiaohongshu Reader Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Desk-IX read explicitly shared Xiaohongshu posts through an optional authenticated account session, organize their facts into existing memory, and correctly continue from a QQ share card into the user's next short instruction.

**Architecture:** Add a Xiaohongshu-only fetcher that accepts only approved Xiaohongshu hosts, forwards the configured cookie only to `xiaohongshu.com`, revalidates every redirect, and bounds response bytes. Parse the server-rendered `window.__INITIAL_STATE__` without evaluating JavaScript. Expose the result through one user-scoped Think tool and an on-demand Agent Skill; existing `item_create` and `item_update` remain the only persistence primitives.

**Tech Stack:** TypeScript, Cloudflare Workers, Cloudflare Think/Agents SDK Agent Skills, Zod, Vitest Workers pool, D1.

---

### Task 1: Define the post result and safe page parser

**Files:**
- Create: `src/xiaohongshu/parser.ts`
- Create: `src/xiaohongshu/types.ts`
- Test: `test/xiaohongshu.test.ts`

- [ ] **Step 1: Write failing parser tests**

Use representative server-rendered states rather than the live service:

```ts
const result = parseXiaohongshuPage(successHtml, sourceUrl);
expect(result).toMatchObject({
  status: "read",
  noteId: "6a827aa90000000033019519",
  title: "招聘",
  author: { nickname: "研究中心" },
  tags: ["招聘", "人工智能"],
});
```

Also cover bare `undefined` values, empty `noteDetailMap`, expired sessions, deleted/private content, image count, canonical URLs, and invalid initial state.

- [ ] **Step 2: Run the test and confirm the missing-module failure**

Run: `npx vitest run test/xiaohongshu.test.ts`

Expected: FAIL because the parser module does not exist.

- [ ] **Step 3: Implement a non-evaluating initial-state parser**

```ts
export function extractInitialState(html: string): unknown {
  const marker = "window.__INITIAL_STATE__=";
  const start = html.indexOf(marker);
  if (start < 0) throw new XiaohongshuParseError("Initial state was not found");
  const objectText = readBalancedObject(html, start + marker.length);
  return JSON.parse(replaceBareUndefined(objectText)) as unknown;
}
```

Scan braces while respecting escaped JSON strings. Replace `undefined` only outside strings; never use `eval`, `Function`, or DOM script execution. Walk untyped objects with type guards and return a serializable discriminated union:

```ts
type XiaohongshuReadResult =
  | { status: "read"; noteId: string; title: string; description: string; author: Author | null; tags: string[]; media: MediaSummary }
  | { status: "login_required" | "session_expired" | "unavailable"; reason: string; noteId: string | null };
```

- [ ] **Step 4: Run parser tests**

Run: `npx vitest run test/xiaohongshu.test.ts`

Expected: PASS without evaluating page scripts.

### Task 2: Fetch only Xiaohongshu pages with an optional account session

**Files:**
- Create: `src/xiaohongshu/fetch.ts`
- Create: `src/xiaohongshu/reader.ts`
- Modify: `src/config.ts`
- Modify: `src/env.d.ts`
- Modify: `.dev.vars.example`
- Modify: `wrangler.test.jsonc`
- Modify: `vitest.config.ts`
- Test: `test/xiaohongshu.test.ts`

- [ ] **Step 1: Write fetch security tests**

Assert that ordinary and private URLs are rejected, redirects are revalidated, a configured cookie is sent to `www.xiaohongshu.com`, and the cookie is never sent to `xhslink.com` or another redirect host.

```ts
expect(calls[0]?.headers.get("Cookie")).toBeNull();
expect(calls[1]?.url).toContain("xiaohongshu.com");
expect(calls[1]?.headers.get("Cookie")).toBe("web_session=test");
```

- [ ] **Step 2: Add secret-backed configuration**

Declare `XHS_COOKIE` as a secret and add a non-secret `XHS_MAX_BYTES` setting with a two-megabyte default because real Xiaohongshu SSR pages are larger than ordinary articles. Never put a real session value in repository config, test output, logs, tool results, or health responses.

- [ ] **Step 3: Implement the bounded, host-scoped fetcher**

```ts
export async function fetchXiaohongshuPage(
  rawUrl: string,
  options: { cookie: string; timeoutMs: number; maxBytes: number },
  fetcher: typeof fetch = fetch,
): Promise<FetchedXiaohongshuPage>;
```

Accept only `xiaohongshu.com` subdomains and `xhslink.com`. Call `validatePublicHttpUrl` for every hop, use `redirect: "manual"`, send the account cookie only when the current hostname is `xiaohongshu.com` or one of its subdomains, accept HTML only, stream into a bounded buffer, and return explicit errors.

- [ ] **Step 4: Combine fetching and parsing**

`readXiaohongshuPost` reports whether an account session was configured but never returns the cookie. An empty note without a cookie becomes `login_required`; an empty note with a configured but logged-out state becomes `session_expired`; a logged-in response with a platform error becomes `unavailable`.

- [ ] **Step 5: Run security and parser tests**

Run: `npx vitest run test/xiaohongshu.test.ts`

Expected: PASS for content extraction, bounded I/O, redirect safety, and credential non-disclosure.

### Task 3: Expose one user-scoped read tool and an on-demand organizing skill

**Files:**
- Create: `src/agent/tools/xiaohongshu.ts`
- Create: `src/agent/skills/xiaohongshu-organize/SKILL.md`
- Create: `src/agent/skills/xiaohongshu-organize/evals/evals.json`
- Create: `src/agent/skills/xiaohongshu.ts`
- Modify: `src/agent/composa-agent.ts`
- Modify: `src/agent/prompt.ts`
- Modify: `src/agent/types.ts`
- Test: `test/agent-xiaohongshu-skill.test.ts`

- [ ] **Step 1: Write failing tool and skill tests**

Assert the descriptor triggers on Xiaohongshu links/cards and contextual phrases such as “整理刚才这个招聘信息”. Verify the tool accepts explicit URLs or one owned item ID and rejects cross-user item access.

- [ ] **Step 2: Implement `xiaohongshu_read`**

```ts
inputSchema: z.object({
  itemId: z.string().uuid().optional(),
  urls: z.array(z.string().url()).optional(),
}).refine((value) => Boolean(value.itemId || value.urls?.length));
```

When `itemId` is present, load only the current user's item and discover Xiaohongshu URLs in its URL, content, and raw message. Process every explicit relevant URL and return per-post results and failures without hiding partial success.

- [ ] **Step 3: Write the skill**

The skill must instruct the Agent to:

1. Treat a Xiaohongshu card and the immediately following short instruction as one conversational object.
2. Resolve the previous record or URL from conversation and `memory_search`; do not ask the user to resend content that is already present.
3. Read before summarizing; update the existing raw record rather than create a duplicate.
4. Organize facts according to the user's actual goal (recruitment, methods, places, products, ideas) without fixed category branches.
5. Preserve the source URL and distinguish card-only, full textual read, and media text not extracted.
6. Report login/session expiry honestly and never claim image text was read when it was not.

- [ ] **Step 4: Register the skill and tool**

Return both calendar and Xiaohongshu skill sources from `getSkills()`, add `xiaohongshu_read` to the active tools, merge the tool into `getTools()`, and publish both skill families in the runtime profile.

- [ ] **Step 5: Run catalog and tool tests**

Run: `npx vitest run test/agent-xiaohongshu-skill.test.ts test/agent-runtime.test.ts`

Expected: PASS with a clean `SkillRegistry` and no warnings.

### Task 4: Reproduce the last QQ card-to-instruction round

**Files:**
- Create: `test/xiaohongshu-skill-loop.test.ts`
- Modify: `src/agent/prompt.ts`

- [ ] **Step 1: Build the real conversation fixture**

Use three messages: the QQ Xiaohongshu recruitment card, Desk-IX's partial “待核实” response, then “帮我整理记录一下这个招聘信息”. Seed the raw owned item created by the first turn.

- [ ] **Step 2: Run a deterministic native tool loop**

The model sequence must be:

```text
activate_skill → memory_search → item_get → xiaohongshu_read → item_update → final reply
```

Use a successful authenticated SSR fixture. Assert the same item ID is updated with complete extracted facts, no duplicate item is created, and the final reply does not ask for the link again.

- [ ] **Step 3: Add permanent continuity guidance**

Keep one concise always-on rule that adjacent platform cards and a following deictic instruction (“这个、刚才那个”) share context. Detailed Xiaohongshu workflow remains inside the skill.

- [ ] **Step 4: Run the loop test**

Run: `npx vitest run test/xiaohongshu-skill-loop.test.ts`

Expected: PASS with the exact tool order and one enriched record.

### Task 5: Document, verify, configure, deploy, and merge

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/deployment.md`
- Create: `docs/xiaohongshu.md`

- [ ] **Step 1: Document safe account configuration**

Explain that `XHS_COOKIE` is a replaceable browser session, not an account password; it is only sent to Xiaohongshu hosts. Describe Dashboard or `wrangler secret put XHS_COOKIE`, how to verify with a shared post, expiry behavior, and the explicit-link-only scope. State that favorites/feed sync and image OCR are not silently implemented.

- [ ] **Step 2: Update health without leaking credentials**

Expose only `integrations.xiaohongshu.configured: boolean`. Extend the health test to prove neither the cookie nor any user identifier appears.

- [ ] **Step 3: Run complete validation**

Run: `npm run types`, `npm run typecheck`, `npm run lint`, `npm test`, and `npm run deploy:dry`.

Expected: all checks pass, with no new migration or binding beyond the generated secret type.

- [ ] **Step 4: Configure and verify the account session**

Ask the user for the session value only through the Cloudflare secret prompt or Dashboard, never through chat or logs. Deploy, send the last shared post again, and confirm a full read or an explicit session-expired result.

- [ ] **Step 5: Create PR, wait for CI, merge, and synchronize main**

Push `codex/xiaohongshu-reader-skill`, create the PR, merge only after validation passes, synchronize `main`, redeploy the merged commit, and verify `/health` returns HTTP 200.
