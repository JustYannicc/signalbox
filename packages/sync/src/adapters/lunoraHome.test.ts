import { lunoraTest } from "@lunora/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { toErrorBody } from "lunorash/errors";
import { defineSchema, defineTable, initLunora, v } from "lunorash/server";
import { afterEach, describe, expect, expectTypeOf, it } from "vite-plus/test";

import { defineHome, SyncFailure, type AuthorizationFence } from "@signalbox/sync/definition";
import { table } from "@signalbox/sync/table";
import { makeLunoraHome } from "@signalbox/sync/adapters/lunoraHome";

const decodeDate = Schema.decodeSync(Schema.DateFromString);
const { internalAction } = initLunora.dataModel().create();
const actor = Schema.Struct({ id: Schema.String });
const home = Schema.Struct({ owner: Schema.String, level: Schema.String });
const counters = table({
  row: Schema.Struct({ key: Schema.String, value: Schema.Number }),
  key: ["key"],
  indexes: {},
});
const input = Schema.Struct({
  key: Schema.String,
  amount: Schema.Number,
  fence: Schema.optionalKey(Schema.Boolean),
  fail: Schema.optionalKey(Schema.Boolean),
});
const definition = defineHome(
  { actor, home, tables: { counters } },
  ({ view, change, projection }) => {
    const config = {
      input,
      output: Schema.Number,
      failure: Schema.Literal("failed"),
      run: (ctx: Parameters<Parameters<typeof projection>[0]["run"]>[0], args: typeof input.Type) =>
        Effect.gen(function* () {
          const row = yield* ctx.tables.counters.get(args.key);
          const value =
            Option.getOrElse(row, () => ({ key: args.key, value: 0 })).value + args.amount;
          if (Option.isSome(row)) yield* ctx.tables.counters.patch(args.key, { value });
          else yield* ctx.tables.counters.insert({ key: args.key, value });
          if (args.fence) yield* ctx.requireAuthorizationFence({ scope: "owner", epoch: 2 });
          if (args.fail) return yield* Effect.fail("failed" as const);
          return Option.getOrThrow(yield* ctx.tables.counters.get(args.key)).value;
        }),
    };
    return {
      views: {
        failed: view({
          input: Schema.Void,
          output: Schema.Void,
          failure: Schema.DateFromString,
          run: () => Effect.fail(decodeDate("2026-10-17T00:00:00.000Z")),
        }),
        value: view({
          input: Schema.String,
          output: Schema.Number,
          failure: Schema.Never,
          run: (ctx, key) =>
            Effect.map(
              ctx.tables.counters.get(key),
              (row) => Option.getOrElse(row, () => ({ value: 0 })).value,
            ),
        }),
      },
      changes: {
        increment: change(config),
        another: change(config),
        timestamp: change({
          input: Schema.DateFromString,
          output: Schema.DateFromString,
          failure: Schema.Never,
          run: (_ctx, value) => Effect.succeed(value),
        }),
        voidFailure: change({
          input: Schema.Void,
          output: Schema.Void,
          failure: Schema.Void,
          run: () => Effect.fail(undefined),
        }),
        dateFailure: change({
          input: Schema.Void,
          output: Schema.Void,
          failure: Schema.DateFromString,
          run: () => Effect.fail(decodeDate("2026-10-17T00:00:00.000Z")),
        }),
        invalidFailure: change({ ...config, failure: Schema.String.check(Schema.isMinLength(10)) }),
        invalidOutput: change({
          ...config,
          run: (ctx, args) => Effect.as(config.run(ctx, args), Number.NaN),
          output: Schema.Finite,
        }),
      },
      projections: {
        increment: projection(config),
        touch: projection({
          input: Schema.Void,
          output: Schema.Void,
          failure: Schema.Never,
          run: (ctx) => ctx.tables.counters.insert({ key: "touched", value: 1 }),
        }),
      },
    };
  },
);
const schema = defineSchema({
  counters: defineTable({ key: v.string(), value: v.number() }).index("__sync_key", ["key"]),
  syncReceipts: defineTable({
    scope: v.string(),
    operationKey: v.string(),
    payload: v.string(),
    value: v.string(),
    fences: v.array(v.object({ scope: v.string(), epoch: v.number() })),
    pending: v.boolean(),
  })
    .index("__sync_key", ["scope", "operationKey"])
    .index("pending", ["pending"]),
});
const opened: ReturnType<typeof lunoraTest>[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
function setup(level = "one", withRecovery = true) {
  const recovery = internalAction
    .input({ after: v.optional(v.union(v.string(), v.null())), home: v.any() })
    .action(({ args }) => recover(args.after));
  const db = lunoraTest(schema, { functions: { "sync:recover": recovery } });
  opened.push(db);
  let allowed = true;
  let epoch = 1;
  let installFails = false;
  let rejectedScope: string | undefined;
  const installed: AuthorizationFence[] = [];
  const authorizationCalls: string[] = [];
  const runtime = makeLunoraHome(
    definition,
    {
      home: { owner: "owner", level },
      authorization: {
        authorize: (person, request) =>
          Effect.suspend(() => {
            authorizationCalls.push(`${person.id}:${request.kind}`);
            return allowed
              ? Effect.succeed(epoch)
              : Effect.fail(new SyncFailure({ reason: "denied" }));
          }),
        isCurrent: (permit) => allowed && permit === epoch,
      },
      authorizeIngress: (source: { id: string; trusted: boolean }) =>
        source.trusted ? Effect.void : Effect.fail(new SyncFailure({ reason: "denied" })),
      completion: {
        install: (fence) =>
          Effect.suspend(() => {
            if (installFails || fence.scope === rejectedScope)
              return Effect.fail(new SyncFailure({ reason: "unavailable" }));
            installed.push(fence);
            return Effect.void;
          }),
      },
    },
    {
      ...(withRecovery ? { recoveryTarget: "sync:recover" } : {}),
      permitKey: String,
      actorKey: (person) => person.id,
      ingressKey: (source) => source.id,
    },
  );
  const change = (key: string, args: typeof input.Type, person = "alice") =>
    db.mutation((ctx) =>
      runtime.change("increment")({
        ctx,
        args: { actor: { id: person }, input: args, operationKey: key },
      }),
    );
  const read = () =>
    db.query((ctx) =>
      runtime.query("value")({ ctx, args: { actor: { id: "alice" }, input: "counter" } }),
    );
  const recover = (after: string | null = null) =>
    runtime.recoverFences(
      {
        pending: (after) => db.query((ctx) => runtime.pendingFences({ ctx, after })),
        scheduleNext: (after) =>
          db.mutation((ctx) => runtime.scheduleFenceRecovery({ ctx, after })),
        acknowledge: (receipt) => db.mutation((ctx) => runtime.acknowledgeFence({ ctx, receipt })),
      },
      after,
    );
  return {
    db,
    runtime,
    change,
    read,
    recover,
    installed,
    authorizationCalls,
    deny: () => {
      allowed = false;
    },
    allow: () => {
      allowed = true;
      epoch += 1;
    },
    failScope: (scope: string) => {
      rejectedScope = scope;
    },
    failInstall: (value: boolean) => {
      installFails = value;
    },
  };
}

describe("Lunora home operation transactions", () => {
  it("commits rows and receipt together, reads its writes, and replays canonical input once", async () => {
    const t = setup();
    const first = await t.change("op", { key: "counter", amount: 3 });
    expect(first).toMatchObject({ _tag: "Committed", value: 3 });
    expect(await t.change("op", { amount: 3, key: "counter" })).toEqual(first);
    expect(await t.read()).toBe(3);
    expect(t.authorizationCalls).toContain("alice:receipt");
    await expect(t.change("op", { key: "counter", amount: 4 })).rejects.toMatchObject({
      reason: "operation_conflict",
    });
    await expect(
      t.db.mutation((ctx) =>
        t.runtime.change("another")({
          ctx,
          args: {
            actor: { id: "alice" },
            input: { key: "counter", amount: 3 },
            operationKey: "op",
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "operation_conflict" });
  });

  it("serializes concurrent duplicate deliveries through the engine transaction", async () => {
    const t = setup();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => t.change("same-key", { key: "counter", amount: 2 })),
    );
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(
      true,
    );
    expect(await t.read()).toBe(2);
  });

  it("rolls back rows, receipts and pending fences when a domain handler fails", async () => {
    const t = setup();
    await expect(
      t.change("retry", { key: "counter", amount: 3, fence: true, fail: true }),
    ).rejects.toBe("failed");
    expect(await t.read()).toBe(0);
    expect(await t.db.query((ctx) => ctx.db.query("syncReceipts").collect())).toHaveLength(0);
    expect(await t.change("retry", { key: "counter", amount: 3 })).toMatchObject({
      _tag: "Committed",
      value: 3,
    });
  });

  it("reauthorizes the actual person before returning saved output", async () => {
    const t = setup();
    await t.change("op", { key: "counter", amount: 3 });
    t.deny();
    await expect(t.change("op", { key: "counter", amount: 3 })).rejects.toMatchObject({
      reason: "denied",
    });
    t.allow();
    expect(await t.change("op", { key: "counter", amount: 3 }, "bob")).toMatchObject({
      _tag: "Committed",
      value: 6,
    });
  });

  it("keeps committed fences Pending across failed installation and crash before ack", async () => {
    const t = setup();
    const args = { key: "counter", amount: 3, fence: true };
    expect(await t.change("op", args)).toEqual({ _tag: "Pending", operationKey: "op" });
    expect(await t.read()).toBe(3);
    expect(t.installed).toEqual([]);
    t.failInstall(true);
    expect(await t.recover()).toEqual({ _tag: "Pending" });
    expect(await t.change("op", args)).toEqual({ _tag: "Pending", operationKey: "op" });
    t.failInstall(false);
    await expect(
      t.runtime.recoverFences({
        pending: (after) => t.db.query((ctx) => t.runtime.pendingFences({ ctx, after })),
        scheduleNext: (after) =>
          t.db.mutation((ctx) => t.runtime.scheduleFenceRecovery({ ctx, after })),
        acknowledge: async () => {
          throw new Error("crash before ack");
        },
      }),
    ).resolves.toEqual({ _tag: "Pending" });
    expect(await t.change("op", args)).toEqual({ _tag: "Pending", operationKey: "op" });
    await t.recover();
    expect(await t.change("op", args)).toMatchObject({ _tag: "Committed", value: 3 });
    expect(t.installed).toHaveLength(2);
  });

  it("automatically schedules fence recovery after commit and retries a failed installation", async () => {
    const t = setup();
    const args = { key: "counter", amount: 2, fence: true };
    expect(await t.change("automatic", args)).toEqual({
      _tag: "Pending",
      operationKey: "automatic",
    });
    expect(t.installed).toHaveLength(0);
    expect(t.db.scheduler.list()).toHaveLength(1);
    t.failInstall(true);
    await t.db.scheduler.runPending();
    expect(t.db.scheduler.list().length).toBeGreaterThan(0);
    expect(await t.change("automatic", args)).toEqual({
      _tag: "Pending",
      operationKey: "automatic",
    });
    t.failInstall(false);
    await t.db.scheduler.runPending();
    expect(await t.change("automatic", args)).toMatchObject({ _tag: "Committed", value: 2 });
    await t.db.scheduler.runPending();
    expect(t.db.scheduler.list()).toHaveLength(0);
  });

  it("keeps one durable successor beyond the native retry budget", async () => {
    const t = setup();
    const args = { key: "counter", amount: 2, fence: true };
    t.failInstall(true);
    await t.change("long-outage", args);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await t.db.scheduler.runPending();
      expect(t.db.scheduler.list()).toHaveLength(1);
    }
    expect(t.db.scheduler.failures()).toHaveLength(0);
    t.failInstall(false);
    await t.db.scheduler.runPending();
    await t.db.scheduler.runPending();
    expect(t.db.scheduler.list()).toHaveLength(0);
    expect(await t.change("long-outage", args)).toMatchObject({ _tag: "Committed", value: 2 });
  });

  it("advances past a failed first page and reports remaining durable work", async () => {
    const t = setup();
    t.failScope("poison");
    await t.db.mutation(async (ctx) => {
      for (let i = 0; i < 101; i += 1)
        await ctx.db.insert("syncReceipts", {
          scope: "fixture",
          operationKey: String(i),
          payload: "[]",
          value: "{}",
          pending: true,
          fences: [{ scope: "poison", epoch: 2 }],
        });
    });
    const firstPage = await t.db.query((ctx) => t.runtime.pendingFences({ ctx }));
    const tail = await t.db.query((ctx) =>
      t.runtime.pendingFences({ ctx, after: firstPage.after }),
    );
    const firstHealthy = firstPage.receipts[0];
    const nextHealthy = tail.receipts[0];
    if (firstHealthy === undefined || nextHealthy === undefined)
      throw new Error("Expected two pages");
    await t.db.mutation(async (ctx) => {
      for (const entry of [firstHealthy, nextHealthy])
        await ctx.db.patch(ctx.db.asId("syncReceipts", entry.receipt), {
          fences: [{ scope: "healthy", epoch: 2 }],
        });
    });
    expect(await t.recover()).toEqual({ _tag: "Pending" });
    expect(t.installed).toHaveLength(1);
    await t.db.scheduler.runPending();
    expect(t.installed).toHaveLength(2);
    const remaining = await t.db.query((ctx) => t.runtime.pendingFences({ ctx }));
    expect(remaining.receipts).toHaveLength(99);
    expect(t.db.scheduler.list()).toHaveLength(1);
  });

  it("does not claim Drained after only the first successful recovery page", async () => {
    const t = setup();
    await t.db.mutation(async (ctx) => {
      for (let i = 0; i < 101; i += 1)
        await ctx.db.insert("syncReceipts", {
          scope: "fixture",
          operationKey: String(i),
          payload: "[]",
          value: "{}",
          pending: true,
          fences: [{ scope: "healthy", epoch: 2 }],
        });
    });
    expect(await t.recover()).toEqual({ _tag: "Pending" });
    expect(t.installed).toHaveLength(100);
    await t.db.scheduler.runPending();
    expect(t.installed).toHaveLength(101);
    expect(await t.recover()).toEqual({ _tag: "Drained" });
  });

  it("rolls back policy, receipt and scheduling if the mutation cannot commit", async () => {
    const args = {
      actor: { id: "alice" },
      input: { key: "counter", amount: 2, fence: true },
      operationKey: "rollback",
    };
    const missing = setup("missing", false);
    await expect(
      missing.db.mutation((ctx) => missing.runtime.change("increment")({ ctx, args })),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(await missing.read()).toBe(0);
    const t = setup();
    await expect(
      t.db.mutation(async (ctx) => {
        await t.runtime.change("increment")({ ctx, args });
        throw new Error("failure after scheduling");
      }),
    ).rejects.toThrow("failure after scheduling");
    expect(t.db.scheduler.list()).toHaveLength(0);
    expect(await t.read()).toBe(0);
    await expect(
      t.db.mutation((ctx) =>
        t.runtime.change("increment")({
          ctx: {
            db: ctx.db,
            scheduler: {
              runAfter: async () => {
                throw new Error("outbox write failed");
              },
            },
          },
          args,
        }),
      ),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(await t.read()).toBe(0);
    expect(await t.db.query((ctx) => ctx.db.query("syncReceipts").collect())).toHaveLength(0);
  });

  it("separates projection sources, actors and homes, and checks trusted ingress on replay", async () => {
    const t = setup();
    const other = setup("other");
    const project = (source: string, trusted = true) =>
      t.db.mutation((ctx) =>
        t.runtime.projection("increment")({
          ctx,
          args: {
            ingress: { id: source, trusted },
            input: { key: "counter", amount: 2 },
            operationKey: "op",
          },
        }),
      );
    const first = await project("source1");
    expect(await project("source1")).toEqual(first);
    await expect(project("source1", false)).rejects.toMatchObject({ reason: "denied" });
    expect(await project("source2")).toMatchObject({ value: 4 });
    expect(await t.change("op", { key: "counter", amount: 2 })).toMatchObject({ value: 6 });
    expect(await other.change("op", { key: "counter", amount: 2 })).toMatchObject({ value: 2 });
  });

  it("encodes codec inputs and outputs durably and decodes them on exact replay", async () => {
    const t = setup();
    const invoke = () =>
      t.db.mutation((ctx) =>
        t.runtime.change("timestamp")({
          ctx,
          args: {
            actor: { id: "alice" },
            input: decodeDate("2026-10-17T00:00:00.000Z"),
            operationKey: "date",
          },
        }),
      );
    const first = await invoke();
    const replay = await invoke();
    expect(replay).toEqual(first);
    if (replay._tag === "Committed") {
      expectTypeOf(replay.value).toEqualTypeOf<Date>();
      expect(replay.value).toBeInstanceOf(Date);
      expect(replay.value.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    }
  });

  it("commits and replays a void projection input and output", async () => {
    const t = setup();
    const invoke = () =>
      t.db.mutation((ctx) =>
        t.runtime.projection("touch")({
          ctx,
          args: {
            ingress: { id: "source", trusted: true },
            input: undefined,
            operationKey: "void",
          },
        }),
      );
    const first = await invoke();
    expect(first).toMatchObject({ _tag: "Committed", value: undefined });
    await expect(
      t.db.mutation((ctx) =>
        t.runtime.projection("touch")({
          ctx,
          args: {
            ingress: { id: "source", trusted: true },
            input: undefined,
            operationKey: "another-void",
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_state" });
    expect(await invoke()).toEqual(first);
    expect(await t.db.query((ctx) => ctx.db.query("counters").collect())).toHaveLength(1);
  });

  it("returns encoded declared view failures through the typed wire envelope", async () => {
    const t = setup();
    const result = await t.db.query((ctx) =>
      t.runtime.observe("failed")({ ctx, args: { actor: { id: "alice" }, input: undefined } }),
    );
    expect(result).toEqual({
      _tag: "Failure",
      failure: { defined: true, value: "2026-10-17T00:00:00.000Z" },
    });
    expect(Schema.is(t.runtime.observeOutput("failed"))(result)).toBe(true);
    if (result._tag === "Failure" && result.failure.defined)
      expectTypeOf(result.failure.value).toEqualTypeOf<string>();
  });

  it("binds continuation to the actor, home and query while reauthorizing fresh state", async () => {
    const t = setup();
    const observe = (
      person = "alice",
      key = "counter",
      resume?: import("@signalbox/sync/definition").SyncCursor,
    ) =>
      t.db
        .query((ctx) =>
          t.runtime.observe("value")({
            ctx,
            args: {
              actor: { id: person },
              input: key,
              ...(resume === undefined ? {} : { resume }),
            },
          }),
        )
        .then((frame) => {
          if (frame._tag !== "Value") throw new Error("Expected a value frame");
          return frame;
        });
    const wireSchema = t.runtime.observeOutput("value");
    expectTypeOf<typeof wireSchema.Type>().toEqualTypeOf<
      | {
          readonly _tag: "Value";
          readonly value:
            | { readonly defined: false }
            | { readonly defined: true; readonly value: number };
          readonly cursor: import("@signalbox/sync/definition").SyncCursor;
        }
      | {
          readonly _tag: "Failure";
          readonly failure:
            | { readonly defined: false }
            | { readonly defined: true; readonly value: never };
        }
    >();
    const first = await observe();
    expect(first.value).toEqual({ defined: true, value: 0 });
    await t.change("op", { key: "counter", amount: 3 });
    expect((await observe("alice", "counter", first.cursor)).value).toEqual({
      defined: true,
      value: 3,
    });
    await expect(observe("bob", "counter", first.cursor)).rejects.toMatchObject({
      reason: "invalid_cursor",
    });
    await expect(observe("alice", "different", first.cursor)).rejects.toMatchObject({
      reason: "invalid_cursor",
    });
    const other = setup("other");
    await expect(
      other.db.query((ctx) =>
        other.runtime.observe("value")({
          ctx,
          args: {
            actor: { id: "alice" },
            input: "counter",
            resume: first.cursor,
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_cursor" });
    t.allow();
    const nextEpoch = await observe("alice", "counter", first.cursor);
    expect(nextEpoch.cursor).not.toBe(first.cursor);
    expect(nextEpoch.value).toEqual({ defined: true, value: 3 });
    t.deny();
    await expect(observe("alice", "counter", first.cursor)).rejects.toMatchObject({
      reason: "denied",
    });
  });

  it("checks the authorization permit again after an awaited query", async () => {
    const t = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let current = true;
    const waiting = defineHome({ actor, home, tables: {} }, ({ view }) => ({
      views: {
        value: view({
          input: Schema.Void,
          output: Schema.Number,
          failure: Schema.Never,
          run: () =>
            Effect.gen(function* () {
              yield* Effect.sync(() => entered.resolve());
              yield* Effect.promise(() => release.promise);
              return 42;
            }),
        }),
      },
      changes: {},
      projections: {},
    }));
    const runtime = makeLunoraHome(
      waiting,
      {
        home: { owner: "owner", level: "one" },
        authorization: { authorize: () => Effect.void, isCurrent: () => current },
        authorizeIngress: (_ingress: string) => Effect.void,
        completion: { install: () => Effect.void },
      },
      { actorKey: (person) => person.id, ingressKey: (source) => source, permitKey: () => "epoch" },
    );
    const result = t.db.query((ctx) =>
      runtime.observe("value")({ ctx, args: { actor: { id: "alice" }, input: undefined } }),
    );
    const denied = expect(result).rejects.toMatchObject({ reason: "denied" });
    await entered.promise;
    current = false;
    release.resolve();
    await denied;
  });

  it("preserves mutation rollback while encoding domain failures into native error data", async () => {
    const t = setup();
    const failure = await t.db
      .mutation((ctx) =>
        t.runtime.changeWire("increment")({
          ctx,
          args: {
            actor: { id: "alice" },
            input: { key: "counter", amount: 3, fail: true },
            operationKey: "wire-failed",
          },
        }),
      )
      .then(
        () => {
          throw new Error("Expected mutation failure");
        },
        (error: unknown) => error,
      );
    const wire = toErrorBody(failure, { encodeData: (data) => data });
    expect(wire.body).toMatchObject({
      code: "SYNC_DOMAIN_FAILURE",
      data: { _tag: "SyncDomainFailure", failure: { defined: true, value: "failed" } },
    });
    expect(await t.read()).toBe(0);
    expect(await t.db.query((ctx) => ctx.db.query("syncReceipts").collect())).toHaveLength(0);
    const dateFailure = await t.db
      .mutation((ctx) =>
        t.runtime.changeWire("dateFailure")({
          ctx,
          args: { actor: { id: "alice" }, input: undefined, operationKey: "date-failure" },
        }),
      )
      .then(
        () => {
          throw new Error("Expected failure");
        },
        (error: unknown) => error,
      );
    expect(toErrorBody(dateFailure, { encodeData: (data) => data }).body).toMatchObject({
      code: "SYNC_DOMAIN_FAILURE",
      data: { failure: { defined: true, value: "2026-10-17T00:00:00.000Z" } },
    });
    const voidFailure = await t.db
      .mutation((ctx) =>
        t.runtime.changeWire("voidFailure")({
          ctx,
          args: { actor: { id: "alice" }, input: undefined, operationKey: "void-failure" },
        }),
      )
      .then(
        () => {
          throw new Error("Expected failure");
        },
        (error: unknown) => error,
      );
    expect(toErrorBody(voidFailure, { encodeData: (data) => data }).body).toMatchObject({
      code: "SYNC_DOMAIN_FAILURE",
      data: { _tag: "SyncDomainFailure", failure: { defined: false } },
    });
    t.deny();
    await expect(
      t.db.mutation((ctx) =>
        t.runtime.changeWire("increment")({
          ctx,
          args: {
            actor: { id: "alice" },
            input: { key: "counter", amount: 3 },
            operationKey: "denied",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", data: { _tag: "SyncFailure", reason: "denied" } });
    await expect(
      t.db.query((ctx) =>
        t.runtime.observeWire("value")({ ctx, args: { actor: { id: "alice" }, input: "counter" } }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", data: { _tag: "SyncFailure", reason: "denied" } });
  });

  it("returns encoded typed commits including Date and Void values", async () => {
    const t = setup();
    const date = await t.db.mutation((ctx) =>
      t.runtime.changeWire("timestamp")({
        ctx,
        args: {
          actor: { id: "alice" },
          input: decodeDate("2026-10-17T00:00:00.000Z"),
          operationKey: "wire-date",
        },
      }),
    );
    expect(date).toMatchObject({
      _tag: "Committed",
      value: { defined: true, value: "2026-10-17T00:00:00.000Z" },
    });
    if (date._tag === "Committed" && date.value.defined)
      expectTypeOf(date.value.value).toEqualTypeOf<string>();
    expect(Schema.is(t.runtime.changeOutput("timestamp"))(date)).toBe(true);
    const invoke = () =>
      t.db.mutation((ctx) =>
        t.runtime.projectionWire("touch")({
          ctx,
          args: {
            ingress: { id: "source", trusted: true },
            input: undefined,
            operationKey: "wire-void",
          },
        }),
      );
    const first = await invoke();
    expect(first).toMatchObject({ _tag: "Committed", value: { defined: false } });
    expect(Schema.is(t.runtime.projectionOutput("touch"))(first)).toBe(true);
    expect(await invoke()).toEqual(first);
    await expect(
      t.db.mutation((ctx) =>
        t.runtime.projectionWire("touch")({
          ctx,
          args: {
            ingress: { id: "source", trusted: true },
            input: undefined,
            operationKey: "different",
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "SYNC_FAILURE",
      data: { _tag: "SyncFailure", reason: "invalid_state" },
    });
  });

  it("rolls back if authorization changes during durable or final wire encoding", async () => {
    for (const wire of [false, true]) {
      const t = setup();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let allowed = true;
      let encodings = 0;
      const output = Schema.Number.pipe(
        Schema.decodeTo(
          Schema.Number,
          SchemaTransformation.transformEffect({
            decode: (value) => Effect.succeed(value),
            encode: (value) =>
              Effect.promise(async () => {
                encodings += 1;
                if (encodings === (wire ? 2 : 1)) {
                  entered.resolve();
                  await release.promise;
                }
                return value;
              }),
          }),
        ),
      );
      const waiting = defineHome({ actor, home, tables: { counters } }, ({ change }) => ({
        views: {},
        projections: {},
        changes: {
          write: change({
            input: Schema.Void,
            output,
            failure: Schema.Never,
            run: (ctx) => Effect.as(ctx.tables.counters.insert({ key: "counter", value: 42 }), 42),
          }),
        },
      }));
      const runtime = makeLunoraHome(
        waiting,
        {
          home: { owner: "owner", level: "one" },
          authorization: {
            authorize: () =>
              allowed ? Effect.void : Effect.fail(new SyncFailure({ reason: "denied" })),
            isCurrent: () => allowed,
          },
          authorizeIngress: (_ingress: string) => Effect.void,
          completion: { install: () => Effect.void },
        },
        {
          actorKey: (person) => person.id,
          ingressKey: (source) => source,
          permitKey: () => "epoch",
        },
      );
      const handler = wire ? runtime.changeWire("write") : runtime.change("write");
      const mutation = t.db.mutation(
        async (ctx) =>
          await handler({
            ctx,
            args: { actor: { id: "alice" }, input: undefined, operationKey: "paused" },
          }),
      );
      const denied = expect(mutation).rejects.toMatchObject(
        wire ? { code: "FORBIDDEN" } : { reason: "denied" },
      );
      await entered.promise;
      allowed = false;
      release.resolve();
      await denied;
      expect(await t.db.query((ctx) => ctx.db.query("counters").collect())).toHaveLength(0);
      expect(await t.db.query((ctx) => ctx.db.query("syncReceipts").collect())).toHaveLength(0);
    }
  });

  it("reports corrupt stored receipt JSON as storage_corrupt", async () => {
    const t = setup();
    await t.change("corrupt", { key: "counter", amount: 1 });
    await t.db.mutation(async (ctx) => {
      const receipt = await ctx.db.query("syncReceipts").first();
      if (receipt === null || typeof receipt._id !== "string") throw new Error("Expected receipt");
      await ctx.db.patch(ctx.db.asId("syncReceipts", receipt._id), { value: "not json" });
    });
    await expect(t.change("corrupt", { key: "counter", amount: 1 })).rejects.toMatchObject({
      reason: "storage_corrupt",
    });
  });

  it("rejects invalid inputs and outputs without leaving rows or receipts", async () => {
    const t = setup();
    await expect(t.change("bad", { key: "counter", amount: Number.NaN })).rejects.toMatchObject({
      reason: "invalid_input",
    });
    await expect(
      t.db.mutation((ctx) =>
        t.runtime.change("invalidOutput")({
          ctx,
          args: {
            actor: { id: "alice" },
            input: { key: "counter", amount: 3 },
            operationKey: "bad-output",
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await expect(
      t.db.mutation((ctx) =>
        t.runtime.change("invalidFailure")({
          ctx,
          args: {
            actor: { id: "alice" },
            input: { key: "counter", amount: 3, fail: true },
            operationKey: "bad-failure",
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(await t.read()).toBe(0);
    expect(await t.db.query((ctx) => ctx.db.query("syncReceipts").collect())).toHaveLength(0);
  });
});
