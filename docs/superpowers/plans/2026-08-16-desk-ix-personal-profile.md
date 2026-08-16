# Desk-IX Personal Profile and Daily Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing daily-plan cron into a profile-driven proactive assistant, give Desk-IX a stable persona and configurable forms of address, timezone, schedule, and sleep-routine preferences, and migrate the public brand without losing the existing bot or Durable Object state.

**Architecture:** D1 remains the authoritative cross-runtime store. A new `user_profiles` table is keyed by channel and user ID; ordinary messages ensure a profile exists, every Think turn receives its profile as context, and profile changes are made through one scoped Agent action. The 15-minute UTC Cron remains a cheap dispatcher, but selects each enabled profile using that profile's IANA timezone and preferred plan time. `desk.kinamind.org` becomes the sole public address while internal Worker/Durable Object identifiers remain unchanged to preserve state.

**Tech Stack:** TypeScript, Cloudflare Workers, Cloudflare Think/Agents SDK, D1 SQLite, Cron Triggers, Vitest Workers pool, Wrangler, GitHub CLI.

---

### Task 1: Persist personal profiles

**Files:**
- Create: `migrations/0004_user_profiles.sql`
- Create: `src/db/user-profiles.ts`
- Modify: `src/core/types.ts`
- Test: `test/user-profiles.test.ts`

- [ ] **Step 1: Write failing profile persistence tests**

Cover default creation, channel/user isolation, partial updates, valid IANA timezones, `HH:mm` schedule validation, and enabled-profile listing.

```ts
const profile = await ensureUserProfile(env.DB, "qq", "owner", {
  timezone: "Asia/Singapore",
  locale: "zh-CN",
  dailyPlanTime: "08:00",
});
expect(profile).toMatchObject({ channel: "qq", userId: "owner", dailyPlanEnabled: true });
await updateUserProfile(env.DB, "qq", "owner", { dailyPlanTime: "11:00", chronotype: "late" });
expect(await getUserProfile(env.DB, "qq", "owner")).toMatchObject({ dailyPlanTime: "11:00", chronotype: "late" });
```

- [ ] **Step 2: Run the profile test and confirm it fails**

Run: `npm test -- --run test/user-profiles.test.ts`

Expected: FAIL because the migration and profile repository do not exist.

- [ ] **Step 3: Add the D1 schema and typed repository**

Create a table with `(channel, user_id)` as the primary key and these fields: `user_call_name`, `assistant_call_name`, `timezone`, `locale`, `daily_plan_enabled`, `daily_plan_time`, `chronotype`, `target_wake_time`, `target_sleep_time`, `routine_coaching`, `communication_style`, JSON `preferences`, and timestamps. All SQL must use prepared statements; booleans are stored as `0/1` and JSON is parsed defensively.

```sql
CREATE TABLE user_profiles (
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'qq')),
  user_id TEXT NOT NULL,
  user_call_name TEXT,
  assistant_call_name TEXT NOT NULL DEFAULT '拾序',
  timezone TEXT NOT NULL,
  locale TEXT NOT NULL,
  daily_plan_enabled INTEGER NOT NULL DEFAULT 1 CHECK (daily_plan_enabled IN (0, 1)),
  daily_plan_time TEXT NOT NULL,
  chronotype TEXT NOT NULL DEFAULT 'unknown' CHECK (chronotype IN ('unknown', 'early', 'balanced', 'late')),
  target_wake_time TEXT,
  target_sleep_time TEXT,
  routine_coaching INTEGER NOT NULL DEFAULT 0 CHECK (routine_coaching IN (0, 1)),
  communication_style TEXT NOT NULL DEFAULT '自然、简洁、坦诚，像长期合作的个人助理',
  preferences TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, user_id)
);
```

- [ ] **Step 4: Run the profile test and confirm it passes**

Run: `npm test -- --run test/user-profiles.test.ts`

Expected: PASS.

### Task 2: Give the Agent a persistent persona relationship

**Files:**
- Modify: `src/agent/prompt.ts`
- Modify: `src/agent/composa-agent.ts`
- Modify: `src/agent/tools/read.ts`
- Modify: `src/agent/tools/write.ts`
- Modify: `src/agent/types.ts`
- Test: `test/agent-runtime.test.ts`
- Test: `test/agent-tools-write.test.ts`

- [ ] **Step 1: Write failing prompt and tool-contract tests**

Assert that the stable persona says `Desk-IX（拾序）`, explicitly says it is pronounced `desk nine`, uses natural long-term-assistant behavior, and registers `profile_get` and `profile_update`. Verify that an update can set names, timezone, plan time, late chronotype, and routine coaching only for the authenticated principal.

- [ ] **Step 2: Run the Agent tests and confirm they fail**

Run: `npm test -- --run test/agent-runtime.test.ts test/agent-tools-write.test.ts`

Expected: FAIL on the old Composa persona and missing profile tools.

- [ ] **Step 3: Implement profile-aware turn context and tools**

`receive()` ensures a default profile before submitting the message. `beforeTurn()` loads it, calculates the date and local time in the profile timezone, and injects a concise JSON-like profile section. Register one read tool and one idempotent write action:

```ts
profile_get: tool({
  description: "Read this user's persistent assistant relationship and planning preferences.",
  inputSchema: z.object({}),
  execute: () => loadProfile(env, principal()),
});

profile_update: action({
  description: "Update preferences the user stated or clearly asked the assistant to choose.",
  inputSchema: profileUpdateSchema,
  permissions: ["profile:write"],
  idempotencyKey: ({ input }) => `profile:${principal().eventId}:${stableFingerprint(input)}`,
  execute: (input) => updateOwnedProfile(env, principal(), input),
});
```

Do not infer sensitive identity attributes. Safe, reversible schedule defaults may be chosen and reported; sleep targets require an explicit user target.

- [ ] **Step 4: Run Agent tests and confirm they pass**

Run: `npm test -- --run test/agent-runtime.test.ts test/agent-tools-write.test.ts`

Expected: PASS.

### Task 3: Make daily plans profile-driven and schedule-aware

**Files:**
- Modify: `src/core/daily-plan.ts`
- Modify: `src/ai/prompts.ts`
- Modify: `src/db/daily-plan-runs.ts`
- Modify: `src/config.ts`
- Test: `test/daily-plan.test.ts`

- [ ] **Step 1: Write failing per-profile scheduling tests**

Cover two users with different timezones and plan times, a disabled profile, no duplicate delivery on the same local date, ownership isolation, and inclusion of same-day schedule windows. Verify that the legacy `DAILY_PLAN_TARGETS` list is only used when a target does not already have a profile.

- [ ] **Step 2: Run daily-plan tests and confirm they fail**

Run: `npm test -- --run test/daily-plan.test.ts`

Expected: FAIL because the current runner checks one global time and an empty deployment target list.

- [ ] **Step 3: Implement per-profile dispatch**

Resolve enabled D1 profiles plus unique legacy targets, then independently test each profile's local clock. Claim using that profile's local date before generating or delivering anything.

```ts
for (const profile of profiles) {
  if (!force && !shouldRunDailyPlan(now, profile.timezone, profile.dailyPlanTime)) continue;
  const day = localDate(now, profile.timezone);
  if (!await claimDailyPlanRun(env.DB, day, profile.channel, profile.userId, now)) continue;
  // Build with owned items, schedule windows, and profile; then deliver.
}
```

The model input must include the user's address preference, timezone, current local time, chronotype, optional sleep/wake targets, coaching flag, communication style, preferences, real items, and real schedule windows. Routine guidance is gentle, at most one line, and never invents a target clock.

- [ ] **Step 4: Run daily-plan tests and confirm they pass**

Run: `npm test -- --run test/daily-plan.test.ts`

Expected: PASS.

### Task 4: Migrate the public brand and hostname safely

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/deployment.md`
- Modify: `docs/qq.md`
- Modify: `docs/telegram.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `wrangler.jsonc`
- Modify: `wrangler.test.jsonc`
- Modify: `src/http/router.ts`
- Modify: `src/url/fetch.ts`
- Modify: `src/http/body.ts`
- Modify: `test/http.test.ts`
- Modify: `test/helpers.ts`
- Modify: `test/ai.test.ts`

- [ ] **Step 1: Write failing brand and health tests**

Assert the health response reports `Desk-IX`, the stable prompt contains the pronunciation, and active docs/config do not present Composa as the public product name.

- [ ] **Step 2: Apply the brand migration**

Set `APP_NAME` to `Desk-IX`, package name to `desk-ix`, and use `Desk-IX（拾序）` in current docs and user-facing runtime strings. Do not invent an expansion for `IX`; document only that it is read as `nine`. Keep the internal Worker name, `COMPOSA_AGENT` binding, `ComposaAgent` class, workflow name, and historical research artifacts unchanged to preserve deployed state and provenance.

Replace the custom domain directly because the owner will update the QQ bot callback after deployment:

```jsonc
"routes": [
  { "pattern": "desk.kinamind.org", "custom_domain": true }
]
```

- [ ] **Step 3: Regenerate Worker binding types and run brand tests**

Run: `npm run types && npm test -- --run test/http.test.ts test/agent-runtime.test.ts`

Expected: PASS.

### Task 5: Validate, migrate, deploy, and prove proactive delivery

**Files:**
- Modify if validation requires it: only files already listed above

- [ ] **Step 1: Run all local quality gates**

Run: `npm run typecheck`, `npm run lint`, and `npm test`.

Expected: 100% pass.

- [ ] **Step 2: Apply the additive D1 migration remotely**

Run: `npm run db:migrate:remote`.

Expected: `0004_user_profiles.sql` applied without modifying existing items, reminders, messages, or daily-plan runs.

- [ ] **Step 3: Seed the owner's stated reversible preferences**

For the existing allowlisted QQ identity, store timezone `Asia/Singapore`, daily plan enabled at `11:00`, `chronotype='late'`, and `routine_coaching=1`. Leave both sleep and wake targets null until the user supplies them; leave `user_call_name` unset so Desk-IX uses natural second-person language rather than inventing a name.

- [ ] **Step 4: Verify Cloudflare authentication and deploy**

Run: `npx wrangler whoami`, then `npm run deploy`.

Expected: the new custom domain, Cron, D1, the existing Durable Object namespace, and the existing Workflow binding are present.

- [ ] **Step 5: Verify the new domain and the next Cron delivery**

Check `/health` on the new hostname. Observe the next 15-minute Cron, then query `daily_plan_runs` and confirm today's owner row is `sent` with no error. If the next Cron is too far away, use the authenticated daily-plan send endpoint without introducing a public test hook.

### Task 6: Publish and rename the repository

**Files:**
- No additional source files.

- [ ] **Step 1: Commit and push the feature branch**

Commit the tested scope, push `agent/desk-ix-personal-profile`, and open a ready PR to `main` with the root cause, architecture, migration, validation, and compatibility-domain behavior.

- [ ] **Step 2: Merge only after GitHub CI passes**

Use a merge commit so the migration and product change remain visible as one release unit.

- [ ] **Step 3: Rename the GitHub repository**

Rename `kinamind/Composa` to `kinamind/Desk-IX`, verify the new repository URL, update the local `origin` URL, and confirm `main` is clean and synchronized. GitHub's old repository redirect remains available for existing clones.

## Self-review

- Spec coverage: root-cause diagnosis, proactive daily plans, persistent persona, mutual address, timezone, preferred schedule, late chronotype, optional sleep coaching, Desk-IX branding, pronunciation, new hostname, repository rename, state preservation, tests, and deployment are all mapped to tasks.
- Placeholder scan: no implementation step uses TBD/TODO or delegates unspecified error handling.
- Type consistency: `UserProfile`, `UserProfileUpdate`, profile repository functions, Agent tools, and daily-plan runner all use `channel` plus `userId` as the ownership key.
