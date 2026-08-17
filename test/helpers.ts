import type { RuntimeConfig } from "../src/config";

export function testConfig(): RuntimeConfig {
  return {
    appName: "Desk-IX",
    locale: "zh-CN",
    timezone: "Asia/Singapore",
    dailyPlanTime: "08:00",
    aiBaseUrl: "https://api.openai.com/v1",
    aiModel: "test-model",
    aiEmbeddingModel: "",
    aiMaxTokens: 600,
    aiTimeoutMs: 1_000,
    aiDailyPlanTimeoutMs: 90_000,
    aiDailyRequestLimit: 100,
    urlFetchTimeoutMs: 1_000,
    urlMaxBytes: 524_288,
    telegramAllowedUserIds: new Set(["42"]),
    qqAllowedUserOpenIds: new Set(["qq-user-42"]),
    dailyPlanTargets: [],
    qqAppId: "test-app",
    qqApiBaseUrl: "https://api.bot.qq.com",
  };
}
