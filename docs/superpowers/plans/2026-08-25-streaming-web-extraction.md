# Streaming Web Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Desk-IX read ordinary public articles whose HTML contains large script/style payloads without using the raw response size as the visible-content boundary.

**Architecture:** Keep SSRF validation, manual redirect validation, content-type checks, and the request timeout in the fetch layer. For HTML, pass the response stream through Cloudflare `HTMLRewriter`, remove non-content elements, and collect metadata, visible text, and image candidates without buffering the raw document. Apply the existing safety budget only to extracted visible text; plain-text responses continue to use the same visible-text budget.

**Tech Stack:** TypeScript, Cloudflare Workers `HTMLRewriter` and Web Streams, Workers Vitest, Wrangler.

---

### Task 1: Specify the semantic boundary with tests

**Files:**
- Modify: `test/url.test.ts`

- [x] **Step 1: Replace the raw-size regression with a streaming-noise regression**

Build a response containing more than the configured visible-text budget in `<script>` and `<style>`, followed by a normal article. Assert that the article is complete and `truncated` is false because discarded markup does not consume the visible-text budget.

- [x] **Step 2: Add a genuine visible-text truncation test**

Return a plain-text or content-only HTML response whose visible text exceeds the configured budget. Assert that `truncated` is true and the returned text is bounded, preserving the resource guard without tying it to irrelevant markup.

- [x] **Step 3: Run the focused test and confirm the old implementation fails**

Run: `npx vitest run test/url.test.ts`

Expected: the large script/style preamble consumes the old raw byte budget and prevents the article assertion from passing.

### Task 2: Stream and extract HTML content

**Files:**
- Modify: `src/url/fetch.ts`
- Modify: `src/url/extract.ts`
- Modify: `src/url/reader.ts`
- Test: `test/url.test.ts`

- [x] **Step 1: Add a streaming HTML extractor**

Implement an async extractor that removes `script`, `style`, `noscript`, `svg`, `iframe`, and `template` elements in one `HTMLRewriter` pass, then collects title, description, canonical URL, visible body text, and image attributes in a second streaming pass. Drain the transformed response stream without calling `response.text()` or buffering the raw HTML.

- [x] **Step 2: Keep the fetch timeout active through stream consumption**

Call the streaming extractor inside `fetchPage` before the request's `AbortController` timeout is cleared. Continue to validate every redirect and reject unsupported content types before parsing.

- [x] **Step 3: Treat the configured budget as extracted text**

Use the budget while appending visible text chunks. Do not count tags, scripts, styles, comments, or image markup. Set `truncated` only when actual visible text cannot fit.

- [x] **Step 4: Run the focused URL and Agent read tests**

Run: `npx vitest run test/url.test.ts test/agent-tools-read.test.ts`

Expected: all focused tests pass, including redirect/SSRF and multi-URL behavior.

### Task 3: Make configuration semantics explicit

**Files:**
- Modify: `src/config.ts`
- Modify: `wrangler.jsonc`
- Modify: `wrangler.test.jsonc`
- Modify: `worker-configuration.d.ts`
- Modify: `README.md`
- Modify: `docs/audits/2026-08-17-runtime-boundaries.md`

- [x] **Step 1: Rename the variable to visible text**

Introduce `URL_MAX_TEXT_BYTES` with a default of `524288` and remove `URL_MAX_BYTES` from active Wrangler configuration. This deployment owns both ends of the configuration change, so do not preserve a misleading legacy variable in runtime code.

- [x] **Step 2: Regenerate Worker types**

Run: `npm run types`

Expected: `worker-configuration.d.ts` contains `URL_MAX_TEXT_BYTES` and no configured `URL_MAX_BYTES` literal.

- [x] **Step 3: Document the boundary accurately**

State that the value guards extracted visible text sent into the Agent context; it is not a response-download cap and does not let script/style payloads crowd out article content.

### Task 4: Validate, ship, and live-test

**Files:**
- No schema migration.

- [x] **Step 1: Run full validation**

Run: `npm run check`

Expected: type generation, typecheck, lint, and every Worker test pass.

- [x] **Step 2: Review Worker-specific risks**

Confirm the implementation streams unknown HTML, awaits every stream operation, keeps request state local, preserves SSRF/timeout/content-type checks, adds no secret or cookie, and keeps observability/config bindings valid.

- [ ] **Step 3: Dry-run, commit, and deploy**

Run: `npm run deploy:dry`, commit on `codex/attention-aware-frontstage`, push to PR 17, then run `npm run deploy`.

Expected: the existing D1, Durable Object, Workflow, routes, and secrets remain unchanged; only Worker code and the non-secret visible-text configuration change.

- [ ] **Step 4: Verify production and the original article**

Check `https://desk.kinamind.org/health`, resend the original public WeChat URL through QQ, and inspect the latest message record. The response must reflect the article title/content rather than the WeChat environment-verification page.
