import * as Schema from "effect/Schema";

const Cursor = Schema.Struct({
  version: Schema.Literal(2),
  fingerprint: Schema.String,
  session: Schema.String,
  page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  after: Schema.NullOr(
    Schema.Struct({
      matchRank: Schema.Number,
      threadUpdatedAt: Schema.String,
      threadId: Schema.String,
      itemId: Schema.String,
    }),
  ),
});
export type SearchCursor = typeof Cursor.Type;
const codec = Schema.fromJsonString(Cursor);
export const encodeSearchCursor = Schema.encodeSync(codec);
export const decodeSearchCursor = Schema.decodeUnknownOption(codec);

/** Cursors carry positions, never query text, grants, titles, counts or snippets. */
