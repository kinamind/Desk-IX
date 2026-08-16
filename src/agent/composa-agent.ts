import { Think } from "@cloudflare/think";
import type {
  ChatResponseResult,
  MessageConcurrency,
  StepContext,
  ThinkSubmissionInspection,
  TurnConfig,
  TurnContext,
} from "@cloudflare/think";
import type { ToolSet, UIMessage } from "ai";
import { getConfig } from "../config";
import { getAIRequests, recordAIUsage } from "../db/ai-usage";
import { getOwnedItem } from "../db/items";
import { failMessageBySource } from "../db/messages";
import { getPendingAction } from "../db/pending-actions";
import { log } from "../observability/log";
import { localDate } from "../core/time";
import { parseTurnPrincipal, safeParseTurnPrincipal, stampTurnPrincipal } from "./context";
import {
  deliverTurnResponse,
  messageText,
  migrateAgentDelivery,
  rememberTurnOrigin,
  retryFailedDeliveryForEvent,
} from "./delivery";
import { createComposaModel } from "./model";
import { buildSystemPrompt } from "./prompt";
import { createReadTools } from "./tools/read";
import { createWriteActions } from "./tools/write";
import { incomingAgentMessageSchema, type IncomingAgentMessage, type RuntimeProfile } from "./types";

const ACTIVE_TOOLS = [
  "memory_search",
  "item_get",
  "web_read",
  "schedule_list",
  "item_create",
  "item_update",
  "item_transition",
  "reminder_manage",
];

export class ComposaAgent extends Think<Env> {
  override workspaceBash = false;
  override includeMcpTools = false;
  override messageConcurrency: MessageConcurrency = "queue";
  override maxSteps = 6;
  override chatRecovery = {
    maxAttempts: 2,
    noProgressTimeoutMs: 120_000,
    maxRecoveryWork: 100,
    maxOomRetries: 1,
    terminalMessage: "这次处理被运行时中断了，我没有擅自继续操作。请重试刚才的要求。",
  };
  override chatStreamStallTimeoutMs = 45_000;
  override storeMessages = false;
  override storeTools = false;

  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      migrateAgentDelivery(this.ctx.storage.sql);
      return Promise.resolve();
    });
  }

  override getModel() {
    return createComposaModel(this.env);
  }

  override getSystemPrompt(): string {
    return buildSystemPrompt(getConfig(this.env));
  }

  override getTools(): ToolSet {
    return createReadTools(this.env, () => parseTurnPrincipal(this.activeTurnMetadata));
  }

  override getActions() {
    return createWriteActions(this.env, () => parseTurnPrincipal(this.activeTurnMetadata));
  }

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
    const principal = parseTurnPrincipal(this.activeTurnMetadata);
    const config = getConfig(this.env);
    const today = localDate(new Date(), config.timezone);
    const used = await getAIRequests(this.env.DB, today, "openai-compatible");
    if (used >= config.aiDailyRequestLimit) throw new Error("Daily AI request budget exhausted");
    const pending = await getPendingAction(this.env.DB, principal.channel, principal.userId);
    const pendingItem = pending
      ? await getOwnedItem(this.env.DB, pending.itemId, principal.channel, principal.userId)
      : null;
    const pendingContext = pending && pendingItem
      ? `\n当前有一个待完成的交互：用户刚才要求为事项「${pendingItem.title}」（itemId: ${pendingItem.id}）${pending.action === "reschedule" ? "修改提醒时间" : pending.action}。把本轮自然语言优先理解为对这项交互的回答；必要时先查日程，再调用 reminder_manage。`
      : "";
    return {
      activeTools: ACTIVE_TOOLS,
      instructions: `${ctx.system}\n\n本轮来自 ${principal.channel}。当前用户只允许访问和修改其自己的记忆。当前本地时间：${new Intl.DateTimeFormat(config.locale, { timeZone: config.timezone, dateStyle: "full", timeStyle: "long" }).format(new Date())}。${pendingContext}`,
      maxSteps: this.maxSteps,
      maxRetries: 1,
      timeout: {
        stepMs: config.aiTimeoutMs,
        totalMs: config.aiTimeoutMs * this.maxSteps,
        toolMs: Math.max(config.urlFetchTimeoutMs + 2_000, 15_000),
      },
    };
  }

  override authorizeTurn() {
    return { allowed: true, grantedPermissions: ["items:write", "reminders:write"] };
  }

  async receive(raw: IncomingAgentMessage): Promise<{
    submissionId: string;
    accepted: boolean;
    status: string;
  }> {
    const message = incomingAgentMessageSchema.parse(raw);
    const principal = {
      channel: message.channel,
      userId: message.userId,
      eventId: message.eventId,
      receivedAt: message.receivedAt,
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    };
    const userMessage: UIMessage = stampTurnPrincipal({
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: message.text }],
    }, principal);
    const submission = await this.submitMessages([userMessage], {
      idempotencyKey: `event:${message.eventId}`,
      // Ledger metadata powers status hooks and delivery. The user-message
      // turnMetadata powers activeTurnMetadata during tools and recovery.
      metadata: principal,
    });
    if (!submission.accepted) {
      await retryFailedDeliveryForEvent(this.env, this.ctx.storage.sql, message.eventId);
    }
    if (submission.status === "pending") {
      this.ctx.waitUntil(this._drainThinkSubmissions().catch((error: unknown) => {
        log("error", "agent_submission_immediate_drain_failed", {
          submissionId: submission.submissionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }));
    }
    return {
      submissionId: submission.submissionId,
      accepted: submission.accepted,
      status: submission.status,
    };
  }

  protected override async onSubmissionStatus(submission: ThinkSubmissionInspection): Promise<void> {
    let principal = null;
    if (submission.requestId && submission.metadata) {
      principal = safeParseTurnPrincipal(submission.metadata);
      if (principal) rememberTurnOrigin(this.ctx.storage.sql, submission.requestId, principal);
    }
    log("info", "agent_submission_status", {
      submissionId: submission.submissionId,
      requestId: submission.requestId,
      status: submission.status,
      error: submission.error,
    });
    if (
      principal
      && submission.requestId
      && (submission.status === "error" || submission.status === "aborted" || submission.status === "skipped")
    ) {
      const response = submission.status === "error"
        ? "这次 Agent 运行失败了，我没有擅自执行未完成的操作。请稍后重试。"
        : "这次处理被中断了，我没有擅自继续操作。你可以直接重发刚才的要求。";
      await deliverTurnResponse(this.env, this.ctx.storage.sql, submission.requestId, response);
      await failMessageBySource(
        this.env.DB,
        principal.channel,
        principal.eventId,
        `agent submission ${submission.status}: ${submission.error ?? "no error detail"}`,
      );
    }
  }

  override async onStepFinish(ctx: StepContext): Promise<void> {
    const config = getConfig(this.env);
    await recordAIUsage(
      this.env.DB,
      localDate(new Date(), config.timezone),
      "openai-compatible",
      ctx.usage.inputTokens ?? 0,
      ctx.usage.outputTokens ?? 0,
    );
    log("info", "agent_model_step_finished", {
      toolCalls: ctx.toolCalls.map((call) => call.toolName),
      toolResults: ctx.toolResults.length,
      finishReason: ctx.finishReason,
      inputTokens: ctx.usage.inputTokens,
      outputTokens: ctx.usage.outputTokens,
    });
  }

  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    const text = result.status === "completed"
      ? messageText(result.message)
      : "这次处理被中断了，我没有擅自继续操作。你可以直接重发刚才的要求。";
    await deliverTurnResponse(this.env, this.ctx.storage.sql, result.requestId, text);
    log(result.status === "error" ? "error" : "info", "agent_turn_finished", {
      requestId: result.requestId,
      status: result.status,
      continuation: result.continuation,
      error: result.error,
    });
  }

  override onChatError(error: unknown): unknown {
    log("error", "agent_turn_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return error;
  }

  getRuntimeProfile(): RuntimeProfile {
    return {
      runtime: "cloudflare-think",
      maxSteps: this.maxSteps,
      messageConcurrency: "queue",
      recovery: true,
      recoveryPolicy: "bounded",
      streamStallTimeoutMs: this.chatStreamStallTimeoutMs,
      immediateSubmissionDrain: true,
      sessionReady: Boolean(this.session),
      mcpTools: this.includeMcpTools,
      workspaceBash: this.workspaceBash !== false,
    };
  }
}
