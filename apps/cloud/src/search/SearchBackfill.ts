import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

/** Advances a durable scan of the complete thread registry. It never scans histories in the user object. */
export class SearchBackfill extends Context.Service<
  SearchBackfill,
  {
    readonly activation: Effect.Effect<string | null, SqlError>;
    readonly ready: Effect.Effect<boolean, SqlError>;
    readonly observeThread: (threadId: ThreadId) => Effect.Effect<void, SqlError>;
    readonly step: Effect.Effect<void>;
  }
>()("@signalbox/cloud/search/SearchBackfill") {}

/** The user object's existing shared alarm. */
export class SearchBackfillAlarm extends Context.Service<
  SearchBackfillAlarm,
  {
    readonly by: (at: number) => Effect.Effect<void>;
  }
>()("@signalbox/cloud/search/SearchBackfill/SearchBackfillAlarm") {}
