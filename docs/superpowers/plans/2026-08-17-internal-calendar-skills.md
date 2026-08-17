# Internal Calendar Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Desk-IX a first-class, internal calendar skill suite for reading calendars, finding availability, planning work, changing schedules, and reviewing outcomes without depending on an external calendar provider.

**Architecture:** Use Cloudflare Think's on-demand Agent Skills through `getSkills()` and a Wrangler-bundled Markdown manifest. Keep deterministic calendar facts in a user-scoped D1 query layer and pure interval algorithms, while leaving prioritization, session count, and time choice to the model. Existing item, reminder, work-session, and lifecycle actions remain the mutation primitives so writes keep their ownership and idempotency guarantees.

**Tech Stack:** TypeScript, Cloudflare Think/Agents SDK Agent Skills, Workers Text modules, D1, Zod, Vitest Workers pool.

---

### Task 1: Define the internal calendar model and interval engine

**Files:**
- Create: `src/core/calendar.ts`
- Create: `src/db/calendar.ts`
- Modify: `src/core/types.ts`
- Test: `test/calendar.test.ts`

- [ ] **Step 1: Write failing calendar snapshot tests**

```ts
const snapshot = await loadCalendarSnapshot(db, "qq", "me", from, to);
expect(snapshot.entries).toEqual(expect.arrayContaining([
  expect.objectContaining({ kind: "deadline", blocksTime: false }),
  expect.objectContaining({ kind: "event", blocksTime: true }),
  expect.objectContaining({ kind: "work_session", blocksTime: true }),
  expect.objectContaining({ kind: "reminder", blocksTime: false }),
]));
expect(snapshot.entries.some((entry) => entry.title === "other user")).toBe(false);
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `npx vitest run test/calendar.test.ts`

Expected: FAIL because `src/db/calendar.ts` and `src/core/calendar.ts` do not exist.

- [ ] **Step 3: Add canonical calendar types and scoped D1 reads**

```ts
export type CalendarEntryKind = "event" | "deadline" | "work_session" | "reminder";
export interface CalendarEntry {
  id: string;
  itemId: string;
  kind: CalendarEntryKind;
  title: string;
  startAt: string;
  endAt: string | null;
  blocksTime: boolean;
  temporalRole: TemporalRole | null;
}
```

Query open items, planned work sessions, and pending reminders only for the authenticated channel/user and requested half-open interval. Treat deadline and reminder entries as visible but non-blocking.

- [ ] **Step 4: Add pure conflict and availability calculations**

```ts
export function findCalendarAvailability(
  entries: CalendarEntry[],
  from: string,
  to: string,
  minimumMinutes: number,
  excludeItemIds: string[] = [],
): CalendarAvailability;
```

Merge overlapping busy intervals, return every qualifying gap, and report pairwise conflicts. Do not rank gaps or impose working hours; the Agent makes those judgments from profile and context.

- [ ] **Step 5: Run the focused tests**

Run: `npx vitest run test/calendar.test.ts`

Expected: PASS for visibility, ownership, overlap, reminder/deadline non-blocking, and cross-midnight gaps.

### Task 2: Expose standard calendar read tools

**Files:**
- Create: `src/agent/tools/calendar.ts`
- Modify: `src/agent/composa-agent.ts`
- Test: `test/agent-calendar-tools.test.ts`

- [ ] **Step 1: Write failing tool tests**

```ts
const snapshot = await calendarSnapshot(env, principal, { from, to });
expect(snapshot.timezone).toBe("Asia/Singapore");
expect(snapshot.conflicts).toHaveLength(1);

const availability = await findOwnedAvailability(env, principal, {
  from,
  to,
  minimumMinutes: 60,
});
expect(availability.available).toContainEqual({ startAt: expectedStart, endAt: expectedEnd, durationMinutes: 120 });
```

- [ ] **Step 2: Implement `calendar_snapshot` and `availability_find`**

```ts
export function createCalendarTools(env: Env, principal: PrincipalProvider): ToolSet {
  return {
    calendar_snapshot: tool({ /* explicit from/to schema; read-only */ }),
    availability_find: tool({ /* explicit interval and minimum duration */ }),
  };
}
```

Return factual entries and gaps without selecting a preferred time. Remove the overlapping `schedule_list` Agent tool so one canonical calendar vocabulary is used throughout new turns; the lower-level schedule query remains an internal write validator.

- [ ] **Step 3: Merge tools into Think and activate them**

```ts
override getTools(): ToolSet {
  return { ...createReadTools(this.env, principal), ...createCalendarTools(this.env, principal) };
}
```

Add both names to `ACTIVE_TOOLS`.

- [ ] **Step 4: Run tool tests**

Run: `npx vitest run test/agent-calendar-tools.test.ts`

Expected: PASS, including user scoping and unbounded interval length.

### Task 3: Add four on-demand Think calendar skills

**Files:**
- Create: `src/agent/skills/calendar-read/SKILL.md`
- Create: `src/agent/skills/calendar-plan/SKILL.md`
- Create: `src/agent/skills/calendar-manage/SKILL.md`
- Create: `src/agent/skills/calendar-review/SKILL.md`
- Create: `src/agent/skills/calendar.ts`
- Modify: `src/agent/composa-agent.ts`
- Modify: `src/agent/prompt.ts`
- Modify: `src/env.d.ts`
- Modify: `wrangler.jsonc`
- Modify: `wrangler.test.jsonc`
- Test: `test/agent-calendar-skills.test.ts`

- [ ] **Step 1: Write failing skill catalog tests**

```ts
const descriptors = await calendarSkillSource.list();
expect(descriptors.map(({ name }) => name)).toEqual([
  "calendar-read", "calendar-plan", "calendar-manage", "calendar-review",
]);
expect((await calendarSkillSource.load("calendar-plan"))?.body).toContain("availability_find");
```

- [ ] **Step 2: Write the four concise `SKILL.md` files**

Each description states concrete trigger contexts. Bodies explain why event/deadline/reminder/work-session semantics differ, which factual tool to call first, how to preserve user intent, and how to report actual changes. Planning guidance must not introduce fixed clock times, fixed split counts, or task-category templates.

- [ ] **Step 3: Bundle Markdown as Workers Text modules and create a manifest source**

```ts
const parsed = skills.parseSkillMarkdown(rawSkill);
export const calendarSkillSource = skills.fromManifest({
  id: "desk-ix-calendar",
  fingerprint: "desk-ix-calendar-v1",
  skills: parsedSkills,
});
```

Add a `Text` module rule for `**/*.md` in production and test Wrangler configs and declare the Markdown module type.

- [ ] **Step 4: Wire `getSkills()` and skill tools into Think**

```ts
override getSkills() {
  return [calendarSkillSource];
}
```

Activate `activate_skill` and `read_skill_resource`; no script runner or Loader binding is needed because this suite contains instructions only.

- [ ] **Step 5: Slim the permanent persona prompt**

Keep identity, ownership, truthfulness, reference resolution, and the core four-time-object distinction always on. Replace procedural calendar bullets with one instruction to activate the matching calendar skill, so detailed procedures load only when relevant.

- [ ] **Step 6: Run skill tests and deployment dry run**

Run: `npx vitest run test/agent-calendar-skills.test.ts test/agent-runtime.test.ts`

Run: `npm run deploy:dry`

Expected: four descriptors load, malformed skills fail tests, and Wrangler bundles all Markdown resources.

### Task 4: Feed the canonical calendar into daily planning and review

**Files:**
- Modify: `src/core/daily-plan.ts`
- Modify: `src/ai/prompts.ts`
- Test: `test/daily-plan.test.ts`

- [ ] **Step 1: Write a failing daily-plan semantic test**

```ts
expect(modelRequest).toContain('"kind":"deadline"');
expect(modelRequest).toContain('"blocks_time":false');
expect(modelRequest).toContain('"kind":"work_session"');
```

- [ ] **Step 2: Replace the legacy busy-window payload with the canonical snapshot**

Pass events, deadlines, reminders, work sessions, and conflicts to the daily planner. Continue passing full open-item context and the user profile.

- [ ] **Step 3: Align the daily-plan prompt with `calendar-review`**

Ask the model to distinguish commitments from suggestions, preserve fixed events, notice insufficient work scheduled before deadlines, and propose changes without claiming they were executed.

- [ ] **Step 4: Run daily-plan tests**

Run: `npx vitest run test/daily-plan.test.ts`

Expected: PASS with complete calendar semantics and no output truncation.

### Task 5: Audit, document, verify, and deploy

**Files:**
- Modify: `README.md`
- Modify: `docs/deployment.md`
- Create: `docs/audits/2026-08-17-calendar-skills.md`

- [ ] **Step 1: Document the internal calendar skills and boundaries**

Document the four skills, two new factual tools, internal-only storage, and the deliberate separation between deterministic interval math and model judgment. State that external providers and recurring-series primitives are not silently emulated.

- [ ] **Step 2: Run complete validation**

Run: `npm run types`

Run: `npm run typecheck`

Run: `npm run lint`

Run: `npm test`

Run: `npm run deploy:dry`

Expected: all commands pass.

- [ ] **Step 3: Review Workers production concerns**

Verify generated binding types, Text module rules against Wrangler schema, no floating promises, no mutable request globals, no new secrets, user-scoped D1 predicates, serializable tool results, and bounded external I/O only.

- [ ] **Step 4: Deploy and smoke-test**

Run: `npm run deploy`

Verify: `https://desk.kinamind.org/health` returns HTTP 200 and the deployed Think runtime initializes the skill catalog without warnings.

- [ ] **Step 5: Create PR, wait for CI, merge, and synchronize `main`**

Commit the focused changes, push `codex/internal-calendar-skills`, create a PR, wait for the validation job, merge only after it passes, pull `main`, and deploy the merged commit once more.
