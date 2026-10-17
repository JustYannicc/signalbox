import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A canonical home, independent of the engine used to search it. */
export interface SearchHome {
  readonly ownerId: string;
  readonly projectId: string;
}

export const SearchDocument = Schema.Struct({
  threadId: Schema.String,
  itemId: Schema.String,
  entryId: Schema.String,
  runId: Schema.NullOr(Schema.String),
  position: Schema.Number,
  kind: Schema.Literals(["thread", "user", "assistant", "summary", "tool", "approval", "state"]),
  text: Schema.String,
  createdAt: Schema.NullOr(Schema.String),
});
export type SearchDocument = typeof SearchDocument.Type;

export const SearchThreadMetadata = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  archived: Schema.Boolean,
  deleted: Schema.Boolean,
});
export type SearchThreadMetadata = typeof SearchThreadMetadata.Type;

/** Ordered per thread. A revision's pages are individually receipted; complete closes a backfill. */
export interface SearchDelivery {
  readonly home: SearchHome;
  readonly thread: SearchThreadMetadata;
  readonly revision: number;
  readonly sourceSequence: number;
  readonly deliveryId: string;
  readonly documents: ReadonlyArray<SearchDocument>;
  readonly removed: ReadonlyArray<string>;
  readonly complete: boolean;
}

export interface SearchCandidate extends SearchDocument {
  readonly title: string;
  readonly archived: boolean;
  readonly revision: number;
  readonly sourceSequence: number;
}

export class SearchIndexError extends Schema.TaggedError<SearchIndexError>()("SearchIndexError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Thread search is unavailable. Please retry.";
  }
}

/** The search engine port. Authorization and client pagination belong to ThreadSearch. */
export class SearchIndex extends Context.Service<
  SearchIndex,
  {
    readonly deliver: (delivery: SearchDelivery) => Effect.Effect<void, SearchIndexError>;
    readonly query: (input: {
      readonly home: SearchHome;
      readonly threadIds: ReadonlyArray<string>;
      readonly query: string;
      readonly mode: "keyword" | "literal";
      readonly kinds?: ReadonlyArray<SearchDocument["kind"]>;
      readonly distinctThreads?: boolean;
      readonly after: { readonly threadId: string; readonly itemId: string } | null;
      readonly limit: number;
    }) => Effect.Effect<
      {
        readonly candidates: ReadonlyArray<SearchCandidate>;
        readonly hasMore: boolean;
      },
      SearchIndexError
    >;
    readonly progress: (
      home: SearchHome,
      threadIds: ReadonlyArray<string>,
    ) => Effect.Effect<
      ReadonlyArray<{
        readonly threadId: string;
        readonly revision: number;
        readonly complete: boolean;
      }>,
      SearchIndexError
    >;
  }
>()("@signalbox/cloud/search/SearchIndex") {}
