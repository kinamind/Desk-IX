# Unified Media and Context Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Desk-IX one evidence pipeline in which QQ attachments and public web images can be understood by the configured multimodal model, while people, organizations, meetings, projects, and self/work facts become provenance-backed context for future planning.

**Architecture:** Channel adapters preserve attachments as structured inputs instead of flattening them into URLs. D1 stores lightweight media references and a user-scoped context graph; the Agent invokes a generic media reader and explicit context-memory actions, while relevant self/entity context is retrieved before each turn and participant context is returned with items and calendar entries. The model makes semantic and planning judgments; code enforces ownership, provenance, idempotency, bounded media reads, SSRF protection, and retraction.

**Tech Stack:** TypeScript, Cloudflare Workers, Cloudflare Think/Agents SDK, AI SDK v7, D1, Zod, Vitest Workers pool, Wrangler 4.

---

## File structure

- Create `migrations/0006_context_media.sql`: media assets, context entities, aliases, facts, and item/entity links.
- Create `src/db/media.ts`: owner-scoped media persistence and analysis caching.
- Create `src/media/fetch.ts`: bounded public HTTP(S) image fetching, redirect validation, and media sniffing.
- Create `src/media/vision.ts`: shared multimodal analysis used by QQ/web media and Xiaohongshu.
- Create `src/agent/tools/media.ts`: `media_read` Agent tool for owned attachment IDs or explicit public URLs.
- Create `src/db/context-memory.ts`: user-scoped entity resolution, facts, item links, search, and retraction.
- Create `src/agent/tools/context-memory.ts`: `context_search`, `context_remember`, and `context_forget` Agent interfaces.
- Modify `src/core/types.ts`: first-class incoming attachment, context entity/fact, and calendar participant types.
- Modify `src/channels/qq.ts`: preserve current and quoted attachments without exposing signed URLs as user text.
- Modify `src/agent/ingress.ts`, `src/agent/types.ts`, `src/agent/composa-agent.ts`: persist media, expose attachment IDs, register tools/actions, and retrieve relevant context.
- Modify `src/agent/tools/read.ts`, `src/agent/tools/calendar.ts`, `src/db/calendar.ts`: return people/organization context with items and calendar entries.
- Modify `src/xiaohongshu/vision.ts` and `src/agent/model.ts`: reuse the generic vision core while retaining the authenticated Xiaohongshu source adapter.
- Modify `src/config.ts`, `wrangler.jsonc`, generated types, and test helpers: add provider/runtime-derived media byte configuration.
- Modify `docs/architecture.md`, `docs/qq.md`, `docs/xiaohongshu.md`: document the unified evidence and memory model.
- Add tests in `test/media.test.ts`, `test/context-memory.test.ts`, and existing Agent/channel/calendar suites.

### Task 1: Add D1 evidence and context storage

**Files:**
- Create: `migrations/0006_context_media.sql`
- Create: `src/db/media.ts`
- Create: `src/db/context-memory.ts`
- Modify: `src/core/types.ts`
- Test: `test/context-memory.test.ts`

- [ ] **Step 1: Write failing ownership, provenance, alias, validity, item-link, and retraction tests**

```ts
const ivy = await rememberContext(env.DB, principal, {
  entities: [{ key: "ivy", kind: "person", name: "Ivy", aliases: ["艾薇"] }],
  facts: [{ subject: "ivy", predicate: "collaborates_on", value: "Amiya APP", confidence: 0.9 }],
  itemLinks: [{ itemId: meeting.id, entity: "ivy", role: "participant", confidence: 1 }],
}, "event-1");
expect(await searchOwnedContext(env.DB, principal.channel, principal.userId, "和 Ivy 开会")).toMatchObject({
  entities: [{ name: "Ivy" }],
});
```

- [ ] **Step 2: Run the focused test and verify missing migration/module failures**

Run: `npx vitest run test/context-memory.test.ts`

Expected: FAIL because `context-memory` tables and module do not exist.

- [ ] **Step 3: Add normalized, user-scoped tables and DB functions**

```sql
CREATE TABLE context_entities (
  id TEXT PRIMARY KEY,
  owner_channel TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_channel, owner_user_id, kind, normalized_name)
);
```

Add aliases, facts with `source_message_id`, `confidence`, validity and status, item links with ownership verified through `items`, and media assets keyed by source message plus attachment index. Every read and mutation must bind `channel + userId`.

- [ ] **Step 4: Run the focused test**

Run: `npx vitest run test/context-memory.test.ts`

Expected: PASS.

### Task 2: Preserve QQ media as structured evidence

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/channels/qq.ts`
- Modify: `src/agent/ingress.ts`
- Modify: `src/agent/types.ts`
- Test: `test/qq.test.ts`
- Test: `test/agent-runtime.test.ts`

- [ ] **Step 1: Add failing tests for extensionless current and quoted image attachments**

```ts
expect(parsed.message.attachments).toEqual([
  expect.objectContaining({ kind: "image", context: "current" }),
]);
expect(parsed.message.text).not.toContain("multimedia.nt.qq.com.cn/download");
```

- [ ] **Step 2: Run the QQ and runtime tests**

Run: `npx vitest run test/qq.test.ts test/agent-runtime.test.ts`

Expected: FAIL because `IncomingMessage` is text-only.

- [ ] **Step 3: Implement the attachment contract and D1 handoff**

```ts
export interface IncomingAttachment {
  kind: "image" | "audio" | "video" | "file" | "unknown";
  context: "current" | "quoted";
  url: string;
  mediaType: string | null;
  filename: string | null;
}
```

QQ must retain ASR text for audio, never flatten image URLs into user instructions, recursively preserve quoted attachments, and emit a descriptive text marker for attachment-only messages. Ingress persists attachments, then appends only owned attachment IDs and kinds to the Agent text.

- [ ] **Step 4: Run the focused tests**

Run: `npx vitest run test/qq.test.ts test/agent-runtime.test.ts`

Expected: PASS.

### Task 3: Build a generic multimodal media reader

**Files:**
- Create: `src/media/fetch.ts`
- Create: `src/media/vision.ts`
- Create: `src/agent/tools/media.ts`
- Modify: `src/config.ts`
- Modify: `src/agent/model.ts`
- Modify: `src/xiaohongshu/vision.ts`
- Modify: `src/agent/composa-agent.ts`
- Modify: `wrangler.jsonc`
- Test: `test/media.test.ts`
- Test: `test/xiaohongshu-vision.test.ts`

- [ ] **Step 1: Write failing tests for public HTTP/HTTPS, redirects, magic-byte detection, bounded reads, ownership, cache reuse, and partial failures**

```ts
const result = await readOwnedMedia(env, principal, { attachmentIds: [asset.id] }, fetcher, analyzer);
expect(result.analysisText).toContain("图片中的组会材料");
expect(fetcher).toHaveBeenCalledOnce();
await readOwnedMedia(env, principal, { attachmentIds: [asset.id] }, fetcher, analyzer);
expect(fetcher).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Run media and Xiaohongshu vision tests**

Run: `npx vitest run test/media.test.ts test/xiaohongshu-vision.test.ts`

Expected: FAIL because the generic media modules do not exist.

- [ ] **Step 3: Implement bounded fetch and shared vision analysis**

```ts
const response = await fetcher(current, {
  redirect: "manual",
  headers: { Accept: "image/*" },
  signal: controller.signal,
});
```

Validate every redirect with `validatePublicHttpUrl`, enforce declared and streamed byte bounds, accept both public HTTP and HTTPS, determine JPEG/PNG/WebP/GIF from bytes when headers are absent, pass bytes or trusted source URLs as AI SDK file parts, and treat all image text as untrusted evidence.

- [ ] **Step 4: Register `media_read` and refactor Xiaohongshu to the shared analyzer**

The tool accepts owned attachment IDs or explicit URLs, excludes source credentials and signed URLs from results, caches attachment analysis, reports per-source failures, and does not lose successful images when another fails.

- [ ] **Step 5: Run the focused tests**

Run: `npx vitest run test/media.test.ts test/xiaohongshu-vision.test.ts test/agent-xiaohongshu-skill.test.ts`

Expected: PASS.

### Task 4: Give the Agent provenance-backed self and social context

**Files:**
- Create: `src/agent/tools/context-memory.ts`
- Modify: `src/agent/composa-agent.ts`
- Modify: `src/agent/prompt.ts`
- Modify: `src/agent/tools/read.ts`
- Modify: `src/agent/tools/calendar.ts`
- Modify: `src/db/calendar.ts`
- Test: `test/agent-context-memory.test.ts`
- Test: `test/agent-calendar-tools.test.ts`
- Test: `test/agent-runtime.test.ts`

- [ ] **Step 1: Write failing tests for search, Agent-selected remembering, explicit forgetting, relevant pre-turn injection, and calendar participants**

```ts
const snapshot = await calendarSnapshot(env, principal, range);
expect(snapshot.entries[0]).toMatchObject({
  participants: [{ name: "Ivy", role: "participant" }],
});
```

- [ ] **Step 2: Run focused Agent tests**

Run: `npx vitest run test/agent-context-memory.test.ts test/agent-calendar-tools.test.ts test/agent-runtime.test.ts`

Expected: FAIL because the context tools and participant enrichment are not registered.

- [ ] **Step 3: Implement `context_search`, `context_remember`, and `context_forget`**

Use open predicates and roles rather than scenario rules. `context_remember` accepts local entity keys, aliases, facts, confidence, validity, optional object entities, and item links in one idempotent action. `context_forget` only retracts IDs returned by search and is described as requiring explicit user intent.

- [ ] **Step 4: Inject only relevant context and enrich item/calendar reads**

Always include active self facts that affect planning; retrieve named people/organizations by aliases from the current message; include source/confidence/validity; return linked participants with `item_get` and calendar entries. Do not infer relationship labels in code.

- [ ] **Step 5: Update the persona**

Require `media_read` for unread attachments, forbid asking the user to reattach an attachment that is already present, explain when to persist named social context, separate one-off event facts from durable traits, and distinguish material/note state from event completion.

- [ ] **Step 6: Run the focused tests**

Run: `npx vitest run test/agent-context-memory.test.ts test/agent-calendar-tools.test.ts test/agent-runtime.test.ts`

Expected: PASS.

### Task 5: Validate the complete Agent loop and documentation

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/qq.md`
- Modify: `docs/xiaohongshu.md`
- Modify: tests as needed for integration coverage

- [ ] **Step 1: Add deterministic loop coverage**

Test `media_read → item_create/update → context_remember → calendar/item verification`, including the example of Ivy/NEUDM/Amiya without assigning an unsupported permanent relationship.

- [ ] **Step 2: Update architecture and channel documentation**

Document media assets as temporary-source evidence, extracted text as durable content, D1 context memory, source/confidence/validity, user isolation, correction/retraction, and the distinction between an event and its notes/materials.

- [ ] **Step 3: Run generated types, type checking, lint, tests, and dry run**

Run:

```bash
npm run types
npm run typecheck
npm run lint
npm test
WRANGLER_LOG_PATH=/tmp/composa-unified-context-dry.log npm run deploy:dry
```

Expected: all commands succeed; no secrets or signed URLs appear in output.

- [ ] **Step 4: Apply the D1 migration and deploy**

Run:

```bash
WRANGLER_LOG_PATH=/tmp/composa-unified-context-migrate.log npm run db:migrate:remote
WRANGLER_LOG_PATH=/tmp/composa-unified-context-deploy.log npm run deploy
```

Expected: migration `0006_context_media.sql` applies once and the Worker deploys to `desk.kinamind.org` without changing configured secrets.

- [ ] **Step 5: Smoke-test production without exposing identity or signed media URLs**

Verify `/health`, send a controlled QQ image, confirm `media_read` receives pixels and the saved item contains visual facts, then mention a person in a meeting and confirm context retrieval/calendar participant enrichment. Query only redacted fields in logs/D1.

- [ ] **Step 6: Commit, push, create a PR, wait for CI, merge, and synchronize main**

Use a `codex/` branch, review the final diff for unrelated changes, and merge only after required checks pass.

## Self-review

- Spec coverage: generic QQ/web media, existing Xiaohongshu reuse, multimodal extraction, durable analysis, self/work/social context, provenance, confidence, validity, correction/retraction, item/calendar integration, and event/material separation are all mapped to tasks.
- Placeholder scan: no implementation step relies on TBD/TODO or an unspecified API.
- Type consistency: incoming `IncomingAttachment` becomes an owned D1 media asset; Agent tools use attachment IDs, not source URLs. Context entity keys are local to one remember action; persisted tools return UUIDs for later search/retraction.
