import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as PoolContainer from "./PoolContainer.ts";
import { handleFor } from "./PoolDirectory.ts";
import * as PoolStore from "./poolStore.ts";
import { makeFakeCliProxyApi, makeMemoryPoolObject } from "./testing.ts";

const alice = { userId: "user_alice" };
const bob = { userId: "user_bob" };

const makePool = (external?: (request: Request) => Promise<Response>) => {
  const object = makeMemoryPoolObject(external);
  return { ...object, pool: handleFor(object.api) };
};

/** Signs a Claude account in the way a user does: open the login, paste the redirect back. */
const signIn = (pool: ReturnType<typeof makePool>["pool"], actor = alice) =>
  Effect.gen(function* () {
    const login = yield* pool.startLogin(actor, "claude");
    yield* pool.completeLogin(actor, `http://localhost:54545/callback?code=c&state=${login.state}`);
    return yield* pool.loginStatus(actor, login.state);
  });

describe("PoolObject", () => {
  it.effect("is set up once, by its admin, and refuses everyone else", () =>
    Effect.gen(function* () {
      const { pool, runtime } = makePool();
      const created = yield* pool.create(alice, { name: "Work", personal: false });
      expect(created).toEqual({
        name: "Work",
        personal: false,
        backing: { mode: "managed" },
        role: "admin",
      });
      // Creating again as the owner is a no-op; nobody else can take it over.
      expect((yield* pool.create(alice, { name: "Other", personal: false })).name).toBe("Work");
      const refused = yield* Effect.flip(pool.create(bob, { name: "Mine", personal: false }));
      expect(refused.message).toBe("You don't have access to this pool.");
      expect((yield* Effect.flip(pool.accounts(bob))).message).toBe(
        "You don't have access to this pool.",
      );

      // The container's config is seeded before it ever starts.
      const config = yield* Effect.promise(() =>
        runtime.runPromise(PoolStore.PoolStore.use((store) => store.get(PoolStore.CONFIG_KEY))),
      );
      expect(config?.body).toContain("allow-remote: true");
      expect(config?.body).toContain("session-affinity: true");
    }),
  );

  it.effect("starts its container on demand and keeps its accounts while it sleeps", () =>
    Effect.gen(function* () {
      const { pool, runtime, container } = makePool();
      yield* pool.create(alice, { name: "Work", personal: false });
      // Reading an idle pool never wakes its container.
      expect((yield* pool.accounts(alice)).accounts).toEqual([]);
      expect(container.starts).toBe(0);

      expect(yield* signIn(pool)).toEqual({ status: "ok" });
      expect(container.starts).toBe(1);
      const [account] = (yield* pool.accounts(alice)).accounts;
      expect(account).toMatchObject({
        type: "claude",
        disabled: false,
        signedOut: false,
        contributedBy: alice.userId,
      });

      // Idle: the container stops; the pool still knows its accounts.
      yield* Effect.promise(() =>
        runtime.runPromise(PoolContainer.PoolContainer.use((running) => running.stop)),
      );
      expect((yield* pool.accounts(alice)).accounts).toEqual([account]);
      expect(container.starts).toBe(1);
    }),
  );

  it.effect("pauses, resumes and removes accounts for its admin", () =>
    Effect.gen(function* () {
      const { pool } = makePool();
      yield* pool.create(alice, { name: "Work", personal: false });
      yield* signIn(pool);
      const [account] = (yield* pool.accounts(alice)).accounts;
      yield* pool.updateAccount(alice, account!.name, "pause");
      expect((yield* pool.accounts(alice)).accounts[0]?.disabled).toBe(true);
      yield* pool.updateAccount(alice, account!.name, "remove");
      expect((yield* pool.accounts(alice)).accounts).toEqual([]);
    }),
  );

  it.effect("uses an external CLIProxyAPI as its backing instead of a container", () =>
    Effect.gen(function* () {
      const external = makeFakeCliProxyApi();
      const seen: Array<string> = [];
      const { pool, container } = makePool((request) => {
        seen.push(new URL(request.url).origin);
        return external.serve(request);
      });
      yield* pool.create(alice, { name: "Mine", personal: false });

      const refused = yield* Effect.flip(
        pool.setBacking(alice, {
          mode: "external",
          url: "https://proxy.example.test/",
          managementKey: "wrong",
          clientKey: "client",
        }),
      );
      expect(refused.message).toBe("proxy.example.test refused the management key.");

      const info = yield* pool.setBacking(alice, {
        mode: "external",
        url: "https://proxy.example.test/",
        managementKey: "management",
        clientKey: "client",
      });
      expect(info.backing).toEqual({ mode: "external", url: "https://proxy.example.test" });
      expect(yield* signIn(pool)).toEqual({ status: "ok" });
      expect((yield* pool.accounts(alice)).accounts).toHaveLength(1);
      expect(external.accounts.size).toBe(1);
      expect(container.starts).toBe(0);
      expect(new Set(seen)).toEqual(new Set(["https://proxy.example.test"]));
    }),
  );

  it.effect("deletes a pool, but never the personal one", () =>
    Effect.gen(function* () {
      const personal = makePool();
      yield* personal.pool.create(alice, { name: "Personal", personal: true });
      expect((yield* Effect.flip(personal.pool.delete(alice))).message).toBe(
        "Your personal pool can't be deleted.",
      );
      expect(personal.erased()).toBe(false);

      const work = makePool();
      yield* work.pool.create(alice, { name: "Work", personal: false });
      expect((yield* Effect.flip(work.pool.delete(bob))).message).toBe(
        "You don't have access to this pool.",
      );
      yield* work.pool.delete(alice);
      expect(work.erased()).toBe(true);
    }),
  );
});
