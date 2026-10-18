import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as PoolEngine from "./PoolEngine.ts";
import { makeFakeCliProxyApi, makeMemoryPoolObject } from "./testing.ts";

const actor = { userId: "owner" };
const target = "claude-target.json";
const other = "claude-other.json";
const T0 = Date.parse("2026-10-18T10:00:00Z");
const account = () => ({ type: "claude", email: "user@example.test", disabled: false });
const backing = {
  mode: "external",
  url: "https://proxy.test",
  managementKey: "management",
  clientKey: "client",
} as const;

const engineOf = (object: ReturnType<typeof makeMemoryPoolObject>) =>
  Effect.promise(() => object.runtime.runPromise(PoolEngine.PoolEngine)).pipe(
    Effect.tap((engine) => engine.initialize),
  );

describe("pool account logout", () => {
  it.effect.each(["refresh", "restart"])(
    "reconciles an applied logout with a lost reply on %s without a logout retry",
    (mode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const filename = path.join(directory, "pool.sqlite");
        const backend = makeFakeCliProxyApi();
        backend.accounts.set(target, account());
        backend.accounts.set(other, account());
        const deletions: string[] = [];
        const serve = async (request: Request) => {
          if (
            request.method === "DELETE" &&
            new URL(request.url).pathname.endsWith("/credentials")
          ) {
            deletions.push(new URL(request.url).searchParams.get("name")!);
            await backend.serve(request);
            throw new Error("The DELETE applied but its reply was lost");
          }
          return backend.serve(request);
        };
        const object = makeMemoryPoolObject(serve, undefined, { filename });
        yield* Effect.addFinalizer(() => Effect.promise(() => object.runtime.dispose()));
        const engine = yield* engineOf(object);
        yield* TestClock.setTime(T0);
        yield* engine.create(actor, { name: "Work", personal: false });
        yield* engine.setBacking(actor, backing);
        const unrelated = (yield* engine.accounts(actor)).accounts.find(
          (entry) => entry.name === other,
        );
        yield* Effect.promise(() =>
          object.runtime.runPromise(
            SqlClient.SqlClient.use(
              (sql) =>
                sql`UPDATE accounts SET contributed_by = 'original-contributor', added_at = 123 WHERE name = ${target}`,
            ),
          ),
        );
        expect((yield* Effect.flip(engine.logoutAccount(actor, "claude", target)))._tag).toBe(
          "PoolBackendError",
        );
        expect([...backend.accounts.keys()]).toEqual([other]);
        const next =
          mode === "restart" ? makeMemoryPoolObject(serve, undefined, { filename }) : object;
        if (mode === "restart") {
          yield* Effect.promise(() => object.runtime.dispose());
          yield* Effect.addFinalizer(() => Effect.promise(() => next.runtime.dispose()));
        }
        const refreshed = mode === "restart" ? yield* engineOf(next) : engine;
        yield* TestClock.setTime(T0 + PoolEngine.ACCOUNTS_FRESH_MS + 1);
        expect((yield* refreshed.accounts(actor)).accounts).toEqual([
          expect.objectContaining({ name: target, signedOut: true }),
          unrelated,
        ]);
        expect(
          yield* Effect.promise(() =>
            next.runtime.runPromise(
              SqlClient.SqlClient.use(
                (sql) => sql`SELECT contributed_by, added_at, signed_out, pending FROM accounts
                JOIN logged_out_accounts USING (name) WHERE name = ${target}`,
              ),
            ),
          ),
        ).toEqual([
          { contributed_by: "original-contributor", added_at: 123, signed_out: 1, pending: 0 },
        ]);
        expect(yield* Effect.flip(refreshed.updateAccount(actor, target, "pause"))).toMatchObject({
          _tag: "PoolRejectedError",
          reason: "Sign in to this account again first.",
        });
        yield* refreshed.updateAccount(actor, target, "remove");
        expect((yield* refreshed.accounts(actor)).accounts).toEqual([unrelated]);
        expect(deletions).toEqual([target]);
        expect([...backend.accounts.keys()]).toEqual([other]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps a failed invalidation retryable and never deletes a different provider's credential",
    () =>
      Effect.gen(function* () {
        const backend = makeFakeCliProxyApi();
        backend.accounts.set(target, account());
        backend.accounts.set(other, account());
        let fail = true;
        const deletions: string[] = [];
        const object = makeMemoryPoolObject((request) => {
          if (
            request.method === "DELETE" &&
            new URL(request.url).pathname.endsWith("/credentials")
          ) {
            deletions.push(new URL(request.url).searchParams.get("name")!);
            if (fail) return Promise.resolve(Response.json({}, { status: 503 }));
          }
          return backend.serve(request);
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => object.runtime.dispose()));
        const engine = yield* engineOf(object);
        yield* TestClock.setTime(T0);
        yield* engine.create(actor, { name: "Work", personal: false });
        yield* engine.setBacking(actor, backing);
        const denied = yield* Effect.flip(
          engine.logoutAccount({ userId: "stranger" }, "claude", target),
        );
        expect(denied._tag).toBe("PoolRejectedError");
        expect(deletions).toEqual([]);
        yield* Effect.flip(engine.logoutAccount(actor, "codex", target));
        expect(deletions).toEqual([]);
        // A stale snapshot must not authorize deleting a name now held by another provider.
        backend.accounts.set(target, { ...account(), type: "codex" });
        yield* Effect.flip(engine.logoutAccount(actor, "claude", target));
        expect(deletions).toEqual([]);
        backend.accounts.set(target, account());
        expect((yield* Effect.flip(engine.logoutAccount(actor, "claude", target)))._tag).toBe(
          "PoolBackendError",
        );
        yield* TestClock.setTime(T0 + PoolEngine.ACCOUNTS_FRESH_MS + 1);
        expect((yield* engine.accounts(actor)).accounts.every((entry) => !entry.signedOut)).toBe(
          true,
        );
        expect(backend.accounts.size).toBe(2);
        fail = false;
        yield* engine.logoutAccount(actor, "claude", target);
        yield* engine.logoutAccount(actor, "claude", target);
        expect(deletions).toEqual([target, target]);
        expect([...backend.accounts.keys()]).toEqual([other]);
        expect((yield* engine.accounts(actor)).accounts).toEqual([
          expect.objectContaining({ name: other, signedOut: false }),
          expect.objectContaining({ name: target, signedOut: true }),
        ]);
        expect((yield* Effect.flip(engine.updateAccount(actor, target, "resume")))._tag).toBe(
          "PoolRejectedError",
        );
        yield* engine.updateAccount(actor, target, "remove");
        expect((yield* engine.accounts(actor)).accounts.map((entry) => entry.name)).toEqual([
          other,
        ]);
        expect(deletions).toEqual([target, target]);
      }).pipe(Effect.scoped),
  );

  it.effect("retains signed-out accounts and attribution across restart and alarm refresh", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const filename = path.join(directory, "pool.sqlite");
      const backend = makeFakeCliProxyApi();
      backend.accounts.set(target, account());
      backend.accounts.set(other, account());
      const initial = makeMemoryPoolObject(backend.serve, undefined, { filename });
      const engine = yield* engineOf(initial);
      yield* TestClock.setTime(T0);
      yield* engine.create(actor, { name: "Work", personal: false });
      yield* engine.setBacking(actor, backing);
      yield* Effect.promise(() =>
        initial.runtime.runPromise(
          SqlClient.SqlClient.use(
            (sql) =>
              sql`UPDATE accounts SET contributed_by = 'original-contributor', added_at = 123 WHERE name = ${target}`,
          ),
        ),
      );
      yield* engine.logoutAccount(actor, "claude", target);
      yield* Effect.promise(() => initial.runtime.dispose());

      const next = makeMemoryPoolObject(backend.serve, undefined, { filename });
      yield* Effect.addFinalizer(() => Effect.promise(() => next.runtime.dispose()));
      const restarted = yield* engineOf(next);
      yield* TestClock.setTime(T0 + 20 * 60_000);
      yield* restarted.refreshUsageAtAlarm();
      expect(
        (yield* restarted.accounts(actor)).accounts.find((entry) => entry.name === target)
          ?.signedOut,
      ).toBe(true);
      expect(
        yield* Effect.promise(() =>
          next.runtime.runPromise(
            SqlClient.SqlClient.use(
              (sql) => sql`SELECT contributed_by, added_at FROM accounts WHERE name = ${target}`,
            ),
          ),
        ),
      ).toEqual([{ contributed_by: "original-contributor", added_at: 123 }]);
      // Reauthentication restores this entry without replacing its contributor.
      backend.accounts.set(target, account());
      const login = yield* restarted.startLogin(actor, "claude", "manual");
      yield* restarted.cancelLogin(actor, login.state);
      expect(
        (yield* restarted.accounts(actor)).accounts.find((entry) => entry.name === target)
          ?.signedOut,
      ).toBe(false);
      expect(
        yield* Effect.promise(() =>
          next.runtime.runPromise(
            SqlClient.SqlClient.use(
              (sql) => sql`SELECT contributed_by FROM accounts WHERE name = ${target}`,
            ),
          ),
        ),
      ).toEqual([{ contributed_by: "original-contributor" }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
