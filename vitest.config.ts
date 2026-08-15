import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          AI_API_KEY: "",
          TELEGRAM_BOT_TOKEN: "test-telegram-token",
          TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
          QQ_BOT_SECRET: "naOC0ocQE3shWLAfffVLB1rhYPG7",
          QQ_CLIENT_SECRET: "test-client-secret",
          ADMIN_API_TOKEN: "test-admin-token",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    restoreMocks: true,
    coverage: {
      provider: "custom",
      customProviderModule: "@cloudflare/vitest-pool-workers/config",
      reporter: ["text", "json-summary"],
    },
  },
});
