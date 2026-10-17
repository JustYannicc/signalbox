import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_POOL_ROUTING, POOL_LINK_PATH } from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { vi } from "vite-plus/test";

import * as CliProxyApi from "./cliProxyApi.ts";
import * as PoolEngine from "./PoolEngine.ts";
import * as PoolContainer from "./PoolContainer.ts";
import { handleFor } from "./PoolDirectory.ts";
import * as PoolStore from "./poolStore.ts";
import { makeFakeCliProxyApi, makeMemoryPoolObject } from "./testing.ts";

const alice = { userId: "user_alice" };
const bob = { userId: "user_bob" };
const T0 = Date.parse("2026-10-17T10:00:00.000Z");

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

/** Makes a pool look created before its managed config existed. */
const forget = (runtime: ReturnType<typeof makePool>["runtime"]) =>
  Effect.promise(() =>
    runtime.runPromise(
      SqlClient.SqlClient.use((sql) => sql`UPDATE managed_config SET applied = NULL`),
    ),
  );

describe("PoolObject", () => {
  it.effect(
    "backs off a failed legacy first model read before waking a sleeping pool again",
    () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
      const { pool, runtime, cliProxyApi, container } = makePool();
      let modelReads = 0;
      let failModelReads = false;
      const serve = cliProxyApi.serve;
      cliProxyApi.serve = (request) => {
        if (new URL(request.url).pathname === "/v1/models") {
          modelReads += 1;
          if (failModelReads) return Promise.resolve(Response.json({}, { status: 503 }));
        }
        return serve(request);
      };
      const sql = (query: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, SqlError>) =>
        Effect.promise(() => runtime.runPromise(SqlClient.SqlClient.use(query)));
      return Effect.gen(function* () {
        yield* pool.create(alice, { name: "Work", personal: false });
        yield* signIn(pool);
        yield* sql(
          (sql) => sql`UPDATE accounts_state SET models_checked_at = 0,
          models_attempted_at = 0 WHERE id = 1`,
        );
        failModelReads = true;
        const before = modelReads;

        yield* pool.models(alice);
        expect(modelReads).toBe(before + 1);
        expect(container.starts).toBe(1);

        yield* Effect.promise(() =>
          runtime.runPromise(PoolContainer.PoolContainer.use((service) => service.stop)),
        );
        yield* pool.models(alice);
        expect(container.starts).toBe(1);
        expect(modelReads).toBe(before + 1);
      }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
    },
  );

  it.effect("refreshes stale models from a running managed pool without waking it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { pool, runtime, cliProxyApi, container } = makePool();
    let modelReads = 0;
    const serve = cliProxyApi.serve;
    cliProxyApi.serve = (request) => {
      if (new URL(request.url).pathname === "/v1/models") modelReads += 1;
      return serve(request);
    };
    return Effect.gen(function* () {
      yield* pool.create(alice, { name: "Work", personal: false });
      yield* signIn(pool);
      const before = modelReads;
      cliProxyApi.catalog.claude!.push({
        id: "claude-opus-6",
        created: 1_800_000_000,
        displayName: "Claude Opus 6",
        reasoningEfforts: ["high"],
      });
      vi.setSystemTime(T0 + PoolEngine.MODELS_REFRESH_MS + 1);

      const read = yield* pool.models(alice);

      expect(read.models.map((model) => model.id)).toContain("claude-opus-6");
      expect(modelReads).toBeGreaterThan(before);
      expect(container.starts).toBe(1);
      expect(
        yield* Effect.promise(() =>
          runtime.runPromise(PoolEngine.PoolEngine.use((engine) => engine.nextModelsRefreshAt())),
        ),
      ).toBe(T0 + PoolEngine.MODELS_REFRESH_MS + 1 + PoolEngine.MODELS_REFRESH_MS);
    }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
  });

  it.effect("keeps a catalog deadline while asleep and wakes once for its scheduled read", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { pool, runtime, cliProxyApi, container } = makePool();
    const runEngine = <A, E>(
      effect: (engine: PoolEngine.PoolEngine["Service"]) => Effect.Effect<A, E>,
    ) => Effect.promise(() => runtime.runPromise(PoolEngine.PoolEngine.use(effect)));
    return Effect.gen(function* () {
      yield* pool.create(alice, { name: "Work", personal: false });
      expect(yield* runEngine((engine) => engine.nextModelsRefreshAt())).toBeNull();
      yield* signIn(pool);
      yield* Effect.promise(() =>
        runtime.runPromise(PoolContainer.PoolContainer.use((service) => service.stop)),
      );
      cliProxyApi.catalog.claude!.push({
        id: "claude-new-while-asleep",
        created: 1,
        displayName: "New Claude",
        reasoningEfforts: ["high"],
      });
      const deadline = T0 + PoolEngine.MODELS_REFRESH_MS;
      expect(yield* runEngine((engine) => engine.nextModelsRefreshAt())).toBe(deadline);
      vi.setSystemTime(deadline);
      yield* runEngine((engine) => engine.refreshModelsAtAlarm());
      expect(
        (yield* runEngine((engine) => engine.cachedModels(alice))).models.map((model) => model.id),
      ).toContain("claude-new-while-asleep");
      expect(container.starts).toBe(2);
      yield* runEngine((engine) => engine.refreshModelsAtAlarm());
      expect(container.starts).toBe(2);
    }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
  });

  it.effect("backs off failed model refreshes and does not wake a sleeping managed pool", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { pool, runtime, cliProxyApi, container } = makePool();
    let modelReads = 0;
    const serve = cliProxyApi.serve;
    let failModelReads = false;
    cliProxyApi.serve = (request) => {
      if (new URL(request.url).pathname === "/v1/models") {
        modelReads += 1;
        if (failModelReads) return Promise.resolve(Response.json({}, { status: 503 }));
      }
      return serve(request);
    };
    const nextRefresh = () =>
      Effect.promise(() =>
        runtime.runPromise(PoolEngine.PoolEngine.use((engine) => engine.nextModelsRefreshAt())),
      );
    return Effect.gen(function* () {
      yield* pool.create(alice, { name: "Work", personal: false });
      yield* signIn(pool);
      const before = modelReads;
      failModelReads = true;
      vi.setSystemTime(T0 + PoolEngine.MODELS_REFRESH_MS + 1);

      yield* pool.models(alice);
      expect(modelReads).toBe(before + 1);
      expect(yield* nextRefresh()).toBe(T0 + PoolEngine.MODELS_REFRESH_MS + 1 + 5 * 60_000);

      yield* pool.models(alice);
      expect(modelReads).toBe(before + 1);

      yield* Effect.promise(() =>
        runtime.runPromise(PoolContainer.PoolContainer.use((service) => service.stop)),
      );
      vi.setSystemTime(T0 + 2 * PoolEngine.MODELS_REFRESH_MS);
      yield* pool.models(alice);
      expect(container.starts).toBe(1);
      expect(modelReads).toBe(before + 1);
      expect(yield* nextRefresh()).toBe(T0 + 2 * PoolEngine.MODELS_REFRESH_MS);
    }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
  });

  it.effect(
    "refreshes linked catalogs from the cache endpoint and keeps the last good list on 404",
    () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
      const requests: Array<string> = [];
      let unavailable = false;
      const { pool, runtime, container } = makePool((request) => {
        const url = new URL(request.url);
        requests.push(url.pathname);
        if (url.pathname.endsWith("/models")) {
          return Promise.resolve(
            unavailable
              ? new Response(null, { status: 404 })
              : Response.json({
                  models: [{ id: "gpt-6.1-sol", ownedBy: "openai", created: 1_790_640_000 }],
                }),
          );
        }
        return Promise.resolve(Response.json({ name: "Source", accounts: [] }));
      });
      const runEngine = <A, E>(
        effect: (engine: PoolEngine.PoolEngine["Service"]) => Effect.Effect<A, E>,
      ) => Effect.promise(() => runtime.runPromise(PoolEngine.PoolEngine.use(effect)));
      return Effect.gen(function* () {
        yield* pool.create(alice, { name: "Preview", personal: false });
        yield* Effect.promise(() =>
          runtime.runPromise(
            SqlClient.SqlClient.use(
              (sql) => sql`UPDATE pool SET backing = 'external',
              external_url = ${`https://source.test${POOL_LINK_PATH}`},
              external_management_key = 'management', external_client_key = 'client'
              WHERE id = 1`,
            ),
          ),
        );

        yield* runEngine((engine) => engine.refreshModelsAtAlarm());
        expect(yield* runEngine((engine) => engine.cachedModels(alice))).toMatchObject({
          models: [{ id: "gpt-6.1-sol" }],
        });
        expect(requests).toEqual([`${POOL_LINK_PATH}/models`]);

        unavailable = true;
        vi.setSystemTime(T0 + PoolEngine.MODELS_REFRESH_MS + 1);
        yield* runEngine((engine) => engine.refreshModelsAtAlarm());
        expect(yield* runEngine((engine) => engine.cachedModels(alice))).toMatchObject({
          models: [{ id: "gpt-6.1-sol" }],
        });
        expect(requests).toEqual([`${POOL_LINK_PATH}/models`, `${POOL_LINK_PATH}/models`]);
        expect(yield* runEngine((engine) => engine.nextModelsRefreshAt())).toBe(
          T0 + PoolEngine.MODELS_REFRESH_MS + 1 + 5 * 60_000,
        );
        yield* runEngine((engine) => engine.refreshModelsAtAlarm());
        expect(requests).toHaveLength(2);
        expect(container.starts).toBe(0);
      }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
    },
  );

  it.effect("is set up once, by its admin, and refuses everyone else", () =>
    Effect.gen(function* () {
      const { pool, runtime } = makePool();
      const created = yield* pool.create(alice, { name: "Work", personal: false });
      expect(created).toEqual({
        name: "Work",
        personal: false,
        backing: { mode: "managed" },
        role: "admin",
        routing: DEFAULT_POOL_ROUTING,
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
      expect(config?.body).toContain("usage-statistics-enabled: true");
    }),
  );

  it.effect("brings an older pool's CLIProxyAPI up to the managed config once", () =>
    Effect.gen(function* () {
      const { pool, cliProxyApi } = makePool();
      yield* pool.create(alice, { name: "Work", personal: false });
      // A new pool's seeded config already has it.
      yield* signIn(pool);
      expect(cliProxyApi.configPatches).toEqual([]);

      const older = makePool();
      yield* older.pool.create(alice, { name: "Older", personal: false });
      // Seeded before a setting existed, it has no record of the managed config.
      yield* forget(older.runtime);
      yield* signIn(older.pool);
      expect(older.cliProxyApi.configPatches).toEqual([
        CliProxyApi.managedConfig(DEFAULT_POOL_ROUTING),
      ]);
      yield* signIn(older.pool);
      expect(older.cliProxyApi.configPatches).toHaveLength(1);
    }),
  );

  it.effect("keeps serving when the managed config can't be applied, and backs off", () =>
    Effect.gen(function* () {
      const { pool, cliProxyApi, runtime } = makePool();
      yield* pool.create(alice, { name: "Work", personal: false });
      yield* forget(runtime);
      const serve = cliProxyApi.serve;
      const patches: Array<string> = [];
      cliProxyApi.serve = (request) => {
        if (request.method !== "PATCH" || !new URL(request.url).pathname.endsWith("/config")) {
          return serve(request);
        }
        patches.push(request.url);
        return Promise.resolve(Response.json({ error: "invalid_config" }, { status: 500 }));
      };
      expect(yield* signIn(pool)).toEqual({ status: "ok" });
      // Not tried again on every request while it fails.
      yield* signIn(pool);
      expect(patches).toHaveLength(1);
    }),
  );

  it.effect("changes how it spreads turns in one call, applied to its CLIProxyAPI at once", () =>
    Effect.gen(function* () {
      const { pool, runtime, cliProxyApi, container } = makePool();
      yield* pool.create(alice, { name: "Work", personal: false });
      const routing = { strategy: "fill-first", sessionAffinity: false, moveOn: "quota" } as const;
      // A change names only what changes.
      yield* pool.setRouting(alice, { strategy: "fill-first" });
      expect(
        (yield* pool.setRouting(alice, { sessionAffinity: false, moveOn: "quota" })).routing,
      ).toEqual(routing);
      // An asleep pool isn't woken for it: the request that wakes it applies it first.
      expect(container.starts).toBe(0);
      expect(cliProxyApi.configPatches).toEqual([]);
      yield* signIn(pool);
      expect(cliProxyApi.configPatches).toEqual([CliProxyApi.managedConfig(routing)]);
      // A running pool applies a change at once, and nothing after it patches again.
      yield* pool.setRouting(alice, { strategy: "round-robin" });
      const roundRobin = { ...routing, strategy: "round-robin" } as const;
      expect(cliProxyApi.configPatches).toEqual([
        CliProxyApi.managedConfig(routing),
        CliProxyApi.managedConfig(roundRobin),
      ]);
      yield* signIn(pool);
      expect(cliProxyApi.configPatches).toHaveLength(2);
      expect((yield* pool.info(alice)).routing).toEqual(roundRobin);

      // Members neither see nor change it.
      yield* Effect.promise(() =>
        runtime.runPromise(
          SqlClient.SqlClient.use(
            (sql) => sql`INSERT INTO grants (user_id, role, granted_at)
              VALUES (${bob.userId}, 'member', 0)`,
          ),
        ),
      );
      expect((yield* pool.info(bob)).routing).toBeNull();
      expect((yield* Effect.flip(pool.setRouting(bob, { strategy: "fill-first" }))).message).toBe(
        "Only the pool's admins can do that.",
      );
    }),
  );

  it.effect("leaves the routing of a CLIProxyAPI its admin runs to its own config", () =>
    Effect.gen(function* () {
      const external = makeFakeCliProxyApi();
      const { pool } = makePool((request) => external.serve(request));
      yield* pool.create(alice, { name: "Mine", personal: false });
      yield* pool.setBacking(alice, {
        mode: "external",
        url: "https://proxy.example.test",
        managementKey: "management",
        clientKey: "client",
      });
      expect((yield* pool.info(alice)).routing).toBeNull();
      const refused = yield* Effect.flip(pool.setRouting(alice, DEFAULT_POOL_ROUTING));
      expect(refused.message).toBe(
        "This pool runs on your own CLIProxyAPI. Set its routing in that CLIProxyAPI's config.",
      );
      expect(external.configPatches).toEqual([]);
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

      // A pool that is already gone counts as deleted, so a retry clears the user's list.
      yield* makePool().pool.delete(alice);
    }),
  );

  it.effect("sends a member's model requests on with its own key, until they lose the pool", () =>
    Effect.gen(function* () {
      const { api, pool, runtime, container } = makePool();
      yield* pool.create(alice, { name: "Work", personal: false });
      const sql = <A>(run: (sql: SqlClient.SqlClient) => Effect.Effect<A, SqlError>) =>
        Effect.promise(() => runtime.runPromise(SqlClient.SqlClient.use(run)));
      yield* sql(
        (sql) => sql`INSERT INTO grants (user_id, role, granted_at)
        VALUES (${bob.userId}, 'member', 0)`,
      );
      const forward = () =>
        Effect.promise(() =>
          api.forwardModel(
            bob,
            "/v1/messages?beta=true",
            new Request("http://gateway.test/anthropic/v1/messages", {
              method: "POST",
              headers: { "anthropic-version": "2023-06-01" },
              body: '{"model":"claude-opus-5-5"}',
            }),
          ),
        );

      const reply = yield* forward();
      if (reply._tag !== "forwarded") throw new Error(`expected a response, got ${reply._tag}`);
      const [row] = yield* sql(
        (sql) => sql<{ readonly client_key: string }>`SELECT client_key FROM pool`,
      );
      expect(yield* Effect.promise(() => reply.response.json())).toEqual({
        path: "/v1/messages?beta=true",
        authorization: `Bearer ${row?.client_key}`,
        apiKey: null,
        body: '{"model":"claude-opus-5-5"}',
      });
      // A sleeping pool wakes for a turn.
      expect(container.starts).toBe(1);

      // Removed from the pool, the next request fails and says why.
      yield* sql((sql) => sql`DELETE FROM grants WHERE user_id = ${bob.userId}`);
      expect(yield* forward()).toEqual({
        _tag: "denied",
        reason: "You no longer have access to this thread's pool. Pick another pool for it.",
      });
    }),
  );
});
