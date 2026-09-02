# Adaptive Context and Replanning Implementation Plan

> **Implementation note:** Work through the regression tests first, then validate the complete Worker before deployment. Steps use checkboxes for tracking.

**Goal:** Make Desk-IX resolve paraphrased references to existing items and revise flexible plans when the user's current reality or priority changes, without adding scenario-specific parsers or fixed reminder times.

**Architecture:** Keep Think as the semantic decision maker. Improve D1 candidate recall with generic Unicode search signals and inject only matching candidates as evidence before each turn; keep the model responsible for deciding whether they are the same object. Make reminder conflicts advisory, label calendar entries by planning semantics, and add one atomic multi-item replanning action so the Agent can move flexible work sessions around fixed events and deadlines instead of treating the old plan as immutable.

**Tech Stack:** TypeScript, Cloudflare Think/Agents SDK, Workers, D1, Workflows, Zod, Vitest Workers pool.

---

### Task 1: Recall paraphrased Chinese item references

**Files:**
- Modify: `src/db/items.ts`
- Modify: `src/agent/tools/read.ts`
- Test: `test/agent-tools-read.test.ts`

- [x] **Step 1: Write the failing retrieval test**

Seed an older item titled `给由雪伟发送更新后的简历（待处理）`, add more than the recent-candidate window of unrelated records, then search with `等会要给由雪伟发简历`. Assert that the old item is first and the result is marked `fuzzy`, not `recent_fallback`.

```ts
const result = await memorySearch(env, principal, "等会要给由雪伟发简历", 8);
expect(result.matchMode).toBe("fuzzy");
expect(result.items[0]?.id).toBe(existing.id);
```

- [x] **Step 2: Run the test and verify the old search fails**

Run: `npm test -- --run test/agent-tools-read.test.ts`

Expected: FAIL because the entire Chinese sentence is treated as one unmatched term and retrieval falls back to recent items.

- [x] **Step 3: Add generic Unicode search signals**

Replace whole-string-only matching with a bounded set of generic signals: normalized full text, whitespace-delimited Latin tokens, and overlapping CJK character bigrams. Rank matches across title and body in SQL, giving title evidence more weight, and determine `lexical` versus `fuzzy` from whether the normalized query itself is present. Do not remove words such as “简历”, “meeting”, “等会”, or introduce any domain-specific synonym table.

```ts
export interface NaturalItemSearchResult {
  items: Item[];
  matchMode: "lexical" | "fuzzy" | "recent_fallback";
}
```

- [x] **Step 4: Expose fuzzy evidence without claiming identity**

Update `memory_search` so fuzzy candidates are described as evidence requiring the Agent's semantic confirmation. `recent_fallback` remains context-only and must not authorize mutation by itself.

- [x] **Step 5: Run the retrieval tests**

Run: `npm test -- --run test/agent-tools-read.test.ts`

Expected: PASS, including the older exact lexical match and unmatched recent fallback cases.

### Task 2: Put relevant domain memory in every turn's context

**Files:**
- Create: `src/agent/turn-context.ts`
- Modify: `src/agent/composa-agent.ts`
- Modify: `src/agent/prompt.ts`
- Test: `test/agent-turn-context.test.ts`

- [x] **Step 1: Write the failing context test**

Seed the same old resume item plus many newer unrelated items, call the new context loader with `简历要更新一下，meeting结束后优先做`, and assert that the context contains the existing item ID/title, marks it as a candidate rather than a resolved identity, and omits unrelated recent records.

- [x] **Step 2: Run the test and verify the context loader does not exist**

Run: `npm test -- --run test/agent-turn-context.test.ts`

Expected: FAIL on the missing module/export.

- [x] **Step 3: Implement a compact evidence context**

Create `loadTurnItemContext(env, principal, text)` around `searchOwnedItemsNatural`. Return an empty string for `recent_fallback`; otherwise serialize a small candidate list containing `id`, `title`, `type`, `status`, `priority`, `dueAt`, `updatedAt`, and a bounded snippet. State explicitly that candidates are retrieval evidence and that the model must combine them with the conversation and quoted message before updating anything.

- [x] **Step 4: Inject it in `beforeTurn`**

Load item candidates alongside the existing profile and relationship context, then append them to `instructions`. Keep D1 access scoped by the authenticated principal and keep the data plain/serializable across the Think turn boundary.

- [x] **Step 5: Strengthen the semantic contract**

Update the persona to say that an apparently simple new task may be a status/update/reminder for an existing item; compare turn candidates with the actual conversation before calling `item_create`. The model remains responsible for the identity judgment.

- [x] **Step 6: Run context and runtime tests**

Run: `npm test -- --run test/agent-turn-context.test.ts test/agent-runtime.test.ts`

Expected: PASS.

### Task 3: Treat reminders as attention signals, not occupied work

**Files:**
- Modify: `src/agent/tools/write.ts`
- Modify: `src/agent/skills/calendar-plan/SKILL.md`
- Modify: `src/agent/skills/calendar-manage/SKILL.md`
- Test: `test/agent-tools-write.test.ts`
- Test: `test/agent-runtime.test.ts`

- [x] **Step 1: Replace the hard-conflict test**

Change the reminder collision test to assert that a future reminder inside an existing work session is scheduled and returns the overlapping entries as advisory `scheduleConflicts`. Remove expectations that `agent_selected`, `user_exact`, or `allowConflict` control whether the notification is permitted.

```ts
expect(result).toMatchObject({
  scheduled: true,
  scheduleConflicts: [expect.objectContaining({ source: "work_session" })],
});
```

- [x] **Step 2: Run the test and verify the current action rejects it**

Run: `npm test -- --run test/agent-tools-write.test.ts test/agent-runtime.test.ts`

Expected: FAIL because the current validator refuses all Agent-selected reminder collisions.

- [x] **Step 3: Simplify the reminder schema and behavior**

Remove `timeSelection` and `allowConflict` from `reminderInputSchema`. Keep ownership and future-time checks. Schedule the reminder regardless of occupied windows, cancel the replaced reminder idempotently, and return any overlaps as decision feedback rather than a permission failure.

- [x] **Step 4: Update calendar skill semantics**

Tell the Agent that reminders do not consume time. It should normally avoid disruptive notification points, but may choose a transition cue or urgent interruption when that better preserves the user's wording and current priority. Missing event-end information is a judgment call: ask only when precision materially matters; otherwise choose a reasonable near-term check-in and state the assumption.

- [x] **Step 5: Run reminder and runtime tests**

Run: `npm test -- --run test/agent-tools-write.test.ts test/agent-runtime.test.ts`

Expected: PASS with a smaller OpenAI-compatible action schema.

### Task 4: Add atomic multi-item replanning

**Files:**
- Modify: `src/db/work-sessions.ts`
- Modify: `src/agent/tools/write.ts`
- Modify: `src/agent/composa-agent.ts`
- Modify: `src/agent/skills/calendar-plan/SKILL.md`
- Modify: `src/agent/skills/calendar-manage/SKILL.md`
- Test: `test/agent-tools-write.test.ts`
- Test: `test/agent-runtime.test.ts`

- [x] **Step 1: Write the failing adaptive-replan test**

Create two flexible tasks with adjacent work sessions and one fixed meeting. Replan both tasks in one call so the newly prioritized task moves ahead of the old task, while the meeting remains untouched. Assert that old work sessions are canceled and the new plan is saved without an intermediate overlap failure.

- [x] **Step 2: Run the test and verify no atomic action exists**

Run: `npm test -- --run test/agent-tools-write.test.ts`

Expected: FAIL on the missing `replanOwnedWorkSessions` export.

- [x] **Step 3: Add an atomic D1 replacement**

Add `replaceWorkSessionPlans(db, plans, rationale, now)` that cancels planned sessions for every changed item and inserts every replacement in one awaited `db.batch`. Return the inserted sessions grouped by item ID. Do not change events, deadlines, reminders, or unrelated work sessions.

- [x] **Step 4: Add the `calendar_replan` action**

Accept an array of item/session changes and a model-written rationale. Validate ownership, valid future intervals, no overlap among the proposed sessions, and no collision with unaffected fixed events or work sessions. Exclude all changed item IDs when checking old work sessions so cross-item moves are evaluated as one plan. There is no scenario enum or fixed rescheduling rule.

- [x] **Step 5: Teach the skills to revise rather than append**

When current reality invalidates a planned work session or the user changes priority, the Agent must reassess the affected window. Fixed events and deadlines are constraints; work sessions are editable commitments. Use `calendar_replan` for coupled changes instead of preserving stale work or creating overlapping plans.

- [x] **Step 6: Run adaptive replanning tests**

Run: `npm test -- --run test/agent-tools-write.test.ts test/agent-runtime.test.ts test/agent-calendar-tools.test.ts`

Expected: PASS.

### Task 5: Verify the real failure shape and audit boundaries

**Files:**
- Modify: `docs/audits/2026-08-17-runtime-boundaries.md`
- Modify: `docs/architecture.md`
- Test: `test/agent-turn-context.test.ts`
- Test: `test/agent-tools-write.test.ts`

- [x] **Step 1: Add one end-to-end-shaped regression fixture**

Use the four real utterances as test data, but assert only generic capabilities: the old resume item is in turn context, a reminder may be placed at a useful transition despite a flexible work block, and a coupled replan can move the resume work ahead of the displaced plan. Do not assert a fixed time such as 16:00 or a fixed meeting duration.

- [x] **Step 2: Audit remaining product-policy boundaries**

Search runtime code and tool schemas for fixed step counts, fixed output caps, fixed reminder windows, keyword intent branches, conflict overrides, item-count action limits, or category-based schedules. Keep only platform/resource safety, ownership, idempotency, valid time ordering, and physical no-overlap constraints; document every retained boundary and its reason.

- [x] **Step 3: Run the full validation suite**

Run: `npm run check`

Expected: types generated, TypeScript clean, lint clean, all Workers-runtime tests pass.

- [x] **Step 4: Validate the Worker bundle and startup**

Run: `npm run deploy:dry`

Run: `WRANGLER_LOG_PATH=/tmp/desk-ix-startup.log npx wrangler check startup`

Expected: dry deployment succeeds and startup stays within the platform limit.

### Task 6: Deploy for user verification

**Files:**
- No additional source files unless deployment exposes a verified issue.

- [ ] **Step 1: Commit the tested change**

Run: `git add src test docs && git commit -m "feat: make context and replanning adaptive"`

Expected: one focused commit on `codex/adaptive-context-replanning`.

- [ ] **Step 2: Deploy the branch build**

Run: `npm run deploy`

Expected: Worker deploy succeeds with unchanged bindings and migrations.

- [ ] **Step 3: Verify health without replaying the user's message**

Run: `curl -sS -o /dev/null -w '%{http_code}' https://desk.kinamind.org/health`

Expected: `200`.

- [ ] **Step 4: Push and open a pull request**

Push the branch, create a PR describing the three observed failures and the generic repair, wait for CI, and leave merge gated on the user's live conversational verification.

---

## Self-review

- Spec coverage: paraphrased context retrieval, model-owned semantic identity, reminder flexibility, live priority changes, coupled replanning, and the exact observed conversation shape are covered.
- No scenario-specific rule maps “简历”, “meeting”, “等会”, or “尽早” to a fixed action or time.
- Retained hard boundaries are limited to authorization, idempotency, future/ordered timestamps, and physically non-overlapping work sessions.
- Function and schema names are consistent across tasks: `searchOwnedItemsNatural`, `loadTurnItemContext`, `reminderInputSchema`, `replaceWorkSessionPlans`, `calendar_replan`, and `replanOwnedWorkSessions`.
