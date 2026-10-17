import * as Schema from "effect/Schema";

const Cursor = Schema.Struct({
  version: Schema.Literal(1),
  fingerprint: Schema.String,
  home: Schema.String,
  after: Schema.NullOr(Schema.Struct({ threadId: Schema.String, itemId: Schema.String })),
});
export type SearchCursor = typeof Cursor.Type;
const codec = Schema.fromJsonString(Cursor);
export const encodeSearchCursor = Schema.encodeSync(codec);
export const decodeSearchCursor = Schema.decodeUnknownOption(codec);

/** Cursors carry positions, never query text, grants, titles, counts or snippets. */
