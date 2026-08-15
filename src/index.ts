import { routeRequest } from "./http/router";
import { runDailyPlan } from "./core/daily-plan";
export { ReminderWorkflow } from "./workflows/reminder";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return routeRequest(request, env, ctx);
  },

  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runDailyPlan(env));
  },
} satisfies ExportedHandler<Env>;
