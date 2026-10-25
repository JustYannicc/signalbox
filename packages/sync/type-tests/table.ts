import * as Schema from "effect/Schema";
import {
  pageCursorSchema,
  table,
  type Key,
  type PageCursor,
  type ReadTable,
  type Row,
  type Table,
  type TableMap,
  type WriteTable,
} from "../src/table.ts";

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
const compositeKey: Key<typeof compositeHomes> = {
  ownerId: "u1",
  slug: "main",
};
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
  order: "desc",
});
// @ts-expect-error Index pages only support ascending or descending order.
void reads.page("byOwnerAndRank", { limit: 25, order: "sideways" });

void writes.insert(home);
void writes.replace(homeKey, home);
void writes.patch(homeKey, { slug: "renamed" });
void writes.delete(homeKey);

const rankCursorSchema = pageCursorSchema(homes, "byOwnerAndRank");
const ownerCursorSchema = pageCursorSchema(homes, "byOwner");
const rankedRecords = table({
  row: Schema.Struct({
    id: Schema.String,
    ownerId: Schema.String,
    rank: Schema.Int,
  }),
  key: ["id"],
  indexes: { byOwnerAndRank: { fields: ["ownerId", "rank"] } },
});
const otherRankCursorSchema = pageCursorSchema(rankedRecords, "byOwnerAndRank");
const rankPageInput = Schema.Struct({
  after: Schema.optional(rankCursorSchema),
});
const rankPageOutput = Schema.Struct({
  after: Schema.optional(rankCursorSchema),
});
type RankPageInput = typeof rankPageInput.Type;
type RankPageOutput = typeof rankPageOutput.Type;
const encodedRankCursor: typeof rankCursorSchema.Encoded = "opaque";
declare const rankCursor: PageCursor<typeof homes, "byOwnerAndRank">;
declare const ownerCursor: typeof ownerCursorSchema.Type;
declare const otherTableRankCursor: typeof otherRankCursorSchema.Type;
const acceptedInput: RankPageInput = { after: rankCursor };
const acceptedOutput: RankPageOutput = { after: rankCursor };
// @ts-expect-error A plain string must be decoded by the scoped cursor schema first.
const unvalidatedCursor: RankPageInput = { after: "opaque" };
// @ts-expect-error Cursors are scoped to the index that produced them.
const wrongIndexCursor: RankPageInput = { after: ownerCursor };
// @ts-expect-error Cursors from a different table schema cannot be reused.
const wrongTableCursor: RankPageInput = { after: otherTableRankCursor };
// @ts-expect-error An index name must exist on this table.
pageCursorSchema(homes, "byUnknownIndex");
void acceptedInput;
void acceptedOutput;
void unvalidatedCursor;
void wrongIndexCursor;
void wrongTableCursor;
void encodedRankCursor;

const validatedTables: TableMap = { homes };
void validatedTables;
const unvalidatedTables: TableMap = {
  // @ts-expect-error Tables must be created by the validating table() factory.
  homes: { row: homes.row, key: homes.key, indexes: homes.indexes },
};
void unvalidatedTables;

// @ts-expect-error The domain key is the row's id field, independent of storage _id.
void reads.get({ _id: "h1" });
// @ts-expect-error Only unique indexes support unique lookup.
void reads.unique("byOwner", "u1");
// @ts-expect-error Composite unique indexes require their complete key.
void reads.unique("byOwnerAndSlug", { ownerId: "u1" });
// @ts-expect-error A page prefix must follow the index's field order.
void reads.page("byOwnerAndRank", { prefix: [2], limit: 25 });
// @ts-expect-error Range applies to the index field immediately after the prefix (rank here).
void reads.page("byOwnerAndRank", {
  prefix: ["u1"],
  range: { from: "2" },
  limit: 25,
});
// @ts-expect-error A full index prefix has no next field to range over.
void reads.page("byOwnerAndRank", {
  prefix: ["u1", 2],
  range: { from: 3 },
  limit: 25,
});
// @ts-expect-error Domain key fields cannot be patched.
void writes.patch(homeKey, { id: "other" });

table({
  row: Schema.Struct({ id: Schema.optional(Schema.String) }),
  // @ts-expect-error Optional fields cannot be domain keys.
  key: ["id"],
  indexes: {},
});
table({
  // @ts-expect-error Storage-owned fields are reserved and cannot appear in domain rows.
  row: Schema.Struct({ id: Schema.String, _id: Schema.String }),
  key: ["id"],
  indexes: {},
});
table({
  // @ts-expect-error Storage-owned fields are reserved and cannot appear in domain rows.
  row: Schema.Struct({ id: Schema.String, _creationTime: Schema.Number }),
  key: ["id"],
  indexes: {},
});
table({
  row: Schema.Struct({
    id: Schema.String,
    nested: Schema.Struct({ value: Schema.String }),
  }),
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

declare const rowWithService: Schema.Codec<
  { readonly id: string },
  { readonly id: string },
  "Service",
  never
>;
// @ts-expect-error Stored schemas cannot require arbitrary decoding services.
export type InvalidServiceTable = Table<typeof rowWithService>;
