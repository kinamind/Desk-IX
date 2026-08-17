# Unbounded Agent Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Desk-IX finish model-directed work without a step-count cutoff, reliably synthesize a reply after side effects, and persist conflict-aware work sessions chosen by the Agent rather than by fixed scheduling rules.

**Architecture:** Keep Think as the durable conversation loop and set its unavoidable numeric step guard to `Number.POSITIVE_INFINITY`, leaving natural model completion as the normal stop condition. Add a text-only recovery synthesis when a completed turn contains no visible answer, and add D1-backed work sessions as first-class schedule windows whose dates and segmentation are selected by the model. Remove product heuristics that silently block useful behavior, while retaining ownership, idempotency, future-time validity, SSRF protection, platform payload limits, and failure recovery.

**Tech Stack:** TypeScript, Cloudflare Workers, Cloudflare Think/Agents SDK, D1 SQLite migrations, Vercel AI SDK, Zod, Vitest, Wrangler.

---

### Task 1: Remove normal-turn inference cutoffs and recover empty answers

**Files:**
- Modify: `src/agent/composa-agent.ts`
- Create: `src/agent/finalize.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/config.ts`
- Modify: `wrangler.jsonc`
- Test: `test/agent-runtime.test.ts`
- Test: `test/agent-finalize.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Assert that `getRuntimeProfile()` reports `stepLimit: null`, that the stream-stall watchdog is disabled, and that `AI_DAILY_REQUEST_LIMIT=0` means unlimited rather than zero allowed calls. Add a finalizer test whose completed assistant message has tool results but no text and whose text-only model returns a concise confirmation.

- [ ] **Step 2: Run the focused tests and verify the old six-step profile and empty fallback fail**

Run: `npm test -- test/agent-runtime.test.ts test/agent-finalize.test.ts test/ai.test.ts`

Expected: FAIL because the runtime still reports `maxSteps: 6`, enforces the daily cap, and has no intelligent empty-turn synthesis.

- [ ] **Step 3: Implement natural completion and independent synthesis**

Use the following runtime shape:

```ts
override maxSteps = Number.POSITIVE_INFINITY;
override chatStreamStallTimeoutMs = 0;

return {
  activeTools: ACTIVE_TOOLS,
  instructions,
  maxRetries: 1,
  timeout: {
    stepMs: config.aiTimeoutMs,
    toolMs: Math.max(config.urlFetchTimeoutMs + 2_000, 15_000),
  },
};
```

When `onChatResponse` receives a completed message with no text, call a new text-only finalizer with the authenticated principal, original message, and sanitized tool-result parts. The finalizer uses the same configured model without tools, records usage through `OpenAICompatibleProvider`, and cannot repeat side effects. If that second model request fails, return an honest delivery-recovery message instead of claiming that no operation occurred.

Interpret a daily request limit of `0` as disabled, make `0` the default, and remove the production value `100`.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- test/agent-runtime.test.ts test/agent-finalize.test.ts test/ai.test.ts`

Expected: PASS.

### Task 2: Add Agent-selected work sessions

**Files:**
- Create: `migrations/0005_work_sessions.sql`
- Create: `src/db/work-sessions.ts`
- Modify: `src/core/types.ts`
- Modify: `src/db/schedule.ts`
- Modify: `src/db/items.ts`
- Modify: `src/agent/tools/read.ts`
- Modify: `src/agent/tools/write.ts`
- Modify: `src/agent/composa-agent.ts`
- Modify: `src/agent/prompt.ts`
- Test: `test/agent-tools-write.test.ts`
- Test: `test/agent-tools-read.test.ts`
- Test: `test/db.test.ts`

- [ ] **Step 1: Write failing persistence and tool tests**

Cover replacement of several sessions for one owned item, rejection of cross-user item IDs, rejection of internally overlapping sessions, detection of conflicts with another work session or scheduled event, explicit user-authorized overlap, inclusion in `schedule_list` and `item_get`, and cancellation when an item becomes terminal.

- [ ] **Step 2: Run the focused tests and verify the feature is absent**

Run: `npm test -- test/agent-tools-write.test.ts test/agent-tools-read.test.ts test/db.test.ts`

Expected: FAIL because `work_sessions` and `work_session_manage` do not exist.

- [ ] **Step 3: Add the D1 model and ownership-scoped operations**

Create a table with `id`, `item_id`, `start_at`, `end_at`, `label`, `rationale`, `status`, and timestamps, plus time/status and item/status indexes. Implement `replaceWorkSessions`, `listOwnedWorkSessions`, and `cancelOpenWorkSessions`; use `db.batch()` for atomic replacement.

- [ ] **Step 4: Add the Agent action and schedule integration**

Expose this input contract:

```ts
const workSessionInputSchema = z.object({
  operation: z.enum(["replace", "cancel"]),
  itemId: z.string().uuid(),
  sessions: z.array(z.object({
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    label: z.string().trim().min(1).max(300).optional(),
  })).optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
  timeSelection: z.enum(["agent_selected", "user_exact"]).default("agent_selected"),
  allowConflict: z.boolean().default(false),
});
```

Validate only structural facts in code: owned item, valid/future intervals, no overlap within the proposal, and no collision with actual occupied windows unless the user explicitly requested and accepted that exact time. Do not choose durations, dates, number of sessions, or task categories in code. Include work sessions in `schedule_list` and `item_get`, and instruct the model to split substantial work according to the real schedule and user preferences.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- test/agent-tools-write.test.ts test/agent-tools-read.test.ts test/db.test.ts`

Expected: PASS.

### Task 3: Remove product heuristics that interfere with normal use

**Files:**
- Modify: `src/agent/tools/write.ts`
- Modify: `src/db/schedule.ts`
- Modify: `src/agent/tools/read.ts`
- Modify: `src/db/items.ts`
- Modify: `src/url/reader.ts`
- Modify: `src/core/daily-plan.ts`
- Modify: `src/agent/prompt.ts`
- Test: `test/agent-tools-write.test.ts`
- Test: `test/agent-tools-read.test.ts`
- Test: `test/daily-plan.test.ts`

- [ ] **Step 1: Write regression tests for harmful boundaries**

Cover a model-chosen reminder fewer than 15 minutes away, a reminder immediately before but not inside an occupied interval, retrieval of an older lexical match beyond the most recent 30 items, reading more than three explicitly supplied public links, and a daily-plan response longer than 2,200 characters.

- [ ] **Step 2: Run the focused tests and verify current heuristic failures**

Run: `npm test -- test/agent-tools-write.test.ts test/agent-tools-read.test.ts test/daily-plan.test.ts`

Expected: FAIL on the old immediate-reminder gate, retrieval window, link cap, and output slicing.

- [ ] **Step 3: Remove the heuristic behavior**

Delete `explicitImmediate` and the fixed 15-minute minimum; retain only `remindAt > now` and actual occupied-window checks. Treat reminders as notification points rather than 15-minute appointments. Search all owned items for lexical matches before falling back to recent context, return full stored item/page text up to the existing ingress/fetch safety size, allow the Agent to request all reasonable links in the message, expand schedule lookahead beyond 30 days, and stop slicing completed daily-plan text or fallback sections.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- test/agent-tools-write.test.ts test/agent-tools-read.test.ts test/daily-plan.test.ts`

Expected: PASS.

### Task 4: Audit, verify, deploy, and repair the affected plan

**Files:**
- Create: `docs/audits/2026-08-17-runtime-boundaries.md`
- Modify: `README.md`
- Modify: `docs/deployment.md`

- [ ] **Step 1: Classify every remaining bound**

Search source and configuration for numeric caps, slices, query limits, timeouts, retries, horizons, token controls, and payload maxima. Record each as platform/security, failure-recovery, context-management, or product behavior; remove or redesign any product bound that silently changes a normal request. Explicitly retain QQ platform button limits, input/schema integrity bounds, SSRF/download-size controls, ownership checks, idempotency, and recovery for real failures.

- [ ] **Step 2: Run the complete verification suite**

Run: `npm run types && npm run typecheck && npm run lint && npm test && npm run deploy:dry`

Expected: generated types succeed, TypeScript and lint report no errors, all tests pass, and Wrangler dry-run builds the Worker.

- [ ] **Step 3: Apply the remote migration and deploy**

Run: `npm run db:migrate:remote` and `npm run deploy`.

Expected: migration `0005_work_sessions.sql` applies once and `https://desk.kinamind.org/health` returns HTTP 200.

- [ ] **Step 4: Repair the two ResWork items using the new schedule representation**

Inspect the user's current schedule and the two item IDs in remote D1, remove the misleading shared `start_after` interpretation, insert non-overlapping sessions that fit before their respective deadlines and the user's late chronotype, and keep the existing reminder only if it remains useful relative to the first session. Verify the resulting schedule query rather than assuming the write succeeded.

- [ ] **Step 5: Commit, push, create a PR, wait for CI, merge, and sync main**

Use a scoped commit, push `codex/unbounded-agent-planning`, create the PR, wait for checks, merge, and fast-forward local `main` without touching unrelated user changes.
