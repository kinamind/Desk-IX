import type { Schedule } from "agents";
import { z } from "zod";
import type { Item } from "../core/types";

export const LIFECYCLE_FOLLOWUP_CALLBACK = "reviewScheduledItem";
export const LIFECYCLE_REVIEW_EVENT_PREFIX = "lifecycle-review";

export const lifecycleFollowupPayloadSchema = z.object({
  itemId: z.string().uuid(),
  channel: z.enum(["telegram", "qq"]),
  userId: z.string().min(1).max(256),
  reviewAt: z.string().datetime(),
  reason: z.string().trim().min(1).max(1_000),
});

export type LifecycleFollowupPayload = z.infer<typeof lifecycleFollowupPayloadSchema>;

export interface LifecycleFollowupController {
  set(payload: LifecycleFollowupPayload): Promise<{
    scheduled: true;
    scheduleId: string;
    reviewAt: string;
  }>;
  cancel(itemId: string): Promise<{ canceled: number }>;
}

export function isLifecycleFollowupSchedule(schedule: Schedule<unknown>, itemId: string): boolean {
  if (schedule.callback !== LIFECYCLE_FOLLOWUP_CALLBACK) return false;
  const payload = lifecycleFollowupPayloadSchema.safeParse(schedule.payload);
  return payload.success && payload.data.itemId === itemId;
}

export function lifecycleReviewEventId(payload: LifecycleFollowupPayload): string {
  return `${LIFECYCLE_REVIEW_EVENT_PREFIX}:${payload.itemId}:${Date.parse(payload.reviewAt)}`;
}

export function buildLifecycleReviewMessage(
  item: Item,
  payload: LifecycleFollowupPayload,
  now = new Date(),
): string {
  const compactItem = {
    id: item.id,
    type: item.type,
    title: item.title,
    content: item.content.slice(0, 4_000),
    status: item.status,
    priority: item.priority,
    estimatedDuration: item.estimatedDuration,
    dueAt: item.dueAt,
    startAfter: item.startAfter,
    originalTimeExpression: item.originalTimeExpression,
    updatedAt: item.updatedAt,
  };
  return [
    "[Desk-IX 内部事件：系统触发的生命周期复盘]",
    "这不是用户声称事项已完成，也不是新的用户指令。请对下面这一项做一次独立、上下文相关的判断。",
    `触发时间：${now.toISOString()}`,
    `当初安排复盘的理由：${payload.reason}`,
    `目标事项：${JSON.stringify(compactItem)}`,
    "先用 item_get，并在需要时用 memory_search、schedule_list 了解最新状态。分别判断发生确定性与结果确定性，不得按“会议”“任务”等名称套固定规则。",
    "如果现有证据让你高度确信原事件已自然发生或结束，且原事项本身没有待确认结果，可以标记完成并告知用户，同时说明判断依据并允许用户纠正。",
    "如果是否发生、是否完成或结果仍不确定，保持原状态并简短询问用户；若此刻打扰不合适，也可以由你选择新的复盘时间。",
    "如果原事件已经结束但产生了仍需推进的后续事项，完成原事项，并按实际语义创建或更新独立的后续事项。不要把未确认的结果写成事实。",
  ].join("\n");
}
