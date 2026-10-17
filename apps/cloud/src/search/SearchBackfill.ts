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
    yield* sql`CREATE TABLE IF NOT EXISTS search_backfill_requests (
      thread_id TEXT NOT NULL, activation TEXT NOT NULL, complete INTEGER NOT NULL,
      PRIMARY KEY (thread_id, activation)
    )`;
    yield* sql`CREATE TABLE IF NOT EXISTS search_backfill_registration_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1), sequence INTEGER NOT NULL
    )`;
    yield* sql`INSERT INTO search_backfill_registration_cursor (id, sequence)
      VALUES (1, 0) ON CONFLICT(id) DO NOTHING`;
  });
  const readState = sql<{
    readonly active_generation: string;
    readonly activation: number;
    readonly after_id: string;
    readonly complete: number;
    readonly disabled_generation: string | null;
  }>`SELECT active_generation, activation, after_id, complete, disabled_generation
    FROM search_backfill_state WHERE id = 1`;
  const ensureCurrentState = Effect.gen(function* () {
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
      return null;
    }
    if (disabledGeneration.length > 0) return null;

    const profile = yield* store.profile;
    if (profile === null) return null;
    const activation =
      previous?.active_generation === generation
        ? previous.activation
        : previous === undefined
          ? 1
          : previous.activation + 1;
    const after = previous?.active_generation === generation ? previous.after_id : "";
    const complete = previous?.active_generation === generation && previous.complete === 1;
    if (previous?.active_generation !== generation) {
      yield* sql`INSERT INTO search_backfill_state
        (id, active_generation, activation, after_id, complete, disabled_generation)
        VALUES (1, ${generation}, ${activation}, '', 0, ${previous?.disabled_generation ?? null})
        ON CONFLICT (id) DO UPDATE SET
          active_generation = excluded.active_generation,
          activation = excluded.activation,
          after_id = '',
          complete = 0,
          disabled_generation = excluded.disabled_generation`;
    }
    return {
      profile,
      generation,
      activation,
      requestKey: `search-backfill:${profile.id}:${generation}:${activation}`,
      after,
      complete,
    };
  });
  const activation = Effect.map(ensureCurrentState, (current) => current?.requestKey ?? null);
  const ready = Effect.map(activation, (current) => current !== null);
  const enqueue = (threadId: string, requestKey: string) =>
    sql`INSERT INTO search_backfill_requests (thread_id, activation, complete)
      VALUES (${threadId}, ${requestKey}, 0) ON CONFLICT(thread_id, activation) DO NOTHING`;
  const observeThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const current = yield* ensureCurrentState;
      if (current === null) return;
      yield* enqueue(threadId, current.requestKey);
      const pending = yield* sql`SELECT 1 FROM search_backfill_requests
      WHERE thread_id = ${threadId} AND activation = ${current.requestKey} AND complete = 0`;
      if (pending.length > 0) {
        const now = yield* Clock.currentTimeMillis;
        yield* alarm.by(now + 1_000);
      }
    });
  const step = Effect.gen(function* () {
    const current = yield* ensureCurrentState;
    if (current === null) return;
    const actor = { userId: current.profile.id, contextIds: yield* contexts.contextIds };
    // Membership is committed with the summary. This cursor recovers a lost enqueue
    // and registrations inserted behind the initial scan's lexical position.
    const registrations = yield* sql.withTransaction(
      Effect.gen(function* () {
        const [cursor] = yield* sql<{ readonly sequence: number }>`SELECT sequence
        FROM search_backfill_registration_cursor WHERE id = 1`;
        const rows = yield* store.threadRegistrations(cursor?.sequence ?? 0, 8);
        for (const row of rows) yield* enqueue(row.threadId, current.requestKey);
        const last = rows.at(-1);
        if (last !== undefined)
          yield* sql`UPDATE search_backfill_registration_cursor
        SET sequence = ${last.sequence} WHERE id = 1`;
        return rows;
      }),
    );
    let more = false;
    if (!current.complete) {
      const registry = yield* store.threadIndex;
      // Include archived and stopped threads. Access filtering happens on the query path.
      const ordered = registry.threads.toSorted((a, b) =>
        a.shell.id < b.shell.id ? -1 : a.shell.id > b.shell.id ? 1 : 0,
      );
      const batch = ordered.filter((row) => row.shell.id > current.after).slice(0, 8);
      const last = batch.at(-1)?.shell.id;
      more = last !== undefined && ordered.some((row) => row.shell.id > last);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const row of batch) yield* enqueue(row.shell.id, current.requestKey);
          yield* sql`UPDATE search_backfill_state SET after_id = ${last ?? current.after},
          complete = ${more ? 0 : 1} WHERE id = 1`;
        }),
      );
    }
    const pending = yield* sql<{ readonly thread_id: string }>`SELECT thread_id
      FROM search_backfill_requests WHERE activation = ${current.requestKey} AND complete = 0
      ORDER BY thread_id LIMIT 8`;
    for (const row of pending) {
      // A generation activation replays the source snapshot even when retained
      // destination progress says this thread was complete before the switch.
      yield* threads
        .forThread(ThreadId.make(row.thread_id))
        .backfill(actor, current.requestKey)
        .pipe(Effect.catchTags({ ThreadNotFoundError: () => Effect.void }));
      yield* sql`UPDATE search_backfill_requests SET complete = 1
        WHERE thread_id = ${row.thread_id} AND activation = ${current.requestKey}`;
    }
    const remaining = yield* sql`SELECT 1 FROM search_backfill_requests
      WHERE activation = ${current.requestKey} AND complete = 0 LIMIT 1`;
    const now = yield* Clock.currentTimeMillis;
    if (more || remaining.length > 0 || registrations.length === 8) yield* alarm.by(now + 1_000);
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
  return SearchBackfill.of({ activation, ready, observeThread, step });
});

export const layer = Layer.effect(SearchBackfill, make);
