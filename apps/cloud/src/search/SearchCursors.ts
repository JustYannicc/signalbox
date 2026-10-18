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
    readonly save: (cursor: SearchCursor) => Effect.Effect<string, SearchIndexError>;
  }
>()("@signalbox/cloud/search/SearchCursors") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const ensure = sql`CREATE TABLE IF NOT EXISTS search_cursors (
    token TEXT PRIMARY KEY, cursor TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`;
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
    save: (cursor) =>
      Effect.gen(function* () {
        yield* ensure;
        const now = yield* Clock.currentTimeMillis;
        const token = yield* Effect.orDie(crypto.randomUUIDv4());
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM search_cursors WHERE expires_at <= ${now}`;
            yield* sql`INSERT INTO search_cursors (token, cursor, expires_at)
          VALUES (${token}, ${encodeSearchCursor(cursor)}, ${now + 900_000})`;
          }),
        );
        return token;
      }).pipe(
        Effect.mapError((cause) => new SearchIndexError({ operation: "cursor_save", cause })),
      ),
  });
});

export const layerSql = Layer.effect(SearchCursors, make);
