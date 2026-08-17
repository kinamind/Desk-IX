# Agent Temporal Judgment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Desk-IX choose useful times inside broad phrases such as “下午” from the user's actual context, and let the Agent intelligently decide what to do after a scheduled event instead of treating every record like a passive todo.

**Architecture:** Keep temporal judgment in the model and deterministic safety in tools. The Agent must inspect the user's schedule, profile, deadline, urgency, estimated duration, and reminder density before choosing a concrete time. A new Agent-owned lifecycle-follow-up action schedules a durable wake-up at a model-chosen time; when it fires, Desk-IX reloads the exact item and decides in context whether to complete it, ask the user, create a follow-on item, or defer review. Code does not classify “meeting” or any other category as automatically complete.

**Tech Stack:** TypeScript, Zod, Cloudflare Workers, Cloudflare Think / Agents SDK schedules, D1, Workflows, Vitest Workers pool

---

### Task 1: Make broad-time selection explicit and conflict-safe

**Files:**
- Modify: `src/agent/prompt.ts`
- Modify: `src/agent/tools/read.ts`
- Modify: `src/agent/tools/write.ts`
- Test: `test/agent-runtime.test.ts`
- Test: `test/agent-tools-write.test.ts`

- [x] **Step 1: Add failing prompt and schema tests**

Assert that the persona treats “下午、晚上、晚点” as windows rather than fixed clocks, requires `schedule_list`, considers chronotype and reminder density, and does not reuse 14:00 by default. Add an input-schema assertion for a `timeSelection` field with `agent_selected` and `user_exact` values.

- [x] **Step 2: Add a scheduling-intent field to reminder management**

Extend `reminderInputSchema` with:

```ts
timeSelection: z.enum(["agent_selected", "user_exact"]).default("agent_selected")
```

`user_exact` means the user actually supplied a specific clock time. Broad phrases such as “下午” and “晚点” remain `agent_selected`, even after the Agent chooses a concrete timestamp.

- [x] **Step 3: Enforce only the safety boundary in code**

If the proposed time conflicts with an existing item or reminder window, allow an override only when both `timeSelection === "user_exact"` and `allowConflict === true`. This prevents the Agent from forcing two broad-time reminders into the same slot while preserving a user's explicit request such as “就定两点”。

- [x] **Step 4: Strengthen the Agent's temporal decision contract**

Update the persona and tool descriptions so the Agent:

- interprets broad periods as ranges rather than aliases for a single time;
- calls `schedule_list` before choosing;
- uses local time, profile/chronotype, existing commitments, reminder spacing, due time, urgency, and estimated duration;
- chooses a useful concrete time within the range and explains it briefly;
- tries another candidate if the tool reports a conflict;
- never invents an exact user instruction merely because it converted a broad phrase to a timestamp.

- [x] **Step 5: Run focused tests**

Run: `npm test -- test/agent-runtime.test.ts test/agent-tools-write.test.ts`

Expected: PASS, including a regression where `allowConflict: true` cannot override a collision for `agent_selected` time.

### Task 2: Add an Agent-owned lifecycle follow-up action

**Files:**
- Create: `src/agent/followups.ts`
- Modify: `src/agent/tools/write.ts`
- Modify: `src/agent/composa-agent.ts`
- Test: `test/agent-followups.test.ts`
- Test: `test/agent-runtime.test.ts`

- [x] **Step 1: Define a narrow, model-operated follow-up contract**

Add `lifecycleFollowupInputSchema`:

```ts
z.object({
  operation: z.enum(["set", "cancel"]),
  itemId: z.string().uuid(),
  reviewAt: z.string().datetime().optional(),
  reason: z.string().trim().min(1).max(1_000).optional(),
})
```

Require `reviewAt` and `reason` for `set`. The reason records the Agent's item-specific uncertainty and review intention; it is not a category label or completion rule.

- [x] **Step 2: Create the durable schedule controller**

Create helpers that identify follow-up schedules by callback plus item ID, cancel obsolete schedules, and build a safe review payload containing only the owned item ID, channel, user ID, review time, and reason. The Composa Agent implements the controller using Agents SDK `listSchedules`, `cancelSchedule`, and `schedule(..., { idempotent: true })`.

- [x] **Step 3: Expose `lifecycle_followup_manage` to the model**

Pass the controller into `createWriteActions`. The action first verifies item ownership, then schedules or cancels the item's review. Its description states that the Agent—not code—must decide whether a follow-up is useful and when it should run.

- [x] **Step 4: Cancel stale follow-ups on terminal transitions**

When the user or Agent completes, abandons, or archives an item, cancel its pending lifecycle follow-up. Restoring an item does not create one automatically; the Agent may choose to schedule a new review after considering current context.

- [x] **Step 5: Test schedule matching and ownership boundaries**

Verify that only schedules for the exact owned item are replaced/canceled and that terminal transitions call the cancellation controller. Run:

`npm test -- test/agent-followups.test.ts test/agent-tools-write.test.ts test/agent-runtime.test.ts`

Expected: PASS.

### Task 3: Wake Desk-IX for a genuine post-event judgment turn

**Files:**
- Modify: `src/agent/followups.ts`
- Modify: `src/agent/composa-agent.ts`
- Modify: `src/agent/types.ts`
- Test: `test/agent-followups.test.ts`

- [x] **Step 1: Build a structured internal review message**

The scheduled callback reloads the exact owned item. If it is already terminal, it exits quietly. Otherwise it creates an auditable internal event whose text clearly says:

- this is a system-initiated lifecycle review, not a user claim;
- inspect the exact item and relevant memory/schedule;
- high confidence may justify completing and notifying with an easy correction path;
- uncertainty must result in a concise question or a later Agent-chosen review, without changing status;
- an ended event may be completed while a distinct unresolved outcome becomes a follow-on item;
- no category-specific rule determines the result.

- [x] **Step 2: Reuse the normal durable Agent and delivery path**

Submit the internal event through the existing `receive`/Think turn path with a stable event ID derived from the Agent schedule ID. Insert the event in the D1 message ledger first so status, retries, and outbound delivery remain observable and idempotent.

- [x] **Step 3: Preserve authenticated user scope**

Carry the original channel/user pair in the signed-in Agent's private schedule payload, re-check item ownership before submission, and grant the normal scoped item/reminder/profile/follow-up permissions. Do not expose IDs or secrets in user-facing output.

- [x] **Step 4: Test review prompt behavior**

Test the prompt builder with a meeting-like item and an ambiguous task-like item. Both prompts must describe choices rather than predetermine an outcome; neither may contain a rule such as “meeting implies complete”.

- [x] **Step 5: Run focused tests and typecheck**

Run: `npm test -- test/agent-followups.test.ts test/agent-runtime.test.ts`

Run: `npm run typecheck`

Expected: PASS.

### Task 4: Teach the Agent when to schedule and how to reason at review time

**Files:**
- Modify: `src/agent/prompt.ts`
- Modify: `src/agent/composa-agent.ts`
- Modify: `docs/architecture.md`
- Test: `test/agent-runtime.test.ts`

- [x] **Step 1: Add lifecycle judgment guidance to the persona**

When Desk-IX creates or updates a time-bound item, it should decide whether a post-event review is valuable and call `lifecycle_followup_manage` with an item-specific review time and reason. The guidance must distinguish occurrence certainty from outcome certainty and avoid category tables or keyword rules.

- [x] **Step 2: Add a scheduled-review turn instruction**

Detect the internal review event in `beforeTurn` and append a focused instruction: use tools to load the item and context, then decide among completion, question, follow-on work, or rescheduling. The model must disclose any automatic status change and invite correction.

- [x] **Step 3: Document the responsibility split**

Update architecture documentation: the model owns time and lifecycle judgment; D1 ownership checks, conflict blocking, durable wake-ups, idempotency, and delivery are deterministic safeguards.

- [x] **Step 4: Run prompt regressions**

Run: `npm test -- test/agent-runtime.test.ts test/agent-followups.test.ts`

Expected: PASS.

### Task 5: Validate, deploy, and verify real behavior

**Files:**
- Modify only if validation exposes a defect in the files above.

- [x] **Step 1: Run the complete local gate**

Run: `WRANGLER_LOG_PATH=/tmp/desk-ix-temporal-check.log npm run check`

Expected: generated types, TypeScript, lint, and all tests PASS.

- [x] **Step 2: Build the production bundle without deploying**

Run: `WRANGLER_LOG_PATH=/tmp/desk-ix-temporal-dry.log npm run deploy:dry`

Expected: Worker, Durable Object, D1, and Workflow bindings build successfully.

- [x] **Step 3: Deploy and run health smoke checks**

Run: `WRANGLER_LOG_PATH=/tmp/desk-ix-temporal-deploy.log npm run deploy`

Run: `curl -sS https://desk.kinamind.org/health`

Expected: HTTP 200 and configured runtime status. Do not change the currently working QQ callback route during this feature deployment.

- [x] **Step 4: Persist the user's explicit planning preference**

Update the existing user profile preference to record that broad periods are selected dynamically from schedule, chronotype, urgency, and reminder density rather than fixed at 14:00. This preference is user-provided and non-sensitive.

- [x] **Step 5: Exercise the production behavior and inspect resulting state**

Verify the real collision by moving the two existing afternoon reminders through the deployed Workflow-backed path to distinct Agent-selected times, and confirm the old rows are canceled and both replacements are pending with Workflow bindings. Validate Agent-owned lifecycle review scheduling, ownership, prompt construction, and audit submission in the Worker test runtime rather than injecting a fake user conversation into QQ. Do not expose App ID, user ID, or secrets in logs or the report.

- [ ] **Step 6: Publish through the normal GitHub flow**

Commit only the intended files on the `codex/agent-temporal-judgment` branch, push, open a PR, wait for CI, merge, and synchronize local `main`.

Expected: merged change, green CI, deployed Worker, and a concise report of any existing reminders that still require rescheduling.

---

**Execution note:** This plan will be implemented inline in the current task because no separate subagent execution was requested.
