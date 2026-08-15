import type { ChannelTarget, Reminder } from "./types";
import { createReminder, markReminderFailed, setReminderWorkflowId } from "../db/reminders";
import { log } from "../observability/log";

export async function scheduleReminder(
  env: Env,
  input: { itemId: string; remindAt: string; kind?: string; target: ChannelTarget },
  now = new Date(),
): Promise<Reminder> {
  const { reminder, created } = await createReminder(env.DB, {
    itemId: input.itemId,
    remindAt: input.remindAt,
    kind: input.kind ?? "reminder",
    targetChannel: input.target.channel,
    targetUserId: input.target.userId,
  }, now);
  if (!created || reminder.workflowId) return reminder;

  let workflowId: string;
  try {
    const instance = await env.REMINDER_WORKFLOW.create({
      id: `reminder-${reminder.id}`,
      params: { reminderId: reminder.id, remindAt: reminder.remindAt },
      retention: { successRetention: "1 day", errorRetention: "3 days" },
    });
    workflowId = instance.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markReminderFailed(env.DB, reminder.id, message);
    throw error;
  }

  // The workflow is already live at this point. A bookkeeping write failure
  // must not mark it failed or prompt creation of a duplicate delivery.
  try {
    await setReminderWorkflowId(env.DB, reminder.id, workflowId);
  } catch (error) {
    log("warn", "reminder_workflow_id_persist_failed", {
      reminderId: reminder.id,
      workflowId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { ...reminder, workflowId };
}
