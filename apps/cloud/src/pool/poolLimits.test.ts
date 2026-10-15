// @effect-diagnostics globalDate:off globalDateInEffect:off - the fake CLIProxyAPI stamps responses with the wall clock.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { handleFor } from "./PoolDirectory.ts";
import { fromSignals } from "./poolLimits.ts";
import { overview, limitsSource, usageSource, type UserPool } from "./poolViews.ts";
import { makeMemoryPoolObject } from "./testing.ts";

const alice = { userId: "user_alice" };

const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const seconds = (iso: string) => String(Date.parse(iso) / 1000);

/** The headers a Claude subscription answers with, as CLIProxyAPI keeps them. */
const CLAUDE_SIGNALS = {
  "Anthropic-Ratelimit-Unified-Status": "allowed",
  "Anthropic-Ratelimit-Unified-5h-Utilization": "0.42",
  "Anthropic-Ratelimit-Unified-5h-Reset": seconds("2026-10-15T12:00:00.000Z"),
  "Anthropic-Ratelimit-Unified-7d-Utilization": "0.9",
  "Anthropic-Ratelimit-Unified-7d-Reset": seconds("2026-10-18T00:00:00.000Z"),
};

const CLAUDE_USAGE = JSON.stringify({
  five_hour: { utilization: 12, resets_at: "2026-10-15T13:00:00.000Z" },
  seven_day: { utilization: 30, resets_at: "2026-10-20T00:00:00.000Z" },
});

const makePool = () => {
  const object = makeMemoryPoolObject();
  return { ...object, pool: handleFor(object.api) };
};

/** Adds a Claude account through a sign-in, as its admin does. */
const signIn = (pool: ReturnType<typeof makePool>["pool"], provider: "claude" | "codex") =>
  Effect.gen(function* () {
    const login = yield* pool.startLogin(alice, provider);
    yield* pool.completeLogin(alice, `http://localhost:54545/callback?code=c&state=${login.state}`);
    yield* pool.loginStatus(alice, login.state);
    return (yield* pool.accounts(alice)).accounts.at(-1)!;
  });

const userPool: UserPool = {
  id: "work",
  objectName: "work",
  name: "Work",
  personal: false,
  backing: { mode: "managed" },
};

describe("fromSignals", () => {
  it("reads Claude's unified windows from its last response", () => {
    expect(fromSignals("claude", CLAUDE_SIGNALS, NOW)).toEqual({
      checkedAt: "2026-10-15T10:00:00.000Z",
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 42,
          resetsAt: "2026-10-15T12:00:00.000Z",
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: 10080,
          usedPercent: 90,
          resetsAt: "2026-10-18T00:00:00.000Z",
        },
      ],
    });
  });

  it("reads Codex's windows, with a reset given as seconds from the response", () => {
    const limits = fromSignals(
      "codex",
      {
        "x-codex-plan-type": "pro",
        "x-codex-primary-used-percent": "5",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-after-seconds": "600",
        "x-codex-secondary-used-percent": "61.5",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-at": seconds("2026-10-19T00:00:00.000Z"),
      },
      NOW,
    );
    expect(limits?.windows).toEqual([
      {
        id: "primary",
        kind: "session",
        label: "Session",
        usedPercent: 5,
        windowDurationMins: 300,
        resetsAt: "2026-10-15T10:10:00.000Z",
      },
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 61.5,
        windowDurationMins: 10080,
        resetsAt: "2026-10-19T00:00:00.000Z",
      },
    ]);
  });

  it("finds nothing in a response without rate-limit headers", () => {
    expect(fromSignals("claude", { "Retry-After": "30" }, NOW)).toBeNull();
    expect(fromSignals("xai", CLAUDE_SIGNALS, NOW)).toBeNull();
  });
});

describe("a pool's limits", () => {
  it.effect("asks the provider for an account that hasn't answered since the pool woke", () =>
    Effect.gen(function* () {
      const { pool, cliProxyApi } = makePool();
      yield* pool.create(alice, { name: "Work", personal: false });
      const login = yield* pool.startLogin(alice, "claude");
      yield* pool.completeLogin(alice, `http://x/cb?code=c&state=${login.state}`);
      const [name] = [...cliProxyApi.accounts.keys()];
      cliProxyApi.accounts.get(name!)!.usage = { status: 200, body: CLAUDE_USAGE };
      yield* pool.loginStatus(alice, login.state);

      const [account] = (yield* pool.accounts(alice)).accounts;
      expect(account?.usageLimits?.windows.map((w) => [w.id, w.usedPercent, w.resetsAt])).toEqual([
        ["five_hour", 12, "2026-10-15T13:00:00.000Z"],
        ["seven_day", 30, "2026-10-20T00:00:00.000Z"],
      ]);
      expect(cliProxyApi.accountRequests).toEqual([
        { name, url: "https://api.anthropic.com/api/oauth/usage" },
      ]);

      // The next sign-in reads again, but the first account isn't asked again so soon.
      yield* signIn(pool, "claude");
      expect(cliProxyApi.accountRequests.filter((request) => request.name === name)).toHaveLength(
        1,
      );
    }),
  );

  it.effect("takes newer windows from the account's last response, without asking", () =>
    Effect.gen(function* () {
      const { pool, cliProxyApi } = makePool();
      yield* pool.create(alice, { name: "Work", personal: false });
      const { name } = yield* signIn(pool, "claude");
      const fake = cliProxyApi.accounts.get(name)!;
      fake.signals = CLAUDE_SIGNALS;
      fake.observedAt = new Date(Date.now() + 1000).toISOString();
      yield* pool.updateAccount(alice, name, "resume");

      const [account] = (yield* pool.accounts(alice)).accounts;
      expect(account?.usageLimits?.windows.map((w) => w.usedPercent)).toEqual([42, 90]);
      expect(cliProxyApi.accountRequests).toHaveLength(1);
    }),
  );

  it.effect("doesn't ask about an account whose last response said enough", () =>
    Effect.gen(function* () {
      const { pool, cliProxyApi } = makePool();
      yield* pool.create(alice, { name: "Work", personal: false });
      const login = yield* pool.startLogin(alice, "claude");
      yield* pool.completeLogin(alice, `http://x/cb?code=c&state=${login.state}`);
      const [name] = [...cliProxyApi.accounts.keys()];
      const fake = cliProxyApi.accounts.get(name!)!;
      fake.signals = CLAUDE_SIGNALS;
      fake.observedAt = new Date().toISOString();
      yield* pool.loginStatus(alice, login.state);
      yield* signIn(pool, "claude");

      expect(cliProxyApi.accountRequests.filter((request) => request.name === name)).toEqual([]);
      const [account] = (yield* pool.accounts(alice)).accounts;
      expect(account?.usageLimits?.windows.map((w) => w.usedPercent)).toEqual([42, 90]);
    }),
  );

  it.effect("fills in from the account's last response after a failed check", () =>
    Effect.gen(function* () {
      const { pool, cliProxyApi } = makePool();
      yield* pool.create(alice, { name: "Work", personal: false });
      const login = yield* pool.startLogin(alice, "claude");
      yield* pool.completeLogin(alice, `http://x/cb?code=c&state=${login.state}`);
      const [name] = [...cliProxyApi.accounts.keys()];
      const fake = cliProxyApi.accounts.get(name!)!;
      fake.usage = { status: 503, body: "{}" };
      yield* pool.loginStatus(alice, login.state);
      expect((yield* pool.accounts(alice)).accounts[0]?.usageLimits?.unavailable?.message).toBe(
        "Anthropic refused the usage check (HTTP 503).",
      );

      // Signals from before the failed check still count.
      fake.signals = CLAUDE_SIGNALS;
      fake.observedAt = new Date(Date.now() - 60_000).toISOString();
      yield* pool.updateAccount(alice, name!, "resume");
      const [account] = (yield* pool.accounts(alice)).accounts;
      expect(account?.usageLimits?.windows.map((w) => w.usedPercent)).toEqual([42, 90]);
    }),
  );

  it.effect("says why per account when they can't be read", () =>
    Effect.gen(function* () {
      const { pool, cliProxyApi } = makePool();
      yield* pool.create(alice, { name: "Work", personal: false });
      const login = yield* pool.startLogin(alice, "codex");
      yield* pool.completeLogin(alice, `http://x/cb?code=c&state=${login.state}`);
      const [refused] = [...cliProxyApi.accounts.keys()];
      cliProxyApi.accounts.get(refused!)!.usage = { status: 401, body: "{}" };
      yield* pool.loginStatus(alice, login.state);
      const paused = yield* signIn(pool, "claude");
      yield* pool.updateAccount(alice, paused.name, "pause");

      const accounts = yield* pool.accounts(alice);
      const source = usageSource({ pool: userPool, accounts }, NOW);
      expect(
        source.accounts.map((account) => [account.driver, account.usageLimits.unavailable]),
      ).toEqual([
        [
          "codex",
          { reason: "probeFailed", message: "ChatGPT refused the usage check (HTTP 401)." },
        ],
        ["claudeAgent", { reason: "unsupported", message: "Paused." }],
      ]);
    }),
  );

  it.effect("shows admins each account, and members only what's left and when it resets", () =>
    Effect.gen(function* () {
      const { pool, cliProxyApi } = makePool();
      yield* pool.create(alice, { name: "Work", personal: false });
      const first = yield* signIn(pool, "claude");
      const second = yield* signIn(pool, "claude");
      cliProxyApi.accounts.get(first.name)!.signals = {
        ...CLAUDE_SIGNALS,
        "Anthropic-Ratelimit-Unified-5h-Utilization": "1",
      };
      cliProxyApi.accounts.get(second.name)!.signals = CLAUDE_SIGNALS;
      for (const { name } of [first, second]) {
        cliProxyApi.accounts.get(name)!.observedAt = new Date(Date.now() + 1000).toISOString();
      }
      yield* pool.updateAccount(alice, first.name, "resume");

      const accounts = yield* pool.accounts(alice);
      const source = usageSource({ pool: userPool, accounts }, NOW);
      const entry = { pool: userPool, source, models: [], role: accounts.role, routing: null };
      expect(limitsSource(entry).accounts).toHaveLength(2);
      expect(limitsSource({ ...entry, role: "member" }).accounts).toEqual([]);

      const claude = overview(userPool, source, NOW).providers.find(
        (provider) => provider.driver === "claudeAgent",
      );
      expect(claude).toMatchObject({
        available: true,
        usage: [
          {
            label: "Session",
            kind: "session",
            remainingPercent: 29,
            nextResetAt: "2026-10-15T12:00:00.000Z",
          },
          {
            label: "Weekly",
            kind: "weekly",
            remainingPercent: 10,
            nextResetAt: "2026-10-18T00:00:00.000Z",
          },
        ],
      });
      // Once every account is out, the provider can't run.
      cliProxyApi.accounts.get(second.name)!.signals = cliProxyApi.accounts.get(
        first.name,
      )!.signals!;
      cliProxyApi.accounts.get(second.name)!.observedAt = new Date(Date.now() + 2000).toISOString();
      yield* pool.updateAccount(alice, first.name, "resume");
      const out = usageSource({ pool: userPool, accounts: yield* pool.accounts(alice) }, NOW);
      expect(
        overview(userPool, out, NOW).providers.find((p) => p.driver === "claudeAgent")?.available,
      ).toBe(false);
    }),
  );
});
