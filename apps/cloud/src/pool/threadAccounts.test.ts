// @effect-diagnostics globalDate:off globalDateInEffect:off - the fake CLIProxyAPI holds accounts on the wall clock.
import { describe, expect, it } from "@effect/vitest";
import { POOL_LINK_PATH } from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as CliProxyApi from "./cliProxyApi.ts";
import * as PoolContainer from "./PoolContainer.ts";
import { handleFor } from "./PoolDirectory.ts";
import { decodeLinkToken, encodeLinkToken } from "./poolLink.ts";
import { makeMemoryPoolObject } from "./testing.ts";

const alice = { userId: "user_alice" };

/** A pool with two Claude accounts, and a thread's model request through it. */
const twoAccountPool = (external?: (request: Request) => Promise<Response>) =>
  Effect.gen(function* () {
    const object = makeMemoryPoolObject(external);
    const pool = handleFor(object.api);
    yield* pool.create(alice, { name: "Work", personal: false });
    for (const _ of [1, 2]) {
      const login = yield* pool.startLogin(alice, "claude");
      yield* pool.completeLogin(alice, `http://x/cb?code=c&state=${login.state}`);
      yield* pool.loginStatus(alice, login.state);
    }
    const [first, second] = [...object.cliProxyApi.accounts.keys()];
    return { ...object, pool, first: first!, second: second!, ...requests(object.api) };
  });

/** A thread's turn asking the pool for a model, and what the pool's CLIProxyAPI got. */
const requests = (api: ReturnType<typeof makeMemoryPoolObject>["api"]) => ({
  ask: (thread: string | undefined, path = "/v1/messages") =>
    Effect.promise(async () => {
      const reply = await api.forwardModel(
        alice,
        path,
        new Request(`http://gateway.test${path}`, {
          method: "POST",
          headers: { "x-claude-code-session-id": "session-1" },
          body: '{"model":"claude-opus-5-5","stream":true}',
        }),
        thread,
      );
      if (reply._tag !== "forwarded") throw new Error(`expected a response, got ${reply._tag}`);
      const { response } = reply;
      const echoed = response.ok ? ((await response.json()) as { readonly body: string }) : null;
      if (!response.ok) await response.body?.cancel();
      return {
        status: response.status,
        account: response.headers.get("x-fake-account"),
        model: echoed === null ? null : (JSON.parse(echoed.body) as { model: string }).model,
        moved: reply.accountMoved ?? null,
      };
    }),
});

/** The pool's container sleeping, as it does two minutes after its last request. */
const sleep = (runtime: ReturnType<typeof makeMemoryPoolObject>["runtime"]) =>
  Effect.promise(() =>
    runtime.runPromise(PoolContainer.PoolContainer.use((container) => container.stop)),
  );

const moves = (runtime: ReturnType<typeof makeMemoryPoolObject>["runtime"]) =>
  Effect.promise(() =>
    runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) =>
          sql<{
            readonly detail: string | null;
          }>`SELECT detail FROM audit WHERE action = 'move-thread' ORDER BY seq`,
      ),
    ),
  ).pipe(Effect.map((rows) => rows.map((row) => row.detail)));

describe("an account's pin", () => {
  it("routes a model to one account, through CLIProxyAPI's alias for non-Claude ids", () => {
    expect(CliProxyApi.pinnedModel("58c4", "claude-opus-5-5")).toBe("sb-58c4/claude-opus-5-5");
    // Claude Code asks for a GPT model by the alias the Anthropic-shaped list gave it.
    expect(CliProxyApi.pinnedModel("58c4", "claude-fable-5-dd-ats-6-tpg(high)")).toBe(
      "sb-58c4/gpt-6-sta(high)",
    );
  });

  it("is hidden from model lists in either shape", () => {
    expect(CliProxyApi.isPinnedModel("sb-58c4/claude-opus-5-5")).toBe(true);
    expect(CliProxyApi.isPinnedModel("claude-fable-5-dd-5-5-supo-edualc/4c85-bs")).toBe(true);
    expect(CliProxyApi.isPinnedModel("claude-fable-5-dd-ats-6-tpg")).toBe(false);
    expect(CliProxyApi.isPinnedModel("claude-opus-5-5")).toBe(false);
  });
});

describe("a thread's pooled account", () => {
  it.effect("stays the same when the pool's container sleeps between turns", () =>
    Effect.gen(function* () {
      const { ask, runtime, first, second } = yield* twoAccountPool();
      // Each thread's first request goes where CLIProxyAPI's round robin sends it.
      expect((yield* ask("thread-1")).account).toBe(first);
      expect((yield* ask("thread-2")).account).toBe(second);

      // Asleep, CLIProxyAPI forgets its session affinity. The pool doesn't.
      yield* sleep(runtime);
      const resumed = yield* ask("thread-2");
      expect(resumed).toMatchObject({ status: 200, account: second, moved: null });
      // The provider still sees the model the harness asked for (CLIProxyAPI drops the pin).
      expect(resumed.model).toMatch(/\/claude-opus-5-5$/u);
      expect((yield* ask("thread-1")).account).toBe(first);
      expect((yield* ask("thread-1")).account).toBe(first);
    }),
  );

  it.effect("moves to another account when its own is cooling down, and says so", () =>
    Effect.gen(function* () {
      const { ask, runtime, cliProxyApi, first, second } = yield* twoAccountPool();
      expect((yield* ask("thread-1")).account).toBe(first);
      cliProxyApi.accounts.get(first)!.cooldownUntil = new Date(
        Date.now() + 3_600_000,
      ).toISOString();

      const moved = yield* ask("thread-1");
      expect(moved).toMatchObject({ status: 200, account: second });
      expect(moved.moved).toBe(
        "This thread's account hit its usage limit, so the thread moved to another account in the pool. Its next reply starts without the provider's cache.",
      );
      // It stays on the new account, even once the old one has room again.
      delete cliProxyApi.accounts.get(first)!.cooldownUntil;
      expect(yield* ask("thread-1")).toMatchObject({ account: second, moved: null });
      expect(yield* moves(runtime)).toEqual([`thread-1: ${first} → ${second} (usage limit)`]);
    }),
  );

  it.effect("moves when its account is paused or leaves the pool, and says so", () =>
    Effect.gen(function* () {
      const { ask, pool, first, second } = yield* twoAccountPool();
      expect((yield* ask("thread-1")).account).toBe(first);
      expect((yield* ask("thread-2")).account).toBe(second);

      yield* pool.updateAccount(alice, first, "pause");
      expect(yield* ask("thread-1")).toMatchObject({
        account: second,
        moved:
          "This thread's account was paused, so the thread moved to another account in the pool. Its next reply starts without the provider's cache.",
      });

      yield* pool.updateAccount(alice, first, "resume");
      yield* pool.updateAccount(alice, second, "remove");
      expect(yield* ask("thread-2")).toMatchObject({
        account: first,
        moved:
          "This thread's account left the pool, so the thread moved to another account in the pool. Its next reply starts without the provider's cache.",
      });
    }),
  );

  it.effect("is left to CLIProxyAPI when the admins turn session affinity off", () =>
    Effect.gen(function* () {
      const { ask, pool, first, second } = yield* twoAccountPool();
      yield* pool.setRouting(alice, { sessionAffinity: false });
      expect((yield* ask("thread-1")).account).toBe(first);
      const next = yield* ask("thread-1");
      expect(next).toMatchObject({ account: second, model: "claude-opus-5-5" });
    }),
  );

  it.effect("never shows the pins in the model lists", () =>
    Effect.gen(function* () {
      const { ask, pool, api } = yield* twoAccountPool();
      yield* ask("thread-1");
      yield* ask("thread-1");
      const listed = yield* Effect.promise(async () => {
        const reply = await api.forwardModel(
          alice,
          "/v1/models",
          new Request("http://gateway.test/v1/models"),
          "thread-1",
        );
        if (reply._tag !== "forwarded") throw new Error(reply._tag);
        return ((await reply.response.json()) as { data: Array<{ id: string }> }).data;
      });
      expect(listed.map((model) => model.id)).not.toContainEqual(expect.stringContaining("/"));
      expect(listed.length).toBeGreaterThan(0);
      const { models } = yield* pool.models(alice);
      expect(models.map((model) => model.id)).not.toContainEqual(expect.stringContaining("/"));
    }),
  );

  it.effect("is kept by the pool a preview's link runs on", () =>
    Effect.gen(function* () {
      const prod = yield* twoAccountPool();
      const secret = yield* prod.pool.openLink(alice);
      const token = encodeLinkToken("prod-pool", secret);
      // The preview's pool reaches production's through the link, as the Worker routes it.
      const preview = makeMemoryPoolObject((request) => {
        const auth = request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "";
        const decoded = decodeLinkToken(auth);
        if (decoded === null) return Promise.resolve(new Response(null, { status: 401 }));
        return prod.api.linkFetch(decoded.secret, request);
      });
      const previewPool = handleFor(preview.api);
      yield* previewPool.create(alice, { name: "Work", personal: false });
      yield* previewPool.setBacking(alice, {
        mode: "external",
        url: `https://app.signalbox.test${POOL_LINK_PATH}`,
        managementKey: token,
        clientKey: token,
      });
      const { ask } = requests(preview.api);
      expect((yield* ask("thread-1")).account).toBe(prod.first);
      yield* sleep(prod.runtime);
      expect((yield* ask("thread-2")).account).toBe(prod.second);
      expect((yield* ask("thread-1")).account).toBe(prod.first);

      // A move made where the accounts live is said on the preview's thread.
      prod.cliProxyApi.accounts.get(prod.first)!.cooldownUntil = new Date(
        Date.now() + 3_600_000,
      ).toISOString();
      expect(yield* ask("thread-1")).toMatchObject({
        account: prod.second,
        moved: expect.stringContaining("usage limit"),
      });
    }),
  );

  it.effect("passes a bound thread's requests that run no turn as they are", () =>
    Effect.gen(function* () {
      const { ask, api } = yield* twoAccountPool();
      yield* ask("thread-1", "/v1/responses");
      const reply = yield* Effect.promise(() =>
        api.forwardModel(
          alice,
          "/v1/responses/resp_1",
          new Request("http://gateway.test/v1/responses/resp_1"),
          "thread-1",
        ),
      );
      if (reply._tag !== "forwarded") throw new Error(reply._tag);
      expect(reply.response.status).toBe(200);
      expect(((yield* Effect.promise(() => reply.response.json())) as { body: string }).body).toBe(
        "",
      );
    }),
  );

  it.effect("is never pinned for requests that name no thread", () =>
    Effect.gen(function* () {
      const { ask, cliProxyApi, first, second } = yield* twoAccountPool();
      expect((yield* ask(undefined)).account).toBe(first);
      expect((yield* ask(undefined)).account).toBe(second);
      expect([...cliProxyApi.accounts.values()].every((a) => a.prefix === undefined)).toBe(true);
    }),
  );
});
