import { describe, expect, it } from "vite-plus/test";
import { TokenCache, TokenUnavailable } from "../TokenCache.ts";
import { probeAuthorized } from "../probeAccess.ts";

const storage = () => {
  const values = new Map<string, unknown>();
  return {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
};

describe("singleton token cache", () => {
  it("coalesces concurrent requests and survives object eviction until expiry skew", async () => {
    const persisted = storage();
    let now = 1_000_000;
    let exchanges = 0;
    let finish!: (value: { token: string; expiresAt: number }) => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const exchange = () => {
      exchanges++;
      started();
      return new Promise<{ token: string; expiresAt: number }>((resolve) => {
        finish = resolve;
      });
    };
    const cache = new TokenCache(persisted, exchange, () => now);
    const calls = Array.from({ length: 30 }, () => cache.get());
    await didStart;
    expect(exchanges).toBe(1);
    finish({ token: "session-one", expiresAt: now + 3_600_000 });
    expect(new Set(await Promise.all(calls))).toEqual(new Set(["session-one"]));
    const fresh = new TokenCache(
      persisted,
      async () => {
        exchanges++;
        return { token: "session-two", expiresAt: now + 3_600_000 };
      },
      () => now,
    );
    expect(await fresh.get()).toBe("session-one");
    expect(exchanges).toBe(1);
    now += 3_300_001;
    expect(await fresh.get()).toBe("session-two");
    expect(exchanges).toBe(2);
  });

  it("persists a failure cooldown, sanitizes failures, and retries once conditions change", async () => {
    const persisted = storage();
    let now = 1_000_000;
    let exchanges = 0;
    const exchange = async () => {
      exchanges++;
      throw new Error("api_key=private upstream payload");
    };
    await expect(new TokenCache(persisted, exchange, () => now).get()).rejects.toThrow(
      "Boxd token exchange unavailable.",
    );
    const fresh = new TokenCache(persisted, exchange, () => now);
    await expect(fresh.get()).rejects.toBeInstanceOf(TokenUnavailable);
    expect(exchanges).toBe(1);
    now += 60_001;
    await expect(fresh.get()).rejects.toBeInstanceOf(TokenUnavailable);
    expect(exchanges).toBe(2);
  });

  it("rejects an already expired or near-expiry exchange response", async () => {
    const cache = new TokenCache(
      storage(),
      async () => ({ token: "bad", expiresAt: 1 }),
      () => 1000,
    );
    await expect(cache.get()).rejects.toBeInstanceOf(TokenUnavailable);
  });
});

it("requires the probe bearer secret, never query credentials or an empty binding", async () => {
  const token = "a".repeat(48);
  expect(await probeAuthorized(new Request(`https://probe/status?token=${token}`), token)).toBe(
    false,
  );
  expect(
    await probeAuthorized(
      new Request("https://probe/status", { headers: { authorization: `Bearer ${token}` } }),
      token,
    ),
  ).toBe(true);
  expect(
    await probeAuthorized(
      new Request("https://probe/status", {
        headers: { authorization: `Bearer ${"b".repeat(48)}` },
      }),
      token,
    ),
  ).toBe(false);
  expect(await probeAuthorized(new Request("https://probe/status"), "")).toBe(false);
});
