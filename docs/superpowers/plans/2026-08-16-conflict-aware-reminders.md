# Conflict-Aware Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make natural-language reminder updates reliable and automatically avoid the user's existing Composa schedule.

**Architecture:** Add a first-class `set_reminder` tool action instead of hiding reminder changes inside generic item updates. Build a user-scoped schedule snapshot from pending reminders and open item times, pass it to the model, then deterministically move proposed reminders to the next free 15-minute slot while respecting the target deadline.

**Tech Stack:** TypeScript, Zod, Cloudflare Workers, D1, Workflows, Vitest Workers pool

---

### Task 1: Define the reminder action and schedule model

**Files:**
- Modify: `src/core/types.ts`
- Create: `src/core/schedule.ts`
- Test: `test/schedule.test.ts`

- [x] **Step 1: Write failing schedule tests**

```ts
it("moves a reminder past an occupied event", () => {
  const result = findAvailableReminderTime("2026-08-16T06:30:00.000Z", {
    now: new Date("2026-08-16T05:56:00.000Z"),
    dueAt: "2026-08-16T15:59:59.000Z",
    targetItemId: "target",
    schedule: [{ itemId: "meeting", title: "两点半有事", startAt: "2026-08-16T06:15:00.000Z", endAt: "2026-08-16T07:30:00.000Z", source: "item" }],
    avoidWindows: [],
  });
  expect(result).toMatchObject({ reminderAt: "2026-08-16T07:45:00.000Z", adjusted: true });
});
```

- [x] **Step 2: Run the focused test and confirm it fails**

Run: `npm test -- test/schedule.test.ts`

Expected: FAIL because `findAvailableReminderTime` does not exist.

- [x] **Step 3: Add typed schedule structures and the deterministic resolver**

```ts
export interface ScheduleWindow {
  itemId: string | null;
  title: string;
  startAt: string;
  endAt: string;
  source: "item" | "reminder" | "message";
}

export interface SetReminderAgentAction {
  action: "set_reminder";
  targetItemId: string;
  reminderAt: string | null;
  reminderMode: ReminderMode | null;
  originalTimeExpression?: string | null;
}
```

The resolver treats a reminder as a 15-minute slot, excludes schedule entries owned by the target item, and advances to `conflict.endAt + 15 minutes`, rounded up to a 15-minute boundary. It returns `null` if the next free time exceeds `dueAt`.

- [x] **Step 4: Run the focused test**

Run: `npm test -- test/schedule.test.ts`

Expected: PASS.

### Task 2: Load a user-scoped schedule and expose it to the planner

**Files:**
- Modify: `src/db/items.ts`
- Modify: `src/db/reminders.ts`
- Modify: `src/ai/intent.ts`
- Modify: `src/ai/prompts.ts`
- Test: `test/db.test.ts`
- Test: `test/routing.test.ts`

- [x] **Step 1: Write failing repository and routing tests**

```ts
await expect(listScheduleWindows(env.DB, "qq", "me", now)).resolves.toEqual(expect.arrayContaining([
  expect.objectContaining({ title: "下午会议", source: "item" }),
]));

expect(modelInput).toContain("schedule");
expect(modelInput).toContain("current_reminder_at");
```

- [x] **Step 2: Run the focused tests and confirm they fail**

Run: `npm test -- test/db.test.ts test/routing.test.ts`

Expected: FAIL because schedule context is not loaded or serialized.

- [x] **Step 3: Implement the D1 schedule query and planner schema**

```ts
const setReminderActionSchema = z.object({
  action: z.enum(["set_reminder", "reschedule_item"]),
  target_item_id: z.string().uuid(),
  reminder_at: isoDate.optional().nullable(),
  reminder_mode: z.enum(REMINDER_MODES).optional().nullable(),
  original_time_expression: z.string().max(200).optional().nullable(),
});
```

Serialize active reminders as `current_reminder_at` on recent items and serialize bounded `schedule` windows separately. Add optional top-level `avoid_windows` entries with `start_at`, `end_at`, and `reason`; use these only as data interpreted from the current message.

- [x] **Step 4: Update the system prompt**

Document `set_reminder` as the required action for “later”, “remind me after that”, and changes that affect only reminder delivery. Instruct the model to avoid schedule windows, infer a one-hour avoid window when the user says they are busy at a point in time without a duration, and preserve `due_at` unless the user changes the actual deadline/event.

- [x] **Step 5: Run the focused tests**

Run: `npm test -- test/db.test.ts test/routing.test.ts`

Expected: PASS.

### Task 3: Execute reminder changes with conflict protection

**Files:**
- Modify: `src/core/processor.ts`
- Modify: `src/core/callbacks.ts`
- Test: `test/processor.test.ts`
- Test: `test/callback.test.ts`

- [x] **Step 1: Write the failing regression test**

```ts
it("understands a follow-up reminder change and moves it past a busy time", async () => {
  const now = new Date("2026-08-16T05:56:00.000Z");
  const item = await createItem(env.DB, {
    type: "task", title: "报名 GOAIHZ", content: "今天提交", rawMessage: "今天提交",
    sourceChannel: "telegram", sourceUserId: "42", sourceMessageId: "goaihz",
    dueAt: "2026-08-16T15:59:59.000Z",
  }, now);
  await createReminder(env.DB, {
    itemId: item.id, remindAt: "2026-08-16T06:30:00.000Z", kind: "deferred_action",
    targetChannel: "telegram", targetUserId: "42",
  }, now);
  const incoming: IncomingMessage = {
    channel: "telegram", eventId: "update:move-goaihz", messageId: "301", userId: "42",
    text: "两点半有事，等会晚一点再提醒我", timestamp: now.toISOString(), eventType: "message",
  };
  const workflow = new FakeWorkflow();
  const fetcher: typeof fetch = async () => Response.json({ ok: true, result: { message_id: 302 } });
  await processIncoming({ ...env, REMINDER_WORKFLOW: workflow }, incoming, fetcher, now, providerFor({
    intent: "act",
    actions: [{ action: "set_reminder", target_item_id: item.id, reminder_at: "2026-08-16T06:45:00.000Z", reminder_mode: "deferred_action" }],
    avoid_windows: [{ start_at: "2026-08-16T06:15:00.000Z", end_at: "2026-08-16T07:30:00.000Z", reason: "两点半有事" }],
    confidence: 0.97,
  }));
  const reminders = await env.DB.prepare("SELECT remind_at, status FROM reminders WHERE item_id = ? ORDER BY remind_at").bind(item.id).all();
  expect(reminders.results).toEqual([
    expect.objectContaining({ remind_at: "2026-08-16T06:30:00.000Z", status: "canceled" }),
    expect.objectContaining({ remind_at: "2026-08-16T07:45:00.000Z", status: "pending" }),
  ]);
  expect(workflow.creates.at(-1)?.params?.remindAt).toBe("2026-08-16T07:45:00.000Z");
});
```

- [x] **Step 2: Run the regression test and confirm it fails**

Run: `npm test -- test/processor.test.ts`

Expected: FAIL because `set_reminder` is not executable.

- [x] **Step 3: Implement execution and confirmation**

For `set_reminder`, validate target ownership, load the current user schedule, call `findAvailableReminderTime`, cancel open reminders, and create exactly one Workflow-backed replacement. Confirm the actual selected time and append `（已避开日程冲突）` when code adjusted it.

- [x] **Step 4: Apply the same resolver to create, generic update, callback reschedule, and Later**

All entry points that schedule a reminder must use the same deterministic conflict resolver. Exclude the current item so its deadline and old reminder do not conflict with its replacement.

- [x] **Step 5: Run processor and callback tests**

Run: `npm test -- test/processor.test.ts test/callback.test.ts`

Expected: PASS.

### Task 4: Validate, document, deploy, and repair the failed live update

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/deployment.md`

- [x] **Step 1: Document conflict-aware reminder behavior**

Explain that Composa uses its own D1 schedule as the current source of truth, avoids occupied item windows and reminder collisions, and does not yet read external calendars.

- [x] **Step 2: Run complete validation**

Run: `WRANGLER_LOG_PATH=/tmp/composa-check.log npm run check`

Expected: typecheck, lint, and all tests PASS.

- [x] **Step 3: Run deployment dry-run**

Run: `WRANGLER_LOG_PATH=/tmp/composa-dry.log npm run deploy:dry`

Expected: Worker bundle builds with D1 and Workflow bindings.

- [x] **Step 4: Deploy and inspect health**

Run: `WRANGLER_LOG_PATH=/tmp/composa-deploy.log npm run deploy`

Run: `curl -sS https://composa.kinamind.org/health`

Expected: `"ok":true` with QQ and AI configured.

- [x] **Step 5: Re-run the user's failed QQ wording and verify D1**

Send an equivalent live message, then verify the original item has one new pending reminder after the busy window. If the previous reminder was already delivered before deployment, it remains `triggered`; otherwise replacement cancels it.
