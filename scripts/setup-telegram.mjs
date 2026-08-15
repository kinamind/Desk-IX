const baseUrl = process.env.COMPOSA_URL?.replace(/\/$/, "");
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!baseUrl || !botToken || !webhookSecret) {
  console.error("Missing COMPOSA_URL, TELEGRAM_BOT_TOKEN, or TELEGRAM_WEBHOOK_SECRET.");
  process.exitCode = 1;
} else {
  const webhookUrl = `${baseUrl}/webhooks/telegram`;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: webhookSecret,
      allowed_updates: ["message", "edited_message", "callback_query"],
      drop_pending_updates: false,
    }),
  });
  const payload = await response.json();
  if (!response.ok || typeof payload !== "object" || payload === null || !("ok" in payload) || payload.ok !== true) {
    console.error(`Telegram setWebhook failed with HTTP ${response.status}.`);
    process.exitCode = 1;
  } else {
    console.log(`Telegram webhook configured: ${webhookUrl}`);
  }
}
