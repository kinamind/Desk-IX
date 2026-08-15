import { cancelOpenReminders } from "../db/reminders";
import { archiveItem, completeItem, getOwnedItem, restoreItem } from "../db/items";
import { setPendingAction } from "../db/pending-actions";
import type { IncomingMessage, OutgoingMessage } from "./types";
import { scheduleReminder } from "./reminder-service";

export interface CallbackResult {
  output: OutgoingMessage;
  itemId: string | null;
  acknowledgeCode: number;
}

export async function handleCallback(env: Env, incoming: IncomingMessage, now = new Date()): Promise<CallbackResult> {
  const callback = incoming.callback;
  if (!callback) return { output: { text: "操作无效。" }, itemId: null, acknowledgeCode: 1 };
  const item = await getOwnedItem(env.DB, callback.itemId, incoming.channel, incoming.userId);
  if (!item) return { output: { text: "这条记录不存在。" }, itemId: null, acknowledgeCode: 1 };

  if (callback.name === "done") {
    const changed = await completeItem(env.DB, item.id, now);
    await cancelOpenReminders(env.DB, item.id);
    return {
      output: { text: changed ? `✓ 已完成：${item.title}` : `✓ 已是完成状态：${item.title}` },
      itemId: item.id,
      acknowledgeCode: changed ? 0 : 3,
    };
  }

  if (callback.name === "archive") {
    const changed = await archiveItem(env.DB, item.id, now);
    await cancelOpenReminders(env.DB, item.id);
    return {
      output: { text: changed ? `✓ 已舍弃：${item.title}` : `✓ 已是舍弃状态：${item.title}` },
      itemId: item.id,
      acknowledgeCode: changed ? 0 : 3,
    };
  }

  if (callback.name === "restore") {
    const changed = await restoreItem(env.DB, item.id, now);
    return {
      output: { text: changed ? `↩ 已恢复：${item.title}` : `↩ 这条记录当前无需恢复：${item.title}` },
      itemId: item.id,
      acknowledgeCode: changed ? 0 : 3,
    };
  }

  if (callback.name === "later") {
    if (item.status === "completed") {
      return { output: { text: `✓ 已完成：${item.title}` }, itemId: item.id, acknowledgeCode: 3 };
    }
    const minutes = callback.value === "tomorrow" ? 24 * 60 : callback.value === "week" ? 7 * 24 * 60 : 60;
    const remindAt = new Date(now.getTime() + minutes * 60_000).toISOString();
    await scheduleReminder(env, {
      itemId: item.id,
      remindAt,
      kind: `later-${callback.value ?? "1h"}`,
      target: { channel: incoming.channel, userId: incoming.userId },
    }, now);
    const label = callback.value === "tomorrow" ? "明天" : callback.value === "week" ? "下周" : "1 小时后";
    return { output: { text: `⏰ 已延后到${label}：${item.title}` }, itemId: item.id, acknowledgeCode: 0 };
  }

  if (callback.name === "reschedule") {
    await setPendingAction(env.DB, {
      channel: incoming.channel,
      userId: incoming.userId,
      action: "reschedule",
      itemId: item.id,
    }, now);
    return {
      output: { text: `请发送新的时间，例如“明天下午 3 点”。\n${item.title}` },
      itemId: item.id,
      acknowledgeCode: 0,
    };
  }

  const due = item.dueAt ? `\n时间：${item.dueAt}` : "";
  return {
    output: { text: `${item.title}\n${item.content}${due}`.slice(0, 1800) },
    itemId: item.id,
    acknowledgeCode: 0,
  };
}
