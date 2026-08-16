# Lightweight Agent Loop Implementation Plan

**Goal:** Make Composa a lightweight personal Agent with observation, reasoning, tools, memory, and follow-up—not a rule-driven collector or Todo extractor.

**Architecture:** Keep the existing single Worker, D1 memory, and Workflows runtime. Add a bounded observation stage before planning, let the model request one bounded observation round for links stored in prior items, validate its structured actions in code, and return tool results to the model when an answer requires retrieved facts. Deterministic code remains responsible only for security, ownership, idempotency, schema validation, time validity, loop bounds, and delivery reliability.

**Tech Stack:** TypeScript, Zod, Cloudflare Workers, D1, Workflows, OpenAI-compatible provider, Vitest Workers pool

## 1. Audit deterministic behavior

- [x] Classify rules into operational safeguards versus semantic decisions.
- [x] Remove the generic-title keyword predicate; existing item renames now require an explicit model `update_item` decision.
- [x] Remove project-type 30/7/1-day milestone generation.
- [x] Keep explicit `/help`, callbacks, auth, deduplication, SSRF, ownership, schema, reminder validity, and conflict checks deterministic.

## 2. Observe before deciding

- [x] Read up to three public URLs from the current message before intent planning.
- [x] Pass bounded page title, description, source, and text to the planner alongside user-scoped memory, conversation, and schedule.
- [x] Treat page text as untrusted evidence, not instructions.
- [x] Reuse one observation batch for planning, analysis, and persistence so pages are not fetched twice.
- [x] Preserve partial results and explicit failures when only some pages are readable.

## 3. General linked-message memory

- [x] Support recruitment, application, event, article, paper, documentation, tool, product, resource, and other content.
- [x] Follow the user's requested focus instead of applying a universal recruitment template.
- [x] Store bounded evidence-backed facts in `ai_enrichment` while retaining `raw_message`.
- [x] Promote only safe missing indexed fields and merge user tags.
- [x] Make structured facts available to future planning, analysis, and keyword retrieval.

## 4. Close tool-result loops

- [x] Let the model choose structured D1 query filters.
- [x] Return actual query results to a second model pass for synthesis instead of showing a fixed row list.
- [x] Let the model request `read_item_links` for an owned prior item, execute one bounded observation round, then continue the same task with real page text.
- [x] Repair one generally invalid model plan using its validation error plus the original message, conversation, memory, schedule, and webpage context.
- [x] Permit an action plan to include a contextual reply when the user asks to both act and explain.
- [x] Keep a factual deterministic fallback if the query response model fails.

## 5. Personal scheduling and plans

- [x] Keep reminder time choice in the model while validating past, immediate, post-deadline, and conflicting times in code.
- [x] Stop generating reminder milestones solely from an item's type.
- [x] Scope each scheduled Daily Plan to its own `channel + user_id`.
- [x] Let the model prioritize Daily Plan content; label the fixed priority/deadline list as a fallback when AI is unavailable.

## 6. Verification and delivery

- [x] Add routing, multi-page, partial-fetch, non-recruitment, comparison, retrieval-response, timezone, and user-isolation tests.
- [x] Run the complete check suite and deployment dry-run.
- [x] Deploy to Cloudflare Workers and inspect health.
- [ ] Validate at least one linked-message flow and one enriched-memory query from QQ.
- [ ] Commit, push, open the PR, and merge after user validation.
