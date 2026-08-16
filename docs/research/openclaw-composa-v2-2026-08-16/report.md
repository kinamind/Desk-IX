# From OpenClaw to Composa v2: A Deliberately Smaller Personal Agent Runtime

## Executive Summary

Composa should stop evolving as an intent classifier wrapped around a to-do database. The official OpenClaw implementation shows that the central unit of an agent is a serialized, persistent, per-session model-and-tool loop: a user message enters a session, the model chooses typed tools, each tool result is appended to the same transcript, and the model continues until it can answer. Sessions, tool calls, tool results, lifecycle events, and delivery are runtime concerns; tasks and reminders are domain data. OpenClaw also keeps policy outside the model through tool schemas, validation, permissions, and loop guards [1][2][3][7][8].

The recommended Composa v2 architecture preserves that core while removing most of OpenClaw's breadth. Composa keeps its QQ and Telegram adapters, D1 item/reminder tables, Reminder Workflow, daily plan, public-page reader, and fixed callback buttons. Ordinary natural-language messages move to one durable agent session per channel/user. The model receives a small native tool set for memory search, item retrieval, web reading, item mutation, lifecycle transitions, reminders, and schedule lookup. A request such as “根据刚才的链接更新招聘信息” can therefore execute `memory_search -> item_get -> web_read -> item_update -> reply` in one coherent turn instead of passing through multiple unrelated JSON classifiers.

Cloudflare's Think runtime is the closest supported substrate for this design: it provides Durable Object sessions, persisted message trees, programmatic FIFO submissions, multi-step tool execution, idempotent Actions, recovery, and tracing [11][12][13][14][15][16]. It is experimental, so Composa must isolate it behind an application-owned runtime boundary and keep all domain truth in D1. The migration should replace the old message path as a unit, prove the exact failed QQ scenarios with deterministic tool-loop tests, and only then remove the obsolete intent/observe/enrichment machinery.

## Introduction

### 1. Question, Scope, and Decision

The question is not whether individual Composa prompts can be improved. The question is which architectural properties make OpenClaw behave like a personal agent, and which of those properties can be retained in a lightweight Cloudflare Workers application. This review uses the official OpenClaw repository at commit `d5f41f734b2476917d21b885595aa156eb672443` and current Cloudflare Agents/Think documentation available on 2026-08-16. It focuses on the agent loop, session state, memory, tools, system prompts, lifecycle events, and delivery. It intentionally excludes a feature-by-feature product comparison.

The decision is to replace Composa's ordinary-message pipeline, not to add another fallback to it. Deterministic callback handling remains appropriate for explicit button actions such as complete, archive, restore, or snooze. Human language, including references such as “刚才那个”, revisions, requests to inspect a link, and combined read/update/remind instructions, must enter a native tool loop.

## Main Analysis

### 2. What the OpenClaw Architecture Actually Centers

#### 2.1 A serialized session run, not an intent enum

OpenClaw defines an agent run as a serialized per-session operation that performs intake, context assembly, model inference, tool execution, streaming, and persistence [1]. Its source loop invokes the model, inspects native tool-call blocks, validates and executes each selected tool, appends tool results to the transcript, and invokes the model again until the response contains no further tool calls [2]. This is materially different from asking a model to select one application-defined intent and then executing a fixed branch.

The distinction explains Composa's recent failures. “根据刚才的链接内容更新一下深圳理工大学的招聘信息” is not one intent. It requires resolving a conversational reference, finding an owned item, reading its links, interpreting multiple pages, updating the same record, and reporting what changed. An intent enum either grows a bespoke compound branch for this sentence or loses part of the request. A tool loop represents the problem naturally because the model may decide the next action after seeing each result.

OpenClaw also serializes runs by session key [1][5]. This prevents two messages from the same conversation from racing to update context. Composa needs the same property because QQ and Telegram webhooks are acknowledged before asynchronous processing finishes. A per-user durable session with FIFO submissions is therefore a correctness primitive, not merely a chat-history feature.

#### 2.2 Runtime transcript and domain memory are separate

OpenClaw sessions persist conversation state, including assistant messages, tool calls, tool results, and lifecycle information [5]. Its memory design exposes retrieval tools such as `memory_search` and `memory_get`, allowing the model to fetch relevant stored knowledge when needed rather than placing the complete corpus into every prompt [6]. This suggests a clean split for Composa:

- The Durable Object session owns the recent conversational transcript and tool-loop state.
- D1 remains the source of truth for items, projects, reminders, schedules, delivery audits, and user ownership.
- Retrieval tools query D1 and return bounded, typed results to the session.

This split avoids two undesirable extremes: treating every message as stateless, or copying all tasks and notes into a long prompt. It also allows Composa to retain its existing backup and administrative APIs without depending on an agent-runtime storage format.

#### 2.3 Tools are capabilities with enforced contracts

OpenClaw describes tools as the agent's action surface and validates their parameters before execution [7]. It additionally includes loop detection for repeated or unproductive calls [8]. The system prompt communicates behavioral expectations, but code controls what the agent may actually do [4][7]. This is the correct boundary for a personal assistant.

For Composa, ownership checks, URL safety, maximum page count, item state transitions, reminder cancellation, idempotency, and rate limits must live in tool implementations. The prompt may tell the model to avoid creating duplicates, but `item_update` must still reject an item belonging to a different user. The prompt may suggest reading no more than three public links, but `web_read` must enforce that limit and SSRF protections. AI should choose and compose safe operations; it should not be the only enforcement layer.

#### 2.4 Stable identity is separated from volatile context

OpenClaw assembles a system prompt from distinct concerns: agent identity and behavior, available tools, workspace or memory context, and runtime/channel details [3][4]. Composa should follow the separation even though its prompt will be much smaller. A stable persona block should express “Compose what matters. Find your order,” proactive but reversible judgment, and concise Chinese responses. Dynamic context should contain the user's timezone, current local time, channel capabilities, and any pending explicit interaction such as a requested reschedule. Tool descriptions should define operations, not be duplicated as prose branches in the persona.

#### 2.5 Observability is part of the runtime

OpenClaw emits model, tool, and lifecycle events and documents runtime logging as an operational interface [1][9]. This matters because a generic message such as “模型这次没有成功理解” cannot distinguish a provider error, malformed model output, invalid tool arguments, an ownership rejection, a fetch failure, or a delivery failure. The current Composa database records only the generic reply, which makes production diagnosis depend on guessing.

Composa v2 needs a run identifier and structured stages for submission, model step, tool selection, tool result, final response persistence, and channel delivery. Sensitive prompt and page contents should not be logged by default. The trace must preserve tool names, durations, success/error categories, token usage, and correlation IDs. That is enough to answer why a turn failed without turning personal memory into an observability dataset.

### 3. Why Cloudflare Think Is the Right Substrate

Cloudflare Think provides the same essential control flow: the model can call tools, receive their results, and continue until it produces an answer [11]. Its Session abstraction is backed by a Durable Object and persists a tree-structured message history with search and compaction facilities [14]. Programmatic submissions support webhook-originated work with durable idempotency, FIFO ordering, status inspection, and recovery-friendly execution [12]. Those properties map directly to Composa's asynchronous QQ and Telegram ingress.

Think Actions add a durable idempotency ledger and typed structured errors for side-effecting tools [13]. This is useful for `item_create`, `item_update`, `item_transition`, `reminder_set`, and `reminder_cancel`: a recovered or retried turn should not create duplicate records or schedule duplicate reminders. Read-only capabilities can remain ordinary AI SDK tools. Think's recovery and lifecycle hooks allow interrupted turns to resume and give Composa a defined point for final channel delivery [15]. Cloudflare tracing can record model and tool spans while keeping payload storage disabled by default [16].

The choice has two important caveats. First, Think is currently experimental [11]. Composa should therefore contain all Think-specific code in `src/agent/` and expose application-owned tool contracts. D1 domain repositories must not depend on Think message schemas. Second, Think includes general workspace capabilities in its broader harness, while Composa must not become a remote shell. The agent must explicitly restrict active tools to the Composa registry, disable workspace shell access, and exclude MCP tools. A dry deployment and a real custom OpenAI-compatible provider test are mandatory before production traffic is switched.

Using Think is preferable to writing another custom loop. A home-grown implementation would need to solve durable serialization, message persistence, tool-call transcript format, retries, idempotency, recovery, cancellation, compaction, and tracing before it could improve the assistant's behavior. Those are exactly the runtime concerns that made OpenClaw's design robust and Composa's current text-only provider insufficient.

### 4. The Composa v2 Capability Cut

The lightweight agent should expose a deliberately small capability vocabulary:

1. `memory_search`: search the current user's D1 items and recent context with bounded results.
2. `item_get`: load one owned item with its structured fields and associated reminders.
3. `web_read`: read explicit URLs or URLs attached to one owned item, with SSRF protection, byte/time limits, and a maximum of three pages.
4. `item_create`: create a task, note, resource, idea, or project with structured content and provenance.
5. `item_update`: update the same owned item, including a structured summary derived from linked pages.
6. `item_transition`: complete, archive, restore, or abandon an item and reconcile reminders.
7. `reminder_manage`: create, reschedule, or cancel reminders using explicit absolute timestamps chosen with schedule context.
8. `schedule_list`: inspect relevant busy intervals before selecting a reminder time.

These tools are enough for the behaviors the user has asked for. They allow multi-step composition without introducing browser control, arbitrary HTTP requests, shell execution, local files, email, plugins, or autonomous multi-agent work. Link reading is a tool, not a special message branch. Recruitment parsing is model reasoning over retrieved content, not a recruitment-specific parser. “完成” and “舍弃” are item lifecycle operations, not separate mini-applications.

The following OpenClaw capabilities should be omitted from Composa v2: the WebSocket Gateway control plane, local node/device control, shell and filesystem tools, browser automation, plugin and MCP marketplaces, multi-agent orchestration, broad model-provider routing, voice/media pipelines, shared organizational tenancy, and workspace-file memory. Think's built-in session compaction may be used, but Composa should not reproduce OpenClaw's full workspace and memory-file conventions. These omissions are product boundaries that keep both the security surface and deployment model small.

## Synthesis

### 5. Target Request Flow

For an ordinary QQ message, the existing channel adapter verifies the signature, checks the allowed user, normalizes the event, and returns the platform acknowledgement. The router computes a non-reversible session key from channel and user ID and submits the message to that Durable Object with the platform event ID as the idempotency key. The per-user session serializes the turn.

Before model execution, the agent assembles the stable persona and volatile context, registers only the Composa tools, and selects the configured OpenAI-compatible model. The model can make up to a small bounded number of steps, initially six. Mutating tools execute as idempotent Actions and check the scoped user identity. When a final assistant message has been persisted, a lifecycle hook adds it to a delivery outbox and uses the existing channel adapter to reply. The outbox prevents duplicate platform delivery during retries.

For the failed recruitment example, the expected trace is:

`memory_search("深圳理工大学 招聘") -> item_get(itemId) -> web_read(itemId) -> item_update(itemId, structured dossier) -> final reply`

The model may omit `item_get` if `memory_search` returns enough details, or it may ask a short clarification if several records genuinely match. What matters is that each next choice is informed by real tool results. No branch named `update_recent_recruitment_link` should exist.

Fixed callback buttons continue through deterministic handlers because the user's intent and target identifier are explicit. A reschedule follow-up expressed in natural language enters the agent session, with the pending action summarized in dynamic context. The agent consults `schedule_list` if needed and calls `reminder_manage`; it does not invoke a separate time-extraction model.

### 6. Migration and Acceptance Strategy

The migration should be vertical. First add the Durable Object binding, model adapter, session subclass, tool registry, tool policies, delivery outbox, and observability. Then route ordinary messages through the new runtime while retaining callback, reminder workflow, daily plan, and admin paths. Only after native-loop tests and a real QQ smoke test pass should the old intent, observation, query-response, and link-enrichment modules be deleted.

Acceptance is behavioral and architectural. The exact latest QQ sentence must update the existing recruitment record rather than create a duplicate. A message with a public link must allow the model to read it and perform the requested operation. A reminder request must inspect schedule conflicts when choosing a time, avoid meaningless immediate reminders for deferred tasks, and clearly state the chosen reminder. Follow-up commands must resolve recent references from the session. Complete, abandon, archive, restore, and reschedule must be available in natural language and through existing buttons. Unauthorized item IDs and private-network URLs must be rejected in code. Duplicate webhook events and recovered turns must not duplicate writes or replies.

Operationally, every failed turn must reveal its failed stage and error category in structured logs without storing private message bodies by default. The old generic failure response may remain user-facing, but it can no longer be the only evidence. The deployment must pass type checking, linting, unit tests, Workers integration tests, a dry bundle, D1 compatibility checks, and a live QQ trace before merge.

## Limitations

The primary dependency risk is Think's experimental status. Isolation behind the `src/agent/` boundary, application-owned Zod schemas, D1 as domain truth, and a provider/runtime contract reduce replacement cost. The primary model risk is whether the configured OpenAI-compatible endpoint implements native tool calls consistently. A startup-independent contract test should send a harmless multi-tool scenario against the configured provider without exposing credentials, and production routing should not switch until it passes.

The primary delivery risk is losing the association between an asynchronously completed assistant response and the originating platform message. The session should store only the minimal delivery metadata and write an idempotent outbox row before calling QQ or Telegram. The primary privacy risk is tracing prompt or fetched-page contents. Trace payload storage should remain off by default; sanitized tool summaries and correlation IDs are sufficient. Finally, model loops can be expensive or unproductive. A six-step limit, tool-result size caps, loop detection, daily usage limits, and explicit error returns provide bounded failure.

## Recommendations

Proceed with a Composa v2 runtime replacement on the current unmerged branch. Do not add new intents or scenario-specific parsers. Adopt Cloudflare Think for durable sessions and the native tool loop, retain D1 for domain memory, expose only the eight scoped Composa capabilities, and preserve existing deterministic channel and reminder infrastructure. Switch production only after the exact failed conversation and adjacent lifecycle/reminder scenarios pass end-to-end. This preserves OpenClaw's architectural source of intelligence while deliberately discarding the weight Composa does not need.

## Bibliography

[1] OpenClaw. “Agent Loop.” Official repository documentation, commit d5f41f7, 2026. https://github.com/openclaw/openclaw/blob/d5f41f734b2476917d21b885595aa156eb672443/docs/concepts/agent-loop.md

[2] OpenClaw. “Agent Core Loop Source.” Official repository source, commit d5f41f7, 2026. https://github.com/openclaw/openclaw/blob/d5f41f734b2476917d21b885595aa156eb672443/packages/agent-core/src/agent-loop.ts

[3] OpenClaw. “Agent Runtime.” Official repository documentation, commit d5f41f7, 2026. https://github.com/openclaw/openclaw/blob/d5f41f734b2476917d21b885595aa156eb672443/docs/concepts/agent.md

[4] OpenClaw. “System Prompt.” Official repository documentation, commit d5f41f7, 2026. https://github.com/openclaw/openclaw/blob/d5f41f734b2476917d21b885595aa156eb672443/docs/concepts/system-prompt.md

[5] OpenClaw. “Session Management.” Official repository documentation, commit d5f41f7, 2026. https://github.com/openclaw/openclaw/blob/d5f41f734b2476917d21b885595aa156eb672443/docs/concepts/session.md

[6] OpenClaw. “Memory.” Official repository documentation, commit d5f41f7, 2026. https://github.com/openclaw/openclaw/blob/d5f41f734b2476917d21b885595aa156eb672443/docs/concepts/memory.md

[7] OpenClaw. “Tools.” Official repository documentation, commit d5f41f7, 2026. https://github.com/openclaw/openclaw/blob/d5f41f734b2476917d21b885595aa156eb672443/docs/tools/index.md

[8] OpenClaw. “Tool Loop Detection.” Official repository documentation, commit d5f41f7, 2026. https://github.com/openclaw/openclaw/blob/d5f41f734b2476917d21b885595aa156eb672443/docs/tools/loop-detection.md

[9] OpenClaw. “Gateway Logging.” Official repository documentation, commit d5f41f7, 2026. https://github.com/openclaw/openclaw/blob/d5f41f734b2476917d21b885595aa156eb672443/docs/gateway/logging.md

[10] OpenClaw. “Agent Runtime Architecture.” Official repository documentation, commit d5f41f7, 2026. https://github.com/openclaw/openclaw/blob/d5f41f734b2476917d21b885595aa156eb672443/docs/agent-runtime-architecture.md

[11] Cloudflare. “Think: Build AI Agents That Think.” Agents documentation, updated 2026-08-04. https://developers.cloudflare.com/agents/harnesses/think/

[12] Cloudflare. “Programmatic Submissions.” Think documentation, 2026. https://developers.cloudflare.com/agents/harnesses/think/programmatic-submissions/

[13] Cloudflare. “Actions.” Think documentation, 2026. https://developers.cloudflare.com/agents/harnesses/think/actions/

[14] Cloudflare. “Sessions.” Agents runtime documentation, 2026. https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/

[15] Cloudflare. “Lifecycle Hooks.” Think documentation, 2026. https://developers.cloudflare.com/agents/harnesses/think/lifecycle-hooks/

[16] Cloudflare. “Tracing.” Agents observability documentation, 2026. https://developers.cloudflare.com/agents/runtime/operations/observability/tracing/

## Methodology Appendix

This was a targeted architecture review rather than a broad web survey. Official primary sources were preferred throughout. OpenClaw documentation and source were pinned to one commit so that implementation claims can be reproduced. Cloudflare documentation was reviewed as of the report date because the proposed runtime is evolving quickly. Claims were extracted into an evidence ledger before recommendations were synthesized. The analysis compared responsibilities rather than matching product checklists: model/tool control flow, persistence, domain memory, policy, recovery, delivery, and observability. The report was saved inside the repository rather than the skill's default Documents directory because the project workspace is the authorized write scope and the artifact is intended to version with the implementation.
