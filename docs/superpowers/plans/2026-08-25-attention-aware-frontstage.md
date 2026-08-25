# Attention-Aware Frontstage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Desk-IX carry a complete background model of the user's commitments while presenting only the information that deserves the user's attention for the current intent.

**Architecture:** Keep the Think Agent as the backstage cognition and execution loop. Add an always-on, tool-free attention presenter after a completed Think turn and before channel delivery. The presenter receives the original request plus the completed backstage draft, infers the foreground intent semantically, and produces the minimum sufficient response without changing facts or claiming new actions. Prompt and calendar-skill guidance will reinforce that background completeness never implies foreground enumeration.

**Tech Stack:** TypeScript, Cloudflare Think/Agents, OpenAI-compatible chat completions, Workers Vitest, D1 usage accounting.

---

### Task 1: Define the attention presentation contract

**Files:**
- Create: `src/agent/attention.ts`
- Create: `test/agent-attention.test.ts`

**Step 1: Write the failing tests**

Cover the tool-free model request, preservation of the original user request and backstage result, semantic attention selection without fixed item counts, progressive disclosure for explicit audits, delta-only acknowledgements, and suppression of irrelevant sensitive details.

**Step 2: Run the focused test to verify it fails**

Run: `npx vitest run test/agent-attention.test.ts`

**Step 3: Implement the presenter**

Create a dedicated system prompt and provider call. Treat the backstage draft as untrusted content, forbid new actions or invented facts, and leave output length to semantic relevance rather than a numeric cap.

**Step 4: Run the focused test to verify it passes**

Run: `npx vitest run test/agent-attention.test.ts`

### Task 2: Put the foreground layer on every completed Agent turn

**Files:**
- Modify: `src/agent/composa-agent.ts`
- Modify: `src/agent/types.ts`
- Modify: `test/agent-runtime.test.ts`
- Modify: `test/agent-finalize.test.ts`

**Step 1: Extend runtime assertions**

Assert that the runtime reports an independent attention presentation layer and that empty-response recovery remains tool-free.

**Step 2: Integrate after Think completion**

For successful turns, recover a backstage draft if needed, then run the attention presenter before delivery. If presentation fails, log it and deliver the accurate backstage draft so completed work is never lost. Error and aborted responses remain deterministic and are not rewritten.

**Step 3: Add privacy-safe observability**

Log only request ID, success/fallback state, and character counts; never log user content or identifiers.

**Step 4: Run Agent tests**

Run: `npx vitest run test/agent-attention.test.ts test/agent-finalize.test.ts test/agent-runtime.test.ts`

### Task 3: Align backstage reasoning and schedule skills

**Files:**
- Modify: `src/agent/prompt.ts`
- Modify: `src/agent/skills/calendar-review/SKILL.md`
- Modify: `src/agent/skills/calendar-plan/SKILL.md`
- Modify: `test/agent-runtime.test.ts`

**Step 1: Add the two-layer responsibility to the core prompt**

Tell the backstage Agent to inspect enough context to make a reliable decision, execute all necessary state changes, and produce a factual handoff. Make clear that completeness belongs in memory and state, not in the visible reply.

**Step 2: Remove output-expansion pressure from skills**

Replace guidance that can be read as “show the complete situation” with attention-aware progressive disclosure. Keep planning judgments model-driven and avoid fixed numbers, keyword tables, or hard-coded categories.

**Step 3: Test the architectural invariants**

Assert that the prompts require complete background cognition, foreground intent recognition, progressive disclosure, and no fixed-count truncation.

### Task 4: Document and validate the architecture

**Files:**
- Modify: `docs/architecture.md`

**Step 1: Update the turn sequence**

Document the backstage Think loop, the foreground presenter, fallback behavior, privacy boundary, and one-extra-model-call cost/latency tradeoff.

**Step 2: Run full validation**

Run: `npm run check`

Run: `npm run deploy:dry`

**Step 3: Review the diff**

Confirm there are no fixed response-count heuristics, arbitrary token caps, user-content logs, new write privileges, or regressions to delivery fallback.

### Task 5: Ship and verify

**Files:**
- No schema migration expected.

**Step 1: Commit on the feature branch**

Commit the reviewed implementation on `codex/attention-aware-frontstage`.

**Step 2: Push and open a pull request**

Wait for CI and review the production diff before merging.

**Step 3: Merge, synchronize main, and deploy**

Deploy the merged Worker and verify the public health endpoint. Do not expose API keys, user IDs, message content, or other secrets in logs or reports.
