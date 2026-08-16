# Composa v2 OpenClaw-Derived Runtime Implementation Plan

> **For agentic workers:** REQUIRED SKILLS: use `agents-sdk` and `workers-best-practices` for implementation, then `cloudflare-deploy` for the production handoff. Execute this plan in the current task without subagents.

**Goal:** Replace Composa's intent-classifier message path with a durable per-user native tool loop that can resolve conversational references and compose memory, web reading, item mutation, scheduling, and replies.

**Architecture:** QQ and Telegram remain thin verified channel adapters. Each ordinary message is submitted idempotently to one `ComposaAgent` Durable Object per channel/user. The agent's Cloudflare Think session owns transcript and tool-loop state; D1 remains authoritative for items, reminders, schedules, audit messages, and ownership. The configured OpenAI-compatible model calls a bounded application-owned tool registry. Side effects use durable Actions and an outbox; fixed callback buttons remain deterministic.

**Tech Stack:** Cloudflare Workers, Durable Objects, Cloudflare Agents SDK and Think, Vercel AI SDK OpenAI-compatible provider, TypeScript, Zod, D1, Workflows, Vitest Workers pool.

---

## Non-negotiable boundaries

- Do not add new intent labels, compound-scenario branches, or domain-specific parsers.
- Do not give the model shell, filesystem, browser-control, arbitrary-network, MCP, or multi-agent tools.
- Keep all item/reminder ownership and transition rules enforced in code.
- Keep D1 as domain truth; Durable Object storage contains only session/runtime state and a minimal delivery outbox.
- Keep trace payload contents private by default; record correlation, stage, tool name, timing, outcome, and usage.
- Ordinary language uses the agent loop. Signed callback buttons may continue through deterministic handlers.
- Production does not switch until the configured GPT-5.6-compatible endpoint proves native tool calling in a live smoke test.

## Task 1: Prove the runtime dependency and Workers bundle

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `wrangler.jsonc`
- Modify: `src/index.ts`
- Create: `src/agent/composa-agent.ts`
- Regenerate: `worker-configuration.d.ts`
- Test: `test/agent-runtime.test.ts`

**Steps:**

1. Install `agents`, `@cloudflare/think`, `ai`, and `@ai-sdk/openai-compatible` at mutually compatible versions.
2. Add a `COMPOSA_AGENT` Durable Object binding and the first SQLite-class migration in `wrangler.jsonc`.
3. Export a minimal `ComposaAgent` class and restrict Think configuration to queued messages, recovery enabled, six maximum steps, workspace shell disabled, and MCP disabled.
4. Add a test proving a Durable Object instance can be resolved and accepts an idempotency key.
5. Run generated types, TypeScript, the focused test, and `wrangler deploy --dry-run` before building domain tools. If the dependency is incompatible with the current Workers runtime, stop and replace only the runtime adapter, not the v2 architecture.

## Task 2: Introduce app-owned model and session boundaries

**Files:**

- Create: `src/agent/model.ts`
- Create: `src/agent/context.ts`
- Create: `src/agent/prompt.ts`
- Create: `src/agent/types.ts`
- Modify: `src/config.ts`
- Modify: `src/env.d.ts`
- Test: `test/agent-model.test.ts`
- Test: `test/agent-prompt.test.ts`

**Steps:**

1. Wrap `createOpenAICompatible` so `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` produce an AI SDK language model without exposing secrets in logs.
2. Define a scoped session identity containing channel and user ID; hash `channel:userId` for the Durable Object name.
3. Build the stable Composa persona separately from volatile current time, timezone, channel, pending action, and tool context.
4. State behavioral defaults in the prompt: infer reversible details, ask only when ambiguity can cause a material wrong action, prefer updating the referenced item over duplicating it, and choose useful non-immediate reminders unless the user says otherwise.
5. Add tests for stable prompt content, dynamic time/context injection, and secret-free error serialization.

## Task 3: Build the read-only capability layer first

**Files:**

- Create: `src/agent/tools/index.ts`
- Create: `src/agent/tools/memory.ts`
- Create: `src/agent/tools/web.ts`
- Create: `src/agent/tools/schedule.ts`
- Modify: `src/db/items.ts`
- Modify: `src/db/schedule.ts`
- Reuse: `src/url/reader.ts`
- Reuse: `src/security/ssrf.ts`
- Test: `test/agent-tools-read.test.ts`

**Steps:**

1. Write failing tests for user-scoped `memory_search`, `item_get`, `web_read`, and `schedule_list`.
2. Return compact typed results with stable IDs and explicit truncation metadata.
3. Let `web_read` accept explicit URLs or an owned item ID; enforce public HTTP(S), SSRF checks, three-page maximum, existing timeout, and existing byte limits in code.
4. Ensure `memory_search` supports semantic-looking natural queries through bounded D1 lexical search and recent-item fallback without inventing item matches.
5. Ensure every read rejects cross-user item access.

## Task 4: Build idempotent domain Actions

**Files:**

- Create: `src/agent/tools/items.ts`
- Create: `src/agent/tools/reminders.ts`
- Modify: `src/db/items.ts`
- Modify: `src/db/reminders.ts`
- Modify: `src/core/reminder-service.ts`
- Modify: `src/core/types.ts`
- Test: `test/agent-tools-write.test.ts`

**Steps:**

1. Write failing tests for `item_create`, `item_update`, `item_transition`, and `reminder_manage`.
2. Implement them as Think Actions with stable idempotency keys derived from run/tool identity.
3. Require scoped ownership on every update and transition.
4. Support structured content/provenance updates so link-derived summaries enrich the same record rather than create a duplicate.
5. Define lifecycle transitions for complete, abandon/archive, and restore; reconcile open reminders on terminal transitions.
6. Require absolute reminder timestamps from the model tool call, validate timezone and future usefulness, and return conflicts so the model can choose another time.

## Task 5: Connect the native model/tool loop

**Files:**

- Modify: `src/agent/composa-agent.ts`
- Modify: `src/agent/tools/index.ts`
- Create: `src/agent/observability.ts`
- Test: `test/agent-loop.test.ts`

**Steps:**

1. Register only the eight Composa capabilities in `getTools()` and explicitly set the active tool list before each turn.
2. Add lifecycle instrumentation for run start/end, model steps, tool calls/results, token usage, failure category, and recovery; never log raw secrets or full personal content by default.
3. Use an AI SDK mock model to prove a multi-step turn can execute `memory_search -> item_get -> web_read -> item_update -> final reply`.
4. Prove a tool error is returned to the model so it may recover or ask a concise clarification.
5. Prove step limits and repeated-call protection end an unproductive loop safely.

## Task 6: Add durable channel delivery

**Files:**

- Create: `src/agent/delivery.ts`
- Modify: `src/agent/composa-agent.ts`
- Reuse: `src/channels/registry.ts`
- Reuse: `src/channels/qq.ts`
- Reuse: `src/channels/telegram.ts`
- Test: `test/agent-delivery.test.ts`

**Steps:**

1. Store minimal origin metadata on the submitted user message: channel, scoped user, platform event ID, and reply target.
2. On persisted final response, write an outbox row before calling the existing adapter.
3. Mark delivery success atomically enough that recovery/retry cannot send the same response twice.
4. Keep failures retryable with bounded backoff and structured logs.
5. Test success, transient failure, recovery, and duplicate submission.

## Task 7: Switch only ordinary messages at ingress

**Files:**

- Modify: `src/http/router.ts`
- Modify: `src/core/processor.ts`
- Modify: `src/core/callbacks.ts`
- Modify: `src/db/messages.ts`
- Test: `test/routing.test.ts`
- Test: `test/callback.test.ts`

**Steps:**

1. Keep webhook verification, authorization, challenge handling, and immediate acknowledgement unchanged.
2. Route ordinary normalized messages to the hashed `ComposaAgent` instance with the platform event ID as the idempotency key.
3. Keep signed callback actions on the deterministic path.
4. Surface an existing pending reschedule as dynamic agent context so the next natural-language message uses `schedule_list` and `reminder_manage`.
5. Preserve the existing D1 message audit but record agent run ID, terminal stage, and delivery status.

## Task 8: Remove the obsolete pseudo-agent path

**Files:**

- Delete: `src/ai/intent.ts`
- Delete or reduce to daily-plan-only helpers: `src/ai/prompts.ts`
- Delete: `src/core/item-enrichment.ts`
- Rewrite: `src/core/processor.ts`
- Update/delete: `test/ai.test.ts`
- Update/delete: `test/item-enrichment.test.ts`
- Update: `test/processor.test.ts`

**Steps:**

1. Confirm no ordinary-message import reaches intent parsing, observation/query passes, repair passes, or post-save enrichment.
2. Preserve any text-only AI provider path still required by the daily plan until it is separately migrated.
3. Delete dead prompts, schemas, branches, tests, and exports as one cleanup change.
4. Search the repository for old intent names and generic “model did not understand” branches; retain only one safe terminal failure renderer driven by structured runtime errors.

## Task 9: Verify behavior against real failure cases

**Files:**

- Create: `test/fixtures/agent-scenarios.ts`
- Create: `test/agent-scenarios.test.ts`
- Modify: `scripts/smoke.mjs`
- Update: `docs/architecture.md`
- Update: `README.md`

**Steps:**

1. Encode the exact sentence “根据刚才的链接内容更新一下深圳理工大学的招聘信息” and assert it updates the existing item after reading its saved links.
2. Test a bare link plus instruction, a follow-up pronoun/reference, query after save, natural-language complete/abandon/restore, reminder rescheduling, and schedule-conflict avoidance.
3. Test ambiguous matches trigger one concise clarification instead of a blind mutation.
4. Test unauthorized IDs, private URLs, duplicate webhooks, model timeout, malformed tool arguments, and channel delivery retry.
5. Run `npm run check`, `npm run deploy:dry`, local D1 migrations, and the smoke script.

## Task 10: Production canary and handoff

**Files:**

- Update: `docs/deployment.md`
- Update: `docs/qq.md`
- Update: `docs/telegram.md`

**Steps:**

1. Inspect the production D1 schema and back it up before applying any additive migration.
2. Deploy the Durable Object migration and Worker as one version.
3. Send a harmless configured-provider contract turn that requires at least two native tool calls.
4. Send the exact failed QQ scenario, inspect the structured trace and resulting existing D1 row, then test a reminder that requires schedule lookup.
5. Roll back routing if the native tool contract, delivery outbox, or ownership checks fail; do not restore the old intent pipeline as a fallback.
6. Commit and push the reviewed v2 branch. Merge only after the user confirms the live QQ behavior.

## Definition of done

- The ordinary-message runtime contains no intent enum or scenario-specific parser.
- The configured model can make and continue from native tool calls in the deployed Worker.
- The latest failed recruitment request updates one existing item and cites what it read.
- Natural follow-ups, lifecycle operations, reminders, and schedule-aware choices work through the same tool vocabulary.
- Tool policies reject cross-user access and unsafe URLs regardless of model behavior.
- Duplicate events/recovery do not duplicate domain writes or channel replies.
- Failures identify provider, model-step, tool-validation, tool-execution, persistence, or delivery stage without exposing sensitive payloads.
- Full tests, dry deployment, production trace, and user QQ verification pass before merge.
