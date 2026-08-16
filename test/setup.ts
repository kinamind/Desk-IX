import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

beforeEach(async () => {
  if (!env.TEST_MIGRATIONS) throw new Error("TEST_MIGRATIONS binding is missing");
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
