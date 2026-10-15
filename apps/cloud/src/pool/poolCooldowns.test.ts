// @effect-diagnostics globalDate:off globalDateInEffect:off - the fake CLIProxyAPI holds accounts on the wall clock.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { handleFor } from "./PoolDirectory.ts";
import { makeMemoryPoolObject } from "./testing.ts";

const alice = { userId: "user_alice" };

const usage = (fiveHour: number, sevenDay: number) =>
  JSON.stringify({
    five_hour: {
      utilization: fiveHour,
      resets_at: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    },
    seven_day: {
      utilization: sevenDay,
      resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    },
  });

/**
 * A pool with one Claude account that Anthropic rate limited: CLIProxyAPI
 * holds it cooling down for two more hours and answers every request itself.
 * `nowUsed` is what Anthropic reports for its windows now.
 */
const coolingPool = (nowUsed: readonly [number, number], heldForMs = 2 * 3_600_000) =>
  Effect.gen(function* () {
    const object = makeMemoryPoolObject();
    const pool = handleFor(object.api);
    yield* pool.create(alice, { name: "Work", personal: false });
    const login = yield* pool.startLogin(alice, "claude");
    yield* pool.completeLogin(alice, `http://x/cb?code=c&state=${login.state}`);
    yield* pool.loginStatus(alice, login.state);
    const [name] = [...object.cliProxyApi.accounts.keys()];
    const account = object.cliProxyApi.accounts.get(name!)!;
    // The 429 came after the pool last checked the account, and said the window was used up.
    account.cooldownUntil = new Date(Date.now() + heldForMs).toISOString();
    account.signals = {
      "Anthropic-Ratelimit-Unified-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Utilization": "1",
    };
    account.observedAt = new Date(Date.now() + 1000).toISOString();
    account.usage = { status: 200, body: usage(...nowUsed) };
    const forward = () =>
      Effect.promise(async () => {
        const reply = await object.api.forwardModel(
          alice,
          "/v1/messages",
          new Request("http://gateway.test/v1/messages", { method: "POST", body: "{}" }),
        );
        if (reply._tag !== "forwarded") throw new Error(`expected a response, got ${reply._tag}`);
        await reply.response.body?.cancel();
        return reply.response.status;
      });
    const audit = Effect.promise(() =>
      object.runtime.runPromise(
        SqlClient.SqlClient.use(
          (sql) =>
            sql<{
              readonly actor: string;
              readonly action: string;
              readonly detail: string | null;
            }>`SELECT actor, action, detail FROM audit WHERE action = 'clear-cooldown'`,
        ),
      ),
    );
    return { ...object, name: name!, forward, audit };
  });

describe("a pool's stale cooldowns", () => {
  it.effect("clear when the provider says the window has reset", () =>
    Effect.gen(function* () {
      const { forward, cliProxyApi, name, audit } = yield* coolingPool([3, 40]);
      const held = cliProxyApi.accounts.get(name)!.cooldownUntil;
      // CLIProxyAPI answers itself: everything is cooling down.
      expect(yield* forward()).toBe(429);
      // That 429 made the pool check: Anthropic has room again, so the cooldown went.
      expect(cliProxyApi.cooldownResets).toEqual([name]);
      expect(yield* forward()).toBe(200);
      const [cleared] = yield* audit;
      expect(cleared).toMatchObject({ actor: "pool", action: "clear-cooldown" });
      expect(cleared?.detail).toBe(
        `${name}: Anthropic reports Session 3% and Weekly 40% used, but it was held until ${held}.`,
      );
    }),
  );

  it.effect("stay while the provider still says the window is used up", () =>
    Effect.gen(function* () {
      const { forward, cliProxyApi, audit } = yield* coolingPool([100, 40]);
      expect(yield* forward()).toBe(429);
      expect(cliProxyApi.cooldownResets).toEqual([]);
      expect(yield* audit).toEqual([]);
      // A client retrying right away doesn't make the pool ask again.
      const asked = cliProxyApi.accountRequests.length;
      expect(yield* forward()).toBe(429);
      expect(cliProxyApi.accountRequests).toHaveLength(asked);
    }),
  );

  it.effect("are waited out when they end within minutes", () =>
    Effect.gen(function* () {
      const { forward, cliProxyApi } = yield* coolingPool([3, 40], 2 * 60_000);
      expect(yield* forward()).toBe(429);
      expect(cliProxyApi.cooldownResets).toEqual([]);
    }),
  );
});
