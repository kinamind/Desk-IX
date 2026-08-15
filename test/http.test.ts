import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { routeRequest } from "../src/http/router";

describe("HTTP router", () => {
  it("reports health without leaking secrets", async () => {
    const ctx = createExecutionContext();
    const response = await routeRequest(new Request("https://worker.test/health"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      ok: true,
      service: "Composa",
      channels: { telegram: true, qq: true },
      ai: { configured: false, verified: false },
    });
    expect(JSON.stringify(body)).not.toContain("test-admin-token");
  });

  it("protects admin routes with a bearer token", async () => {
    const unauthorizedContext = createExecutionContext();
    const unauthorized = await routeRequest(new Request("https://worker.test/api/items"), env, unauthorizedContext);
    expect(unauthorized.status).toBe(401);

    const authorizedContext = createExecutionContext();
    const authorized = await routeRequest(new Request("https://worker.test/api/items", {
      headers: { Authorization: "Bearer test-admin-token" },
    }), env, authorizedContext);
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toEqual({ items: [] });
  });
});
