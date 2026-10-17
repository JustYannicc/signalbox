import { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import * as UserContexts from "../user/UserContexts.ts";
import * as UserStore from "../user/UserStore.ts";
import * as SearchIndex from "./SearchIndex.ts";

/** Advances a durable scan of the complete thread registry. It never scans histories in the user object. */
export class SearchBackfill extends Context.Service<
  SearchBackfill,
  {
    readonly ready: Effect.Effect<boolean, SqlError>;
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
  const ensureTables = Effect.gen(function* () {
    yield* sql`CREATE TABLE IF NOT EXISTS search_backfill_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_generation TEXT NOT NULL,
      activation INTEGER NOT NULL,
      after_id TEXT NOT NULL,
      complete INTEGER NOT NULL,
      disabled_generation TEXT
    )`;
    yield* sql`CREATE TABLE IF NOT EXISTS search_backfill_disabled_generations (
      generation TEXT PRIMARY KEY
    )`;
  });
  const readState = sql<{
    readonly active_generation: string;
    readonly activation: number;
    readonly after_id: string;
    readonly complete: number;
    readonly disabled_generation: string | null;
  }>`SELECT active_generation, activation, after_id, complete, disabled_generation
    FROM search_backfill_state WHERE id = 1`;
  const ready = Effect.gen(function* () {
    yield* ensureTables;
    const stored = yield* readState;
    const previous = stored[0];
    const generation = index.generation;
    const disabledGeneration = yield* sql<{ readonly generation: string }>`SELECT generation
      FROM search_backfill_disabled_generations WHERE generation = ${generation}`;
    if (index.disabled) {
      if (disabledGeneration.length === 0 || previous?.active_generation !== generation) {
        const activation =
          previous === undefined
            ? 1
            : previous.active_generation === generation
              ? previous.activation
              : previous.activation + 1;
        yield* sql`INSERT INTO search_backfill_disabled_generations (generation)
          VALUES (${generation}) ON CONFLICT (generation) DO NOTHING`;
        yield* sql`INSERT INTO search_backfill_state
          (id, active_generation, activation, after_id, complete, disabled_generation)
          VALUES (1, ${generation}, ${activation}, '', 1, ${generation})
          ON CONFLICT (id) DO UPDATE SET
            active_generation = excluded.active_generation,
            activation = excluded.activation,
            after_id = '',
            complete = 1,
            disabled_generation = excluded.disabled_generation`;
      }
      return false;
    }
    return disabledGeneration.length === 0;
  });
  const step = Effect.gen(function* () {
    if (!(yield* ready)) return;
    const stored = yield* readState;
    const previous = stored[0];
    const generation = index.generation;
    if (previous?.active_generation === generation && previous.complete === 1) return;

    const activation =
      previous === undefined
        ? 1
        : previous.active_generation === generation
          ? previous.activation
          : previous.activation + 1;
    const after = previous?.active_generation === generation ? previous.after_id : "";
    yield* sql`INSERT INTO search_backfill_state
      (id, active_generation, activation, after_id, complete, disabled_generation)
      VALUES (1, ${generation}, ${activation}, ${after}, 0, ${previous?.disabled_generation ?? null})
      ON CONFLICT (id) DO UPDATE SET
        active_generation = excluded.active_generation,
        activation = excluded.activation,
        after_id = excluded.after_id,
        complete = 0,
        disabled_generation = excluded.disabled_generation`;

    const profile = yield* store.profile;
    if (profile === null) return;
    const actor = { userId: profile.id, contextIds: yield* contexts.contextIds };
    const registry = yield* store.threadIndex;
    // Include archived and stopped threads. Access filtering happens on the query path.
    const ordered = registry.threads.toSorted((a, b) =>
      a.shell.id < b.shell.id ? -1 : a.shell.id > b.shell.id ? 1 : 0,
    );
    const batch = ordered.filter((row) => row.shell.id > after).slice(0, 8);
    for (const row of batch) {
      const requestKey = `search-backfill:${actor.userId}:${generation}:${activation}`;
      // A generation activation replays the source snapshot even when retained
      // destination progress says this thread was complete before the switch.
      yield* threads
        .forThread(ThreadId.make(row.shell.id))
        .backfill(actor, requestKey)
        .pipe(Effect.catchTags({ ThreadNotFoundError: () => Effect.void }));
    }
    const last = batch.at(-1)?.shell.id;
    const more = last !== undefined && ordered.some((row) => row.shell.id > last);
    yield* sql`UPDATE search_backfill_state SET after_id = ${more ? last : (last ?? after)},
      complete = ${more ? 0 : 1} WHERE id = 1`;
    const now = yield* Clock.currentTimeMillis;
    // New threads index through their own outbox; completed generations can hibernate.
    if (more) yield* alarm.by(now + 1_000);
  }).pipe(
    Effect.catchCause((cause) =>
      index.disabled
        ? Effect.void
        : Effect.gen(function* () {
            yield* Effect.logWarning("search backfill will retry", { cause });
            const now = yield* Clock.currentTimeMillis;
            yield* alarm.by(now + 30_000);
          }),
    ),
  );
  return SearchBackfill.of({ ready, step });
});

export const layer = Layer.effect(SearchBackfill, make);
