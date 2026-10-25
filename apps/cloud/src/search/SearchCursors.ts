import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { SearchIndexError } from "./SearchIndex.ts";
import { decodeSearchCursor, encodeSearchCursor, type SearchCursor } from "./searchCursor.ts";

/** Opaque, short-lived positions. A cursor never discloses a candidate denied by a later access check. */
export class SearchCursors extends Context.Service<
  SearchCursors,
  {
    readonly read: (token: string) => Effect.Effect<SearchCursor | null, SearchIndexError>;
    readonly seen: (cursor: SearchCursor) => Effect.Effect<ReadonlyArray<string>, SearchIndexError>;
    readonly save: (
      cursor: Omit<SearchCursor, "session" | "page">,
      previous?: SearchCursor | null,
      seenThreads?: ReadonlyArray<string>,
    ) => Effect.Effect<string, SearchIndexError>;
  }
>()("@signalbox/cloud/search/SearchCursors") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const ensure = Effect.gen(function* () {
    yield* sql`CREATE TABLE IF NOT EXISTS search_cursors (
      token TEXT PRIMARY KEY, cursor TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`;
    yield* sql`CREATE TABLE IF NOT EXISTS search_cursor_seen_threads (
      session TEXT NOT NULL, thread_id TEXT NOT NULL, page INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, PRIMARY KEY (session, thread_id)
    )`;
  });
  return SearchCursors.of({
    read: (token) =>
      Effect.gen(function* () {
        yield* ensure;
        const now = yield* Clock.currentTimeMillis;
        const rows = yield* sql<{ readonly cursor: string }>`SELECT cursor FROM search_cursors
        WHERE token = ${token} AND expires_at > ${now}`;
        return rows[0] === undefined ? null : Option.getOrNull(decodeSearchCursor(rows[0].cursor));
      }).pipe(
        Effect.mapError((cause) => new SearchIndexError({ operation: "cursor_read", cause })),
      ),
    seen: (cursor) =>
      Effect.gen(function* () {
        yield* ensure;
        const now = yield* Clock.currentTimeMillis;
        const rows = yield* sql<{ readonly thread_id: string }>`SELECT thread_id
        FROM search_cursor_seen_threads
        WHERE session = ${cursor.session} AND page <= ${cursor.page} AND expires_at > ${now}`;
        return rows.map((row) => row.thread_id);
      }).pipe(
        Effect.mapError((cause) => new SearchIndexError({ operation: "cursor_seen", cause })),
      ),
    save: (cursor, previous, seenThreads = []) =>
      Effect.gen(function* () {
        yield* ensure;
        const now = yield* Clock.currentTimeMillis;
        const token = yield* Effect.orDie(crypto.randomUUIDv4());
        const session = previous?.session ?? token;
        const page = (previous?.page ?? 0) + 1;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM search_cursors WHERE expires_at <= ${now}`;
            yield* sql`DELETE FROM search_cursor_seen_threads WHERE expires_at <= ${now}`;
            yield* sql`UPDATE search_cursor_seen_threads SET expires_at = ${now + 900_000}
              WHERE session = ${session}`;
            for (const threadId of seenThreads) {
              yield* sql`INSERT INTO search_cursor_seen_threads (session, thread_id, page, expires_at)
                VALUES (${session}, ${threadId}, ${page}, ${now + 900_000})
                ON CONFLICT(session, thread_id) DO UPDATE SET page = MIN(page, excluded.page),
                  expires_at = excluded.expires_at`;
            }
            yield* sql`INSERT INTO search_cursors (token, cursor, expires_at)
              VALUES (${token}, ${encodeSearchCursor({ ...cursor, session, page })}, ${now + 900_000})`;
          }),
        );
        return token;
      }).pipe(
        Effect.mapError((cause) => new SearchIndexError({ operation: "cursor_save", cause })),
      ),
  });
});

export const layerSql = Layer.effect(SearchCursors, make);
