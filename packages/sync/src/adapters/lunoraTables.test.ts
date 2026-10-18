import { lunoraTest } from "@lunora/testing";
import { makeLunoraHome } from "@signalbox/sync/adapters/lunoraHome";
import { defineHome } from "@signalbox/sync/definition";
import { pageCursorSchema, table, type TableError } from "@signalbox/sync/table";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { defineSchema, defineTable, v } from "lunorash/server";
import { afterEach, describe, expect, it } from "vite-plus/test";

const items = table({
  row: Schema.Struct({
    tenant: Schema.String,
    key: Schema.String,
    email: Schema.String.check(Schema.isMinLength(3)),
    rank: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    note: Schema.optionalKey(Schema.String),
  }),
  key: ["tenant", "key"],
  indexes: {
    by_email: { fields: ["email"], unique: true },
    by_rank: { fields: ["tenant", "rank"] },
  },
});
const domainIdRows = table({
  row: Schema.Struct({
    id: Schema.String,
    parentId: Schema.String,
    position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    label: Schema.String,
  }),
  key: ["id"],
  indexes: { byParent: { fields: ["parentId", "position", "id"] } },
});
const row = (key: string, rank = 0) => ({ tenant: "a", key, email: `${key}@example.com`, rank });
const key = (key: string) => ({ tenant: "a", key });
const folder = (id: string, position: number, label: string) => ({
  id,
  parentId: "top",
  position,
  label,
});
const rankCursor = pageCursorSchema(items, "by_rank");
const emailCursor = pageCursorSchema(items, "by_email");
const decodeRankCursor = Schema.decodeUnknownSync(rankCursor);
const decodeEmailCursor = Schema.decodeUnknownSync(emailCursor);
const pageInput = Schema.Struct({
  prefix: Schema.Tuple([Schema.String]),
  range: Schema.optionalKey(Schema.Struct({ from: Schema.Number, to: Schema.Number })),
  limit: Schema.Number,
  order: Schema.optionalKey(Schema.Literals(["asc", "desc"])),
  after: Schema.optionalKey(rankCursor),
});
const pageOutput = Schema.Struct({
  rows: Schema.Array(items.row),
  after: Schema.UndefinedOr(rankCursor),
});
const failureReason = <A>(effect: Effect.Effect<A, TableError>) =>
  Effect.map(Effect.result(effect), (result) =>
    Result.isFailure(result) ? result.failure.reason : "unexpected_success",
  );

const definition = defineHome(
  { actor: Schema.String, home: Schema.String, tables: { items, domainIdRows } },
  ({ view, change }) => ({
    views: {
      page: view({
        input: pageInput,
        output: pageOutput,
        failure: Schema.Never,
        run: (ctx, input) => ctx.tables.items.page("by_rank", input),
      }),
      exactRank: view({
        input: Schema.Number,
        output: pageOutput,
        failure: Schema.Never,
        run: (ctx, rank) => ctx.tables.items.page("by_rank", { prefix: ["a", rank], limit: 2 }),
      }),
      invalidPages: view({
        input: Schema.Void,
        output: Schema.Array(Schema.String),
        failure: Schema.Never,
        run: (ctx) =>
          Effect.gen(function* () {
            const handle = ctx.tables.items;
            const failures: string[] = [];
            for (const limit of [0, -1, 1.5, 3, NaN, Infinity])
              failures.push(yield* failureReason(handle.page("by_rank", { limit })));
            const first = yield* handle.page("by_rank", { prefix: ["a"], limit: 1 });
            if (first.after === undefined) return yield* Effect.die("Expected continuation");
            for (const options of [
              { prefix: ["b"] as const },
              { prefix: ["a"] as const, range: { from: 1 } },
              { prefix: ["a"] as const, order: "desc" as const },
            ])
              failures.push(
                yield* failureReason(
                  handle.page("by_rank", { ...options, limit: 1, after: first.after }),
                ),
              );
            failures.push(
              yield* failureReason(
                handle.page("by_rank", { limit: 1, after: decodeRankCursor("bad cursor") }),
              ),
            );
            failures.push(
              yield* failureReason(
                handle.page("by_email", { limit: 1, after: decodeEmailCursor(first.after) }),
              ),
            );
            return failures;
          }),
      }),
      corruptRows: view({
        input: Schema.Void,
        output: Schema.Array(Schema.String),
        failure: Schema.Never,
        run: (ctx) =>
          Effect.all([
            failureReason(ctx.tables.items.get(key("bad"))),
            failureReason(ctx.tables.items.page("by_rank", { limit: 1 })),
          ]),
      }),
    },
    changes: {
      lifecycle: change({
        input: Schema.Void,
        output: Schema.Array(Schema.OptionFromNullOr(items.row)),
        failure: Schema.Never,
        run: (ctx) =>
          Effect.gen(function* () {
            const handle = ctx.tables.items;
            const states = [yield* handle.get(key("one"))];
            yield* handle.insert(row("one"));
            states.push(yield* handle.get(key("one")));
            states.push(yield* handle.unique("by_email", "one@example.com"));
            yield* handle.patch(key("one"), { rank: 4, note: "changed" });
            states.push(yield* handle.get(key("one")));
            yield* handle.replace(key("one"), row("one", 8));
            states.push(yield* handle.get(key("one")));
            yield* handle.delete(key("one"));
            states.push(yield* handle.get(key("one")));
            return states;
          }),
      }),
      conflicts: change({
        input: Schema.Void,
        output: Schema.Struct({
          reasons: Schema.Array(Schema.String),
          concurrentSuccesses: Schema.Number,
          concurrentFailures: Schema.Array(Schema.String),
        }),
        failure: Schema.Never,
        run: (ctx) =>
          Effect.gen(function* () {
            const handle = ctx.tables.items;
            yield* handle.insert(row("one"));
            const reasons = [
              yield* failureReason(handle.insert(row("one"))),
              yield* failureReason(handle.insert({ ...row("two"), email: "one@example.com" })),
            ];
            yield* handle.insert(row("two"));
            reasons.push(
              yield* failureReason(handle.patch(key("two"), { email: "one@example.com" })),
            );
            reasons.push(
              yield* failureReason(
                handle.replace(key("two"), { ...row("two"), email: "one@example.com" }),
              ),
            );
            const competing = yield* Effect.all(
              [
                Effect.result(handle.insert(row("three"))),
                Effect.result(handle.insert(row("three"))),
              ],
              { concurrency: "unbounded" },
            );
            return {
              reasons,
              concurrentSuccesses: competing.filter(Result.isSuccess).length,
              concurrentFailures: competing
                .filter(Result.isFailure)
                .map((result) => result.failure.reason),
            };
          }),
      }),
      invalidWrites: change({
        input: Schema.Void,
        output: Schema.Struct({
          reasons: Schema.Array(Schema.String),
          retained: Schema.OptionFromNullOr(items.row),
        }),
        failure: Schema.Never,
        run: (ctx) =>
          Effect.gen(function* () {
            const handle = ctx.tables.items;
            const reasons = [yield* failureReason(handle.insert({ ...row("bad"), email: "x" }))];
            yield* handle.insert(row("one"));
            reasons.push(yield* failureReason(handle.patch(key("one"), { rank: -1 })));
            reasons.push(yield* failureReason(handle.replace(key("one"), row("other"))));
            // JavaScript callers can supply key or storage properties excluded by the typed API.
            const keyPatch = { key: "other", rank: 1 };
            reasons.push(yield* failureReason(handle.patch(key("one"), keyPatch)));
            reasons.push(
              yield* failureReason(handle.insert(Object.assign(row("extra"), { _id: "injected" }))),
            );
            for (const effect of [
              handle.patch(key("missing"), { rank: 1 }),
              handle.replace(key("missing"), row("missing")),
              handle.delete(key("missing")),
            ])
              reasons.push(yield* failureReason(effect));
            return { reasons, retained: yield* handle.get(key("one")) };
          }),
      }),
      seed: change({
        input: Schema.Void,
        output: Schema.Void,
        failure: Schema.Never,
        run: (ctx) =>
          Effect.gen(function* () {
            for (const [i, rank] of [0, 1, 1, 2, 3].entries())
              yield* ctx.tables.items.insert(row(String(i), rank));
            yield* ctx.tables.items.insert({ ...row("foreign", 1), tenant: "b" });
          }),
      }),
      domainIdLifecycle: change({
        input: Schema.Void,
        output: Schema.Struct({
          beforePatch: Schema.OptionFromNullOr(domainIdRows.row),
          afterPatch: Schema.OptionFromNullOr(domainIdRows.row),
          duplicateFailure: Schema.String,
          rows: Schema.Array(domainIdRows.row),
        }),
        failure: Schema.Never,
        run: (ctx) =>
          Effect.gen(function* () {
            const handle = ctx.tables.domainIdRows;
            yield* handle.insert(folder("folder-a", 0, "A"));
            const beforePatch = yield* handle.get("folder-a");
            yield* handle.patch("folder-a", { label: "A updated" });
            const afterPatch = yield* handle.get("folder-a");
            const duplicateFailure = yield* failureReason(
              handle.insert(folder("folder-a", 2, "duplicate")),
            );
            yield* handle.insert(folder("folder-b", 0, "B"));
            yield* handle.insert({ ...folder("folder-c", 1, "C"), parentId: "other" });
            const first = yield* handle.page("byParent", { prefix: ["top"], limit: 1 });
            if (first.after === undefined)
              return yield* Effect.die("Expected another id-keyed page");
            const second = yield* handle.page("byParent", {
              prefix: ["top"],
              limit: 1,
              after: first.after,
            });
            return {
              beforePatch,
              afterPatch,
              duplicateFailure,
              rows: [...first.rows, ...second.rows],
            };
          }),
      }),
    },
    projections: {},
  }),
);
const schema = defineSchema({
  items: defineTable({
    tenant: v.string(),
    key: v.string(),
    email: v.string(),
    rank: v.number(),
    note: v.optional(v.string()),
  })
    .index("__sync_key", ["tenant", "key"])
    .index("by_email", ["email"])
    .index("by_rank", ["tenant", "rank"]),
  domainIdRows: defineTable({
    __sync_domain_id: v.string(),
    parentId: v.string(),
    position: v.number(),
    label: v.string(),
  })
    .index("__sync_key", ["__sync_domain_id"])
    .index("byParent", ["parentId", "position", "__sync_domain_id"]),
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
const active: ReturnType<typeof lunoraTest>[] = [];
afterEach(() => {
  for (const test of active.splice(0)) test.close();
});
function database() {
  const test = lunoraTest(schema, { enforceRls: false });
  active.push(test);
  const runtime = makeLunoraHome(
    definition,
    {
      home: "test",
      authorization: { authorize: () => Effect.void, isCurrent: () => true },
      authorizeIngress: (_source: string) => Effect.void,
      completion: { install: () => Effect.void },
    },
    { actorKey: String, ingressKey: String, permitKey: () => "test", maxPageSize: 2 },
  );
  const change = async <Name extends keyof typeof definition.changes>(name: Name) => {
    const result = await test.mutation((ctx) =>
      runtime.change(name)({ ctx, args: { actor: "test", input: undefined, operationKey: name } }),
    );
    if (result._tag !== "Committed") throw new Error("Expected committed change");
    return result.value;
  };
  return { test, runtime, change };
}

describe("Lunora home table operations", () => {
  it("reads prior writes on the same invocation and hides storage metadata", async () => {
    const { change } = database();
    expect(await change("lifecycle")).toEqual([
      Option.none(),
      Option.some(row("one")),
      Option.some(row("one")),
      Option.some({ ...row("one", 4), note: "changed" }),
      Option.some(row("one", 8)),
      Option.none(),
    ]);
  });

  it("enforces logical and declared unique keys, including concurrent effects", async () => {
    const { change } = database();
    expect(await change("conflicts")).toEqual({
      reasons: ["key_conflict", "unique_conflict", "unique_conflict", "unique_conflict"],
      concurrentSuccesses: 1,
      concurrentFailures: ["key_conflict"],
    });
  });

  it("rejects invalid rows and key changes before storage changes", async () => {
    const { change } = database();
    expect(await change("invalidWrites")).toEqual({
      reasons: [
        "invalid_row",
        "invalid_row",
        "key_mismatch",
        "key_mismatch",
        "invalid_row",
        "missing_row",
        "missing_row",
        "missing_row",
      ],
      retained: Option.some(row("one")),
    });
  });

  it("pages inclusive ranges and ties with no gaps in either direction", async () => {
    const { test, runtime, change } = database();
    await change("seed");
    const page = (input: typeof pageInput.Type) =>
      test.query((ctx) => runtime.query("page")({ ctx, args: { actor: "test", input } }));
    for (const order of ["asc", "desc"] as const) {
      const input = { prefix: ["a"] as const, range: { from: 1, to: 2 }, limit: 2, order };
      const first = await page(input);
      expect(first.rows).toHaveLength(2);
      expect(first.after).toBeDefined();
      const second = await page({ ...input, after: first.after! });
      expect(second.after).toBeUndefined();
      const rows = [...first.rows, ...second.rows];
      expect(rows.map((value) => value.rank)).toEqual(order === "asc" ? [1, 1, 2] : [2, 1, 1]);
      expect(new Set(rows.map((value) => value.key)).size).toBe(3);
      const exact = await test.query((ctx) =>
        runtime.query("exactRank")({ ctx, args: { actor: "test", input: 1 } }),
      );
      expect(exact.rows.map((value) => value.rank)).toEqual([1, 1]);
    }
  });

  it("rejects invalid limits and cursors reused with another selector or order", async () => {
    const { test, runtime, change } = database();
    await change("seed");
    expect(
      await test.query((ctx) =>
        runtime.query("invalidPages")({ ctx, args: { actor: "test", input: undefined } }),
      ),
    ).toEqual([
      ...Array.from({ length: 6 }, () => "invalid_query"),
      ...Array.from({ length: 5 }, () => "invalid_cursor"),
    ]);
  });

  it("rejects corrupt stored rows at the Effect schema boundary", async () => {
    const { test, runtime } = database();
    await test.run(async ({ db }) => {
      await db.insert("items", { ...row("bad"), rank: -1 });
    });
    expect(
      await test.query((ctx) =>
        runtime.query("corruptRows")({ ctx, args: { actor: "test", input: undefined } }),
      ),
    ).toEqual(["invalid_row", "invalid_row"]);
  });

  it("round-trips domain id through the native field and pages on an index that includes it", async () => {
    const { change } = database();
    expect(await change("domainIdLifecycle")).toEqual({
      beforePatch: Option.some(folder("folder-a", 0, "A")),
      afterPatch: Option.some(folder("folder-a", 0, "A updated")),
      duplicateFailure: "key_conflict",
      rows: [folder("folder-a", 0, "A updated"), folder("folder-b", 0, "B")],
    });
  });
});
