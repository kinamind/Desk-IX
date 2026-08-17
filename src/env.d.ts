interface Env {
  AI_BASE_URL?: string;
  AI_MODEL?: string;
  AI_API_KEY: string;
  DAILY_PLAN_TARGETS?: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_ALLOWED_USER_IDS?: string;
  QQ_APP_ID?: string;
  QQ_ALLOWED_USER_OPENIDS?: string;
  QQ_APP_SECRET: string;
  ADMIN_API_TOKEN: string;
  XHS_COOKIE?: string;
}

declare namespace Cloudflare {
  interface Env {
    AI_BASE_URL?: string;
    AI_MODEL?: string;
    AI_API_KEY: string;
    DAILY_PLAN_TARGETS?: string;
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_WEBHOOK_SECRET: string;
    TELEGRAM_ALLOWED_USER_IDS?: string;
    QQ_APP_ID?: string;
    QQ_ALLOWED_USER_OPENIDS?: string;
    QQ_APP_SECRET: string;
    ADMIN_API_TOKEN: string;
    XHS_COOKIE?: string;
  }
}
