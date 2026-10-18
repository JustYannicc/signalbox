import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { DriveContentScanState } from "../drive/DriveContentScan.ts";

const Source = Schema.Struct({
  driveId: Schema.String,
  prefix: Schema.String,
  route: Schema.Array(
    Schema.Struct({ from: Schema.String, path: Schema.String, target: Schema.String }),
  ),
});
const Cursor = Schema.Struct({
  fingerprint: Schema.String,
  root: Schema.String,
  sources: Schema.Array(Source),
  seen: Schema.Array(Schema.String),
  current: Schema.optional(
    Schema.Struct({
      commit: Schema.NullOr(Schema.String),
      excluded: Schema.Array(Schema.String),
      links: Schema.Array(Schema.Struct({ path: Schema.String, target: Schema.String })),
      scan: Schema.optional(DriveContentScanState),
    }),
  ),
  truncated: Schema.Boolean,
});
export type ContentSearchCursor = typeof Cursor.Type;
export type ContentSearchSource = typeof Source.Type;
const codec = Schema.fromJsonString(Cursor);
const decode = Schema.decodeUnknownOption(codec);
const encode = Schema.encodeSync(codec);

/** Tokens contain no source paths and are replayable until expiry, including after a cold start. */
export const makeContentSearchCursors = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const ensure = sql`CREATE TABLE IF NOT EXISTS drive_content_search_cursors (
    token TEXT PRIMARY KEY, state TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`;
  return {
    read: (token: string) =>
      Effect.gen(function* () {
        yield* ensure;
        const now = yield* Clock.currentTimeMillis;
        const rows = yield* sql<{
          readonly state: string;
        }>`SELECT state FROM drive_content_search_cursors
        WHERE token = ${token} AND expires_at > ${now}`;
        return rows[0] === undefined ? null : Option.getOrNull(decode(rows[0].state));
      }),
    save: (state: ContentSearchCursor) =>
      Effect.gen(function* () {
        yield* ensure;
        const now = yield* Clock.currentTimeMillis;
        const token = yield* Effect.orDie(crypto.randomUUIDv4());
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM drive_content_search_cursors WHERE expires_at <= ${now}`;
            yield* sql`INSERT INTO drive_content_search_cursors (token, state, expires_at)
          VALUES (${token}, ${encode(state)}, ${now + 900_000})`;
          }),
        );
        return token;
      }),
  };
});
