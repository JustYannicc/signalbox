import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SIGNALBOX_SEARCH_WS_METHODS = { query: "signalbox.search.query" } as const;
export const SIGNALBOX_SEARCH_REQUIRED_SCOPES = {
  [SIGNALBOX_SEARCH_WS_METHODS.query]: AuthOrchestrationReadScope,
} as const;

export const SearchItemKind = Schema.Literals([
  "thread",
  "user",
  "assistant",
  "summary",
  "tool",
  "approval",
  "state",
]);
export type SearchItemKind = typeof SearchItemKind.Type;

/** Keyword search is explicit. Existing Find callers retain literal substring matching. */
export const ThreadSearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  mode: Schema.optionalKey(Schema.Literals(["keyword", "literal"])),
  projectIds: Schema.optionalKey(Schema.Array(ProjectId).check(Schema.isMaxLength(1_000))),
  threadId: Schema.optionalKey(ThreadId),
  kinds: Schema.optionalKey(Schema.Array(SearchItemKind)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8_192))),
  /** Home requests one best matching item per thread; agents may page individual items. */
  distinctThreads: Schema.optionalKey(Schema.Boolean),
});
export type ThreadSearchInput = typeof ThreadSearchInput.Type;

export const ThreadSearchHit = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  archived: Schema.Boolean,
  itemId: Schema.String,
  entryId: Schema.String,
  runId: Schema.NullOr(Schema.String),
  position: NonNegativeInt,
  kind: SearchItemKind,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  createdAt: Schema.NullOr(Schema.String),
  sourceSequence: NonNegativeInt,
  indexedThrough: NonNegativeInt,
});
export type ThreadSearchHit = typeof ThreadSearchHit.Type;

export const ThreadSearchResult = Schema.Struct({
  hits: Schema.Array(ThreadSearchHit),
  nextCursor: Schema.NullOr(Schema.String),
  coverage: Schema.Struct({
    /** Every authorized thread has finished initial backfill. Live writes arrive through the outbox. */
    complete: Schema.Boolean,
    indexedThreads: NonNegativeInt,
    pendingThreads: NonNegativeInt,
    /** False when the index could not answer one of the authorized homes. */
    available: Schema.Boolean,
  }),
});
export type ThreadSearchResult = typeof ThreadSearchResult.Type;

export class ThreadSearchError extends Schema.TaggedError<ThreadSearchError>()(
  "ThreadSearchError",
  {
    reason: Schema.Literals(["unavailable", "cursor_expired"]),
  },
) {
  override get message() {
    return this.reason === "cursor_expired"
      ? "Search access or results changed. Search again."
      : "Thread search is unavailable. Please retry.";
  }
}

export const SIGNALBOX_SEARCH_RPCS = [
  Rpc.make(SIGNALBOX_SEARCH_WS_METHODS.query, {
    payload: ThreadSearchInput,
    success: ThreadSearchResult,
    error: Schema.Union([ThreadSearchError, EnvironmentAuthorizationError]),
  }),
] as const;
