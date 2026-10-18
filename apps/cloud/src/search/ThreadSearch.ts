import type {
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type {
  ThreadSearchInput,
  ThreadSearchResult,
  ThreadSearchError,
} from "@t3tools/contracts/signalboxSearch";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type * as SearchIndex from "./SearchIndex.ts";

export interface SearchActor {
  readonly userId: string;
  readonly contextIds: ReadonlyArray<SignalboxContextId>;
  readonly projectIds?: ReadonlyArray<string>;
}

/** The one search service for people, agents and API callers. */
export class ThreadSearch extends Context.Service<
  ThreadSearch,
  {
    readonly query: (
      actor: SearchActor,
      input: ThreadSearchInput,
    ) => Effect.Effect<ThreadSearchResult, ThreadSearchError>;
    readonly search: (
      actor: SearchActor,
      input: OrchestrationSearchThreadsInput,
    ) => Effect.Effect<OrchestrationSearchThreadsResult, ThreadSearchError>;
    readonly searchOne: (
      actor: SearchActor,
      input: OrchestrationV2SearchThreadInput,
    ) => Effect.Effect<OrchestrationV2SearchThreadResult, ThreadSearchError>;
    /** Reads the exact matching searchable item with current access, without loading its whole thread. */
    readonly readItem: (
      actor: SearchActor,
      threadId: ThreadId,
      itemId: string,
    ) => Effect.Effect<
      {
        readonly snapshotSequence: number;
        readonly projectId: ProjectId;
        readonly title: string;
        readonly archived: boolean;
        readonly item: SearchIndex.SearchDocument;
      } | null,
      ThreadSearchError
    >;
  }
>()("@signalbox/cloud/search/ThreadSearch") {}
