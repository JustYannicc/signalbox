import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { emitLunoraSchema } from "@signalbox/sync/adapters/lunoraSchema";
import { table, type TableMap } from "@signalbox/sync/table";

describe("emitLunoraSchema", () => {
  it("emits deterministic literal Lunora syntax and retains Effect metadata", () => {
    const counter = table({
      row: Schema.Struct({
        key: Schema.String.pipe(Schema.brand("CounterKey")),
        parentId: Schema.String.check(Schema.isMinLength(1)),
        name: Schema.optionalKey(Schema.String),
        state: Schema.Union([Schema.Literal("open"), Schema.Null]),
        tags: Schema.Array(Schema.String),
        archivedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      }),
      key: ["key"],
      indexes: {
        by_state: { fields: ["state"], unique: true },
        by_parent: { fields: ["parentId"], unique: false },
      },
    });
    const emitted = emitLunoraSchema({ counters: counter });

    expect(emitted.source).toBe(`import { defineSchema, defineTable, v } from "lunorash/server";

export default defineSchema({
  "counters": defineTable({
    "key": v.string(),
    "parentId": v.string(),
    "name": v.optional(v.string()),
    "state": v.union(v.literal("open"), v.null()),
    "tags": v.array(v.string()),
    "archivedAt": v.optional(v.union(v.number(), v.null())),
  })
  .index("__sync_key", ["key"])
  .index("by_parent", ["parentId"])
  .index("by_state", ["state"]),
});
`);
    expect(emitted.tables.counters).toBe(counter);
    expect(emitted.tables.counters.indexes.by_state.unique).toBe(true);
    expect(emitted.tables.counters.row).toBe(counter.row);
  });

  it("escapes domain id fields in emitted columns and every generated index", () => {
    const folders = table({
      row: Schema.Struct({ id: Schema.String, parentId: Schema.NullOr(Schema.String) }),
      key: ["id"],
      indexes: { by_parent: { fields: ["parentId", "id"] } },
    });
    const emitted = emitLunoraSchema({ folders }).source;

    expect(emitted).toContain('"__sync_domain_id": v.string()');
    expect(emitted).toContain('.index("__sync_key", ["__sync_domain_id"])');
    expect(emitted).toContain('.index("by_parent", ["parentId","__sync_domain_id"])');
    expect(emitted).not.toContain('"id": v.string()');
  });

  it("rejects codecs rather than widening them to Lunora's encoded validator", () => {
    const converted = table({
      row: Schema.Struct({ key: Schema.NumberFromString }),
      key: ["key"],
      indexes: {},
    });

    expect(() => emitLunoraSchema({ converted })).toThrow(
      /schema\.converted\.row\.key: Effect codecs\/transforms are not supported/,
    );
  });

  it("rejects an index that cannot represent the logical key fields", () => {
    const badIndex = {
      row: Schema.Struct({ key: Schema.String, details: Schema.Struct({ label: Schema.String }) }),
      key: ["key"],
      indexes: { by_details: { fields: ["details"] } },
    } as unknown as TableMap["badIndex"];

    expect(() => emitLunoraSchema({ badIndex })).toThrow(
      /schema\.badIndex\.indexes\.by_details: field "details" must be a required, untransformed JSON scalar/,
    );
  });

  it("reserves the generated key index name", () => {
    const collision = table({
      row: Schema.Struct({ key: Schema.String }),
      key: ["key"],
      indexes: { __sync_key: { fields: ["key"] } },
    });

    expect(() => emitLunoraSchema({ collision })).toThrow(
      /schema\.collision\.indexes\.__sync_key: index name "__sync_key" is reserved/,
    );
  });

  it("rejects Lunora-owned row fields", () => {
    const withId = {
      row: Schema.Struct({ _id: Schema.String, key: Schema.String }),
      key: ["key"],
      indexes: {},
    } as unknown as TableMap["withId"];
    const withCreationTime = {
      row: Schema.Struct({ _creationTime: Schema.Number, key: Schema.String }),
      key: ["key"],
      indexes: {},
    } as unknown as TableMap["withCreationTime"];
    const withDomainIdAlias = {
      row: Schema.Struct({ __sync_domain_id: Schema.String, key: Schema.String }),
      key: ["key"],
      indexes: {},
    } as unknown as TableMap["withDomainIdAlias"];

    expect(() => emitLunoraSchema({ withId })).toThrow(
      /schema\.withId\.row\._id: field "_id" is reserved by Lunora/,
    );
    expect(() => emitLunoraSchema({ withCreationTime })).toThrow(
      /schema\.withCreationTime\.row\._creationTime: field "_creationTime" is reserved by Lunora/,
    );
    expect(() => emitLunoraSchema({ withDomainIdAlias })).toThrow(
      /schema\.withDomainIdAlias\.row\.__sync_domain_id: field "__sync_domain_id" is reserved by Lunora/,
    );
  });
});
