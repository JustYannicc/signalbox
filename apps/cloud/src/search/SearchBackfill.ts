import { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import * as UserContexts from "../user/UserContexts.ts";
import * as UserStore from "../user/UserStore.ts";
import { searchHomeForThread } from "./searchHome.ts";
import * as SearchIndex from "./SearchIndex.ts";

/** Advances a durable scan of the complete thread registry. It never scans histories in the user object. */
export class SearchBackfill extends Context.Service<
  SearchBackfill,
  {
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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* UserStore.UserStore;
  const contexts = yield* UserContexts.UserContexts;
  const threads = yield* ThreadDirectory.ThreadDirectory;
  const index = yield* SearchIndex.SearchIndex;
  const alarm = yield* SearchBackfillAlarm;
  const step = Effect.gen(function* () {
    yield* sql`CREATE TABLE IF NOT EXISTS search_backfill_scan (
      id INTEGER PRIMARY KEY CHECK (id = 1), after_id TEXT NOT NULL
    )`;
    const profile = yield* store.profile;
    if (profile === null) return;
    const actor = { userId: profile.id, contextIds: yield* contexts.contextIds };
    const cursor = yield* sql<{
      readonly after_id: string;
    }>`SELECT after_id FROM search_backfill_scan WHERE id = 1`;
    const after = cursor[0]?.after_id ?? "";
    const registry = yield* store.threadIndex;
    // Include archived and stopped threads. Access filtering happens on the query path.
    const ordered = registry.threads.toSorted((a, b) =>
      a.shell.id < b.shell.id ? -1 : a.shell.id > b.shell.id ? 1 : 0,
    );
    const batch = ordered.filter((row) => row.shell.id > after).slice(0, 8);
    for (const row of batch) {
      const home = searchHomeForThread(profile.id, row.contextId, row.shell.projectId);
      const progress = yield* index.progress(home, [row.shell.id]);
      if (!progress.some((entry) => entry.complete)) {
        // The thread validates its current home and queues an idempotent backfill, then its alarm delivers.
        yield* threads
          .forThread(ThreadId.make(row.shell.id))
          .backfill(actor)
          .pipe(Effect.catchTags({ ThreadNotFoundError: () => Effect.void }));
      }
    }
    const last = batch.at(-1)?.shell.id;
    const more = last !== undefined && ordered.some((row) => row.shell.id > last);
    yield* sql`INSERT INTO search_backfill_scan (id, after_id) VALUES (1, ${more ? last : ""})
      ON CONFLICT (id) DO UPDATE SET after_id = excluded.after_id`;
    const now = yield* Clock.currentTimeMillis;
    // A completed scan can hibernate. New threads index through their own outbox.
    if (more) yield* alarm.by(now + 1_000);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("search backfill will retry", { cause });
        const now = yield* Clock.currentTimeMillis;
        yield* alarm.by(now + 30_000);
      }),
    ),
  );
  return SearchBackfill.of({ step });
});

export const layer = Layer.effect(SearchBackfill, make);
