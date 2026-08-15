import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getChannelAdapter } from "../channels/registry";
import { cancelOpenReminders, loadReminderDelivery, markReminderTriggered } from "../db/reminders";
import type { DeliveryReceipt, ReminderWorkflowPayload } from "../core/types";

export class ReminderWorkflow extends WorkflowEntrypoint<Env, ReminderWorkflowPayload> {
  public override async run(event: WorkflowEvent<ReminderWorkflowPayload>, step: WorkflowStep): Promise<void> {
    await step.sleepUntil("wait until reminder", new Date(event.payload.remindAt));

    const receipt = await step.do<DeliveryReceipt | null>(
      "check and deliver reminder",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "1 minute" },
      async () => {
        const delivery = await loadReminderDelivery(this.env.DB, event.payload.reminderId);
        if (!delivery) return null;
        if (delivery.reminder.status !== "pending" || delivery.item.status === "completed" || delivery.item.status === "archived") {
          if (delivery.item.status === "completed" || delivery.item.status === "archived") {
            await cancelOpenReminders(this.env.DB, delivery.item.id);
          }
          return null;
        }
        const adapter = getChannelAdapter(this.env, delivery.reminder.targetChannel);
        return await adapter.send(
          { channel: delivery.reminder.targetChannel, userId: delivery.reminder.targetUserId },
          {
            text: `🔔 ${delivery.item.title}`,
            buttons: [[
              { label: "Done", action: `done:${delivery.item.id}`, style: "primary" },
              { label: "Later", action: `later:${delivery.item.id}:1h` },
              { label: "Reschedule", action: `reschedule:${delivery.item.id}` },
            ], [
              { label: "Details", action: `details:${delivery.item.id}` },
            ]],
          },
        );
      },
    );

    if (receipt) {
      await step.do("mark reminder triggered", async () => {
        await markReminderTriggered(this.env.DB, event.payload.reminderId, receipt);
        return { marked: true };
      });
    }
  }
}
