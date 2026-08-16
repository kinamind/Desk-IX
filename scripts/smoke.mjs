const baseUrl = (process.env.DESK_IX_URL ?? process.env.COMPOSA_URL)?.replace(/\/$/, "");
if (!baseUrl) {
  console.error("Missing DESK_IX_URL, for example https://desk-ix.kinamind.org");
  process.exitCode = 1;
} else {
  const healthResponse = await fetch(`${baseUrl}/health`);
  const health = await healthResponse.json();
  if (!healthResponse.ok || typeof health !== "object" || health === null || health.ok !== true) {
    throw new Error(`Health check failed with HTTP ${healthResponse.status}`);
  }

  const missingResponse = await fetch(`${baseUrl}/does-not-exist`);
  if (missingResponse.status !== 404) throw new Error(`Expected 404, received ${missingResponse.status}`);

  const telegramResponse = await fetch(`${baseUrl}/webhooks/telegram`, { method: "POST", body: "{}" });
  if (telegramResponse.status !== 403) throw new Error(`Invalid Telegram webhook was not rejected: ${telegramResponse.status}`);

  console.log(JSON.stringify({ ok: true, service: health.service, version: health.version, channels: health.channels, ai: health.ai }));
}
