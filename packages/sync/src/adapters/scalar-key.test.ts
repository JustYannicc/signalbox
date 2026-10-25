import { lunoraTest } from "@lunora/testing";
import { makeLunoraHome } from "@signalbox/sync/adapters/lunoraHome";
import { defineHome } from "@signalbox/sync/definition";
import { pageCursorSchema, table } from "@signalbox/sync/table";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { defineSchema, defineTable, v } from "lunorash/server";
import { afterEach, describe, expect, it } from "vite-plus/test";

const Scalar = Schema.Union([Schema.Null, Schema.Boolean, Schema.Number, Schema.String]);
const records = table({
  row: Schema.Struct({
    key: Scalar,
    alias: Scalar,
    group: Scalar,
    rank: Schema.Number,
    label: Schema.String,
  }),
  key: ["key"],
  indexes: { byAlias: { fields: ["alias"], unique: true }, byGroup: { fields: ["group", "rank"] } },
});
const cursor = pageCursorSchema(records, "byGroup");
const PageInput = Schema.Struct({
  group: Scalar,
  order: Schema.Literals(["asc", "desc"]),
  after: Schema.optionalKey(cursor),
});
const definition = defineHome(
  { actor: Schema.String, home: Schema.String, tables: { records } },
  ({ view, change }) => ({
    views: {
      get: view({
        input: Scalar,
        output: Schema.OptionFromNullOr(records.row),
        failure: Schema.Never,
        run: (ctx, key) => ctx.tables.records.get(key),
      }),
      unique: view({
        input: Scalar,
        output: Schema.OptionFromNullOr(records.row),
        failure: Schema.Never,
        run: (ctx, key) => ctx.tables.records.unique("byAlias", key),
      }),
      page: view({
        input: PageInput,
        output: Schema.Struct({
          rows: Schema.Array(records.row),
          after: Schema.UndefinedOr(cursor),
        }),
        failure: Schema.Never,
        run: (ctx, input) =>
          ctx.tables.records.page("byGroup", {
            prefix: [input.group],
            limit: 2,
            order: input.order,
            ...(input.after === undefined ? {} : { after: input.after }),
          }),
      }),
    },
    changes: {
      insert: change({
        input: records.row,
        output: Schema.String,
        failure: Schema.Never,
        run: (ctx, row) =>
          Effect.map(Effect.result(ctx.tables.records.insert(row)), (result) =>
            Result.isFailure(result) ? result.failure.reason : "inserted",
          ),
      }),
      seed: change({
        input: Schema.Array(records.row),
        output: Schema.Void,
        failure: Schema.Never,
        run: (ctx, rows) =>
          Effect.forEach(rows, (row) => ctx.tables.records.insert(row), { discard: true }),
      }),
      replace: change({
        input: records.row,
        output: Schema.Void,
        failure: Schema.Never,
        run: (ctx, row) => ctx.tables.records.replace(row.key, row),
      }),
      delete: change({
        input: Scalar,
        output: Schema.Void,
        failure: Schema.Never,
        run: (ctx, key) => ctx.tables.records.delete(key),
      }),
    },
    projections: {},
  }),
);
const scalar = v.union(v.null(), v.boolean(), v.number(), v.string());
const schema = defineSchema({
  records: defineTable({
    key: scalar,
    alias: scalar,
    group: scalar,
    rank: v.number(),
    label: v.string(),
  })
    .index("__sync_key", ["key"])
    .index("byAlias", ["alias"])
    .index("byGroup", ["group", "rank"]),
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
const open: ReturnType<typeof lunoraTest>[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});
const mixedRows = [null, false, 0, "null", "", true, 1, "0", "false"].map((key, rank) => ({
  key,
  alias: key,
  group: key,
  rank,
  label: `row-${rank}`,
}));
function setup() {
  const db = lunoraTest(schema, { enforceRls: false });
  open.push(db);
  const runtime = makeLunoraHome(
    definition,
    {
      home: "mixed-scalars",
      authorization: { authorize: () => Effect.void, isCurrent: () => true },
      authorizeIngress: (_source: string) => Effect.void,
      completion: { install: () => Effect.void },
    },
    { actorKey: String, ingressKey: String, permitKey: () => "test", maxPageSize: 2 },
  );
  let sequence = 0;
  const change = async <Name extends keyof typeof definition.changes>(
    name: Name,
    input: (typeof definition.changes)[Name]["input"]["Type"],
  ) => {
    const result = await db.mutation((ctx) =>
      runtime.change(name)({
        ctx,
        args: { actor: "test", input, operationKey: String(++sequence) },
      }),
    );
    if (result._tag !== "Committed") throw new Error("Expected committed operation");
    return result.value;
  };
  const query = <Name extends keyof typeof definition.views>(
    name: Name,
    input: (typeof definition.views)[Name]["input"]["Type"],
  ) => db.query((ctx) => runtime.query(name)({ ctx, args: { actor: "test", input } }));
  return { change, query };
}

describe("Typed scalar key equality", () => {
  it("keeps null, booleans, numbers and strings distinct and rejects exact duplicates", async () => {
    const t = setup();
    const outcomes = [];
    for (const row of mixedRows) outcomes.push(await t.change("insert", row));
    expect(outcomes).toEqual(mixedRows.map(() => "inserted"));
    for (const row of mixedRows) {
      expect(await t.query("get", row.key)).toEqual(Option.some(row));
      expect(await t.query("unique", row.alias)).toEqual(Option.some(row));
      expect(await t.change("insert", row)).toBe("key_conflict");
      expect(await t.change("insert", { ...row, key: `conflict-${row.label}` })).toBe(
        "unique_conflict",
      );
    }
  });

  it("replaces and deletes one typed key even when SQLite compares another key as equal", async () => {
    const t = setup();
    await t.change("seed", mixedRows);
    for (const key of [false, 0, true, 1]) {
      const before = mixedRows.find((row) => row.key === key)!;
      const updated = { ...before, label: "updated" };
      await t.change("replace", updated);
      expect(await t.query("get", key)).toEqual(Option.some(updated));
      for (const other of mixedRows.filter((row) => row.key !== key))
        expect(await t.query("get", other.key)).toEqual(Option.some(other));
      await t.change("delete", key);
      expect(await t.query("get", key)).toEqual(Option.none());
      for (const other of mixedRows.filter((row) => row.key !== key))
        expect(await t.query("get", other.key)).toEqual(Option.some(other));
      expect(await t.change("insert", before)).toBe("inserted");
    }
  });

  it("filters mixed prefixes before pagination limits and preserves continuation through rejected candidates", async () => {
    const t = setup();
    const rows = [
      ...Array.from({ length: 70 }, (_, rank) => ({
        key: `number-${rank}`,
        alias: `number-${rank}`,
        group: 0,
        rank,
        label: "number",
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        key: `boolean-${i}`,
        alias: `boolean-${i}`,
        group: false,
        rank: 80 + i,
        label: "boolean",
      })),
    ];
    await t.change("seed", rows);
    for (const group of [false, 0])
      for (const order of ["asc", "desc"] as const) {
        const expected = rows
          .filter((row) => row.group === group)
          .toSorted((a, b) => (order === "asc" ? a.rank - b.rank : b.rank - a.rank));
        const found: (typeof records.row.Type)[] = [];
        let after: typeof cursor.Type | undefined;
        let pages = 0;
        do {
          const page = await t.query("page", {
            group,
            order,
            ...(after === undefined ? {} : { after }),
          });
          expect(page.rows.length).toBeGreaterThan(0);
          expect(page.rows.length).toBeLessThanOrEqual(2);
          found.push(...page.rows);
          after = page.after;
          pages += 1;
          if (pages > expected.length) throw new Error("Cursor did not advance");
        } while (after !== undefined);
        expect(found).toEqual(expected);
        expect(pages).toBe(Math.ceil(expected.length / 2));
      }
  });
});
