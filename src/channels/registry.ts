import { getConfig } from "../config";
import type { ChannelName } from "../core/types";
import { QQAdapter } from "./qq";
import { TelegramAdapter } from "./telegram";
import type { ChannelAdapter } from "./types";

export function getChannelAdapter(env: Env, channel: ChannelName, fetcher: typeof fetch = fetch): ChannelAdapter {
  const config = getConfig(env);
  if (channel === "telegram") {
    return new TelegramAdapter(config, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET, fetcher);
  }
  return new QQAdapter(config, env.QQ_BOT_SECRET, env.QQ_CLIENT_SECRET, fetcher);
}
