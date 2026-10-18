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

const GrantKey = Schema.Struct({
  folderId: Schema.NullOr(Schema.String),
  incarnation: Schema.Int,
  personId: Schema.String,
});
const grants = table({
  row: Schema.Struct({
    ...GrantKey.fields,
    sourceId: Schema.String,
    role: Schema.Literals(["reader", "writer"]),
  }),
  key: ["folderId", "incarnation", "personId"],
  indexes: {
    byPerson: { fields: ["personId", "folderId", "incarnation"] },
    bySource: { fields: ["folderId", "incarnation", "sourceId"], unique: true },
  },
});
const SourceKey = Schema.Struct({
  folderId: Schema.NullOr(Schema.String),
  incarnation: Schema.Int,
  sourceId: Schema.String,
});
const cursor = pageCursorSchema(grants, "byPerson");
const PageInput = Schema.Struct({
  personId: Schema.String,
  folderId: Schema.NullOr(Schema.String),
  after: Schema.optionalKey(cursor),
  order: Schema.Literals(["asc", "desc"]),
});
const definition = defineHome(
  { actor: Schema.String, home: Schema.String, tables: { grants } },
  ({ view, change }) => ({
    views: {
      get: view({
        input: GrantKey,
        output: Schema.OptionFromNullOr(grants.row),
        failure: Schema.Never,
        run: (ctx, key) => ctx.tables.grants.get(key),
      }),
      source: view({
        input: SourceKey,
        output: Schema.OptionFromNullOr(grants.row),
        failure: Schema.Never,
        run: (ctx, key) => ctx.tables.grants.unique("bySource", key),
      }),
      page: view({
        input: PageInput,
        output: Schema.Struct({
          rows: Schema.Array(grants.row),
          after: Schema.UndefinedOr(cursor),
        }),
        failure: Schema.Never,
        run: (ctx, input) =>
          ctx.tables.grants.page("byPerson", {
            prefix: [input.personId, input.folderId],
            limit: 1,
            order: input.order,
            ...(input.after === undefined ? {} : { after: input.after }),
          }),
      }),
    },
    changes: {
      insert: change({
        input: grants.row,
        output: Schema.String,
        failure: Schema.Never,
        run: (ctx, row) =>
          Effect.map(Effect.result(ctx.tables.grants.insert(row)), (result) =>
            Result.isFailure(result) ? result.failure.reason : "inserted",
          ),
      }),
      replace: change({
        input: Schema.Struct({ key: GrantKey, row: grants.row }),
        output: Schema.Void,
        failure: Schema.Never,
        run: (ctx, input) => ctx.tables.grants.replace(input.key, input.row),
      }),
      delete: change({
        input: GrantKey,
        output: Schema.Void,
        failure: Schema.Never,
        run: (ctx, key) => ctx.tables.grants.delete(key),
      }),
    },
    projections: {},
  }),
);
const schema = defineSchema({
  grants: defineTable({
    folderId: v.union(v.null(), v.string()),
    incarnation: v.number(),
    personId: v.string(),
    sourceId: v.string(),
    role: v.union(v.literal("reader"), v.literal("writer")),
  })
    .index("__sync_key", ["folderId", "incarnation", "personId"])
    .index("byPerson", ["personId", "folderId", "incarnation"])
    .index("bySource", ["folderId", "incarnation", "sourceId"]),
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
const grant = (
  folderId: string | null,
  incarnation = 1,
  personId = "alice",
): typeof grants.row.Type => ({
  folderId,
  incarnation,
  personId,
  sourceId: `${personId}-${incarnation}`,
  role: "reader",
});
const grantKey = ({ folderId, incarnation, personId }: typeof grants.row.Type) => ({
  folderId,
  incarnation,
  personId,
});
const sourceKey = ({ folderId, incarnation, sourceId }: typeof grants.row.Type) => ({
  folderId,
  incarnation,
  sourceId,
});
const neighbors = [
  grant(null),
  grant("null"),
  grant(""),
  grant("folder"),
  grant(null, 1, "bob"),
  grant(null, 2),
];
function setup() {
  const db = lunoraTest(schema, { enforceRls: false });
  open.push(db);
  const runtime = makeLunoraHome(
    definition,
    {
      home: "catalog",
      authorization: { authorize: () => Effect.void, isCurrent: () => true },
      authorizeIngress: (_source: string) => Effect.void,
      completion: { install: () => Effect.void },
    },
    { actorKey: String, ingressKey: String, permitKey: () => "test", maxPageSize: 1 },
  );
  let sequence = 0;
  const change = async <Name extends keyof typeof definition.changes>(
    name: Name,
    input: (typeof definition.changes)[Name]["input"]["Type"],
  ) => {
    const result = await db.mutation((ctx) =>
      runtime.change(name)({
        ctx,
        args: { actor: "alice", input, operationKey: String(++sequence) },
      }),
    );
    if (result._tag !== "Committed") throw new Error("Expected committed change");
    return result.value;
  };
  const query = <Name extends keyof typeof definition.views>(
    name: Name,
    input: (typeof definition.views)[Name]["input"]["Type"],
  ) => db.query((ctx) => runtime.query(name)({ ctx, args: { actor: "alice", input } }));
  const seed = async () => {
    for (const row of neighbors) expect(await change("insert", row)).toBe("inserted");
  };
  return { db, change, query, seed };
}

describe("Catalog nullable grant keys", () => {
  it("rejects a repeated top-level key while keeping each typed composite key distinct", async () => {
    const t = setup();
    await t.seed();
    expect(await t.change("insert", grant(null))).toBe("key_conflict");
    for (const row of neighbors)
      expect(await t.query("get", grantKey(row))).toEqual(Option.some(row));
    expect(await t.db.query((ctx) => ctx.db.query("grants").collect())).toHaveLength(
      neighbors.length,
    );
  });

  it("replaces and deletes only the exact null composite key", async () => {
    const t = setup();
    await t.seed();
    const target = grant(null);
    const replacement = { ...target, role: "writer" as const };
    await t.change("replace", { key: grantKey(target), row: replacement });
    expect(await t.query("get", grantKey(target))).toEqual(Option.some(replacement));
    for (const row of neighbors.slice(1))
      expect(await t.query("get", grantKey(row))).toEqual(Option.some(row));
    await t.change("delete", grantKey(target));
    expect(await t.query("get", grantKey(target))).toEqual(Option.none());
    for (const row of neighbors.slice(1))
      expect(await t.query("get", grantKey(row))).toEqual(Option.some(row));
    expect(await t.db.query((ctx) => ctx.db.query("grants").collect())).toHaveLength(
      neighbors.length - 1,
    );
  });

  it("enforces and resolves a named unique index containing null", async () => {
    const t = setup();
    await t.seed();
    const original = grant(null);
    expect(
      await t.change("insert", { ...grant(null, 1, "carol"), sourceId: original.sourceId }),
    ).toBe("unique_conflict");
    expect(await t.query("source", sourceKey(original))).toEqual(Option.some(original));
    expect(await t.query("get", grantKey(grant(null, 1, "carol")))).toEqual(Option.none());
    for (const row of neighbors)
      expect(await t.query("source", sourceKey(row))).toEqual(Option.some(row));
  });

  it("continues a null prefix in both orders without including neighboring keys", async () => {
    const t = setup();
    await t.seed();
    for (const order of ["asc", "desc"] as const) {
      const input = { personId: "alice", folderId: null, order };
      const first = await t.query("page", input);
      expect(first.rows).toEqual([grant(null, order === "asc" ? 1 : 2)]);
      expect(first.after).toBeDefined();
      const second = await t.query("page", { ...input, after: first.after! });
      expect(second.rows).toEqual([grant(null, order === "asc" ? 2 : 1)]);
      expect(second.after).toBeUndefined();
    }
    for (const folderId of ["null", "", "folder"]) {
      const page = await t.query("page", { personId: "alice", folderId, order: "asc" });
      expect(page.rows).toEqual([grant(folderId)]);
      expect(page.after).toBeUndefined();
    }
  });
});
