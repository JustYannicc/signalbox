import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { authorizeExecutorWithTimeout, executorJwksResponse } from "./app.ts";

describe("Executor app endpoints", () => {
  afterEach(() => vi.useRealTimers());

  it("serves JWKS as cacheable JSON", async () => {
    const response = await executorJwksResponse({ jwks: async () => ({ keys: [] }) });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    await expect(response.json()).resolves.toEqual({ keys: [] });
  });

  it("keeps a missing or failed issuer out of discovery", async () => {
    const missing = await executorJwksResponse(undefined);
    const failed = await executorJwksResponse({
      jwks: async () => {
        throw new Error("bad signing configuration");
      },
    });

    for (const response of [missing, failed]) {
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("Executor token signing is not configured.");
    }
  });

  it("fails closed when live executor authority takes longer than five seconds", async () => {
    vi.useFakeTimers();
    const result = authorizeExecutorWithTimeout(
      () => new Promise<{ readonly active: boolean }>(() => {}),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toEqual({ active: false });
  });

  it("returns live authority and turns failures into inactive", async () => {
    await expect(authorizeExecutorWithTimeout(async () => ({ active: true }))).resolves.toEqual({
      active: true,
    });
    await expect(
      authorizeExecutorWithTimeout(async () => {
        throw new Error("authority unavailable");
      }),
    ).resolves.toEqual({ active: false });
  });
});
