import { cancelOpenReminders } from "../db/reminders";
import { listScheduleWindows } from "../db/schedule";
import { archiveItem, completeItem, getOwnedItem, restoreItem } from "../db/items";
import { getConfig } from "../config";
import { setPendingAction } from "../db/pending-actions";
import type { IncomingMessage, OutgoingMessage } from "./types";
import { scheduleReminder } from "./reminder-service";
import { findAvailableReminderTime } from "./schedule";

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
    const proposedReminderAt = new Date(now.getTime() + minutes * 60_000).toISOString();
    const schedule = await listScheduleWindows(env.DB, incoming.channel, incoming.userId, now);
    const availability = findAvailableReminderTime(proposedReminderAt, {
      now,
      dueAt: item.dueAt,
      targetItemId: item.id,
      schedule,
      avoidWindows: [],
    });
    if (!availability.reminderAt) {
      return {
        output: { text: `截止前没有找到合适的空闲时间，原提醒没有修改：${item.title}` },
        itemId: item.id,
        acknowledgeCode: 3,
      };
    }
    const replacement = await scheduleReminder(env, {
      itemId: item.id,
      remindAt: availability.reminderAt,
      kind: `later-${callback.value ?? "1h"}`,
      target: { channel: incoming.channel, userId: incoming.userId },
    }, now);
    await cancelOpenReminders(env.DB, item.id, replacement.id);
    const reminder = formatCallbackTime(availability.reminderAt, getConfig(env).timezone);
    const adjusted = availability.adjusted ? "\n已避开日程冲突。" : "";
    return { output: { text: `⏰ 已延后：${item.title}\n提醒：${reminder}${adjusted}` }, itemId: item.id, acknowledgeCode: 0 };
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

function formatCallbackTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}
