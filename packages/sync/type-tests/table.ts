import * as Schema from "effect/Schema";
import { table, type Key, type ReadTable, type Row, type WriteTable } from "../src/table.ts";

const homes = table({
  row: Schema.Struct({
    id: Schema.String,
    ownerId: Schema.String,
    slug: Schema.String,
    rank: Schema.Int,
  }),
  key: ["id"],
  indexes: {
    byOwner: { fields: ["ownerId"] },
    byOwnerAndSlug: { fields: ["ownerId", "slug"], unique: true },
    byOwnerAndRank: { fields: ["ownerId", "rank"] },
  },
});

type Home = Row<typeof homes>;
type HomeKey = Key<typeof homes>;

const home: Home = { id: "h1", ownerId: "u1", slug: "main", rank: 2 };
const homeKey: HomeKey = "h1";
declare const reads: ReadTable<typeof homes>;
declare const writes: WriteTable<typeof homes>;

const compositeHomes = table({
  row: Schema.Struct({ ownerId: Schema.String, slug: Schema.String }),
  key: ["ownerId", "slug"],
  indexes: {},
});
const compositeKey: Key<typeof compositeHomes> = { ownerId: "u1", slug: "main" };
declare const compositeReads: ReadTable<typeof compositeHomes>;
void compositeReads.get(compositeKey);
// @ts-expect-error Composite domain keys require all declared fields.
void compositeReads.get({ ownerId: "u1" });

void reads.get(homeKey);
void reads.unique("byOwnerAndSlug", { ownerId: "u1", slug: "main" });
void reads.page("byOwnerAndRank", {
  prefix: ["u1"],
  range: { from: 1, to: 4 },
  limit: 25,
});
void reads.page("byOwnerAndRank", {
  range: { from: "u1", to: "u9" },
  limit: 25,
});
void reads.page("byOwnerAndRank", {
  prefix: ["u1", 2],
  limit: 25,
});

void writes.insert(home);
void writes.replace(homeKey, home);
void writes.patch(homeKey, { slug: "renamed" });
void writes.delete(homeKey);

// @ts-expect-error The domain key is the row's id field, independent of storage _id.
void reads.get({ _id: "h1" });
// @ts-expect-error Only unique indexes support unique lookup.
void reads.unique("byOwner", "u1");
// @ts-expect-error Composite unique indexes require their complete key.
void reads.unique("byOwnerAndSlug", { ownerId: "u1" });
// @ts-expect-error A page prefix must follow the index's field order.
void reads.page("byOwnerAndRank", { prefix: [2], limit: 25 });
// @ts-expect-error Range applies to the index field immediately after the prefix (rank here).
void reads.page("byOwnerAndRank", { prefix: ["u1"], range: { from: "2" }, limit: 25 });
// @ts-expect-error A full index prefix has no next field to range over.
void reads.page("byOwnerAndRank", { prefix: ["u1", 2], range: { from: 3 }, limit: 25 });
// @ts-expect-error Domain key fields cannot be patched.
void writes.patch(homeKey, { id: "other" });

table({
  row: Schema.Struct({ id: Schema.optional(Schema.String) }),
  // @ts-expect-error Optional fields cannot be domain keys.
  key: ["id"],
  indexes: {},
});
table({
  row: Schema.Struct({ id: Schema.String, nested: Schema.Struct({ value: Schema.String }) }),
  key: ["id"],
  indexes: {
    byNested: {
      // @ts-expect-error Object fields cannot be index keys.
      fields: ["nested"],
    },
  },
});
table({
  row: Schema.Struct({ id: Schema.String, tags: Schema.Array(Schema.String) }),
  key: ["id"],
  indexes: {
    byTags: {
      // @ts-expect-error Array fields cannot be index keys.
      fields: ["tags"],
    },
  },
});
