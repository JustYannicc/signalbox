import { ProjectSearchContentsResult } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/sql/SqlError";
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
      repository: Schema.optional(Schema.NullOr(Schema.String)),
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
const Page = Schema.Struct({
  response: ProjectSearchContentsResult,
  skippedSource: Schema.Boolean,
});
export type ContentSearchPage = typeof Page.Type;
const pageCodec = Schema.fromJsonString(Page);
const decodePage = Schema.decodeUnknownOption(pageCodec);
const encodePage = Schema.encodeSync(pageCodec);

export class ContentSearchCursors extends Context.Service<
  ContentSearchCursors,
  {
    readonly read: (token: string) => Effect.Effect<ContentSearchCursor | null, SqlError>;
    readonly save: (state: ContentSearchCursor) => Effect.Effect<string, SqlError>;
    readonly bind: (
      token: string,
      expected: ContentSearchCursor,
      resolved: ContentSearchCursor,
    ) => Effect.Effect<ContentSearchCursor | null, SqlError>;
    readonly readPage: (token: string) => Effect.Effect<ContentSearchPage | null, SqlError>;
    readonly commitPage: (
      token: string,
      page: ContentSearchPage,
    ) => Effect.Effect<ContentSearchPage | null, SqlError>;
  }
>()("@signalbox/cloud/user/ContentSearchCursors") {}

/** Tokens contain no source paths and are replayable until expiry, including after a cold start. */
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const ensure = Effect.gen(function* () {
    yield* sql`CREATE TABLE IF NOT EXISTS drive_content_search_cursors (
      token TEXT PRIMARY KEY, state TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`;
    yield* sql`CREATE INDEX IF NOT EXISTS drive_content_search_cursors_expiry
      ON drive_content_search_cursors (expires_at, token)`;
    yield* sql`CREATE TABLE IF NOT EXISTS drive_content_search_pages (
      token TEXT PRIMARY KEY, page TEXT NOT NULL
    )`;
  });
  const read = (token: string) =>
    Effect.gen(function* () {
      yield* ensure;
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{
        readonly state: string;
      }>`SELECT state FROM drive_content_search_cursors
        WHERE token = ${token} AND expires_at > ${now}`;
      return rows[0] === undefined ? null : Option.getOrNull(decode(rows[0].state));
    });
  const readPage = (token: string) =>
    Effect.gen(function* () {
      yield* ensure;
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{ readonly page: string }>`SELECT pages.page
        FROM drive_content_search_pages AS pages
        JOIN drive_content_search_cursors AS cursors ON cursors.token = pages.token
        WHERE pages.token = ${token} AND cursors.expires_at > ${now}`;
      return rows[0] === undefined ? null : Option.getOrNull(decodePage(rows[0].page));
    });
  return ContentSearchCursors.of({
    read,
    readPage,
    commitPage: (token, page) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* ensure;
          const now = yield* Clock.currentTimeMillis;
          yield* sql`INSERT INTO drive_content_search_pages (token, page)
            SELECT token, ${encodePage(page)} FROM drive_content_search_cursors
            WHERE token = ${token} AND expires_at > ${now}
            ON CONFLICT (token) DO NOTHING`;
          return yield* readPage(token);
        }),
      ),
    bind: (token, expected, resolved) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* ensure;
          const now = yield* Clock.currentTimeMillis;
          yield* sql`UPDATE drive_content_search_cursors SET state = ${encode(resolved)}
        WHERE token = ${token} AND state = ${encode(expected)} AND expires_at > ${now}`;
          return yield* read(token);
        }),
      ),
    save: (state: ContentSearchCursor) =>
      Effect.gen(function* () {
        yield* ensure;
        const now = yield* Clock.currentTimeMillis;
        const token = yield* Effect.orDie(crypto.randomUUIDv4());
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const expired = yield* sql<{ readonly token: string }>`SELECT token
              FROM drive_content_search_cursors WHERE expires_at <= ${now}
              ORDER BY expires_at, token LIMIT 128`;
            if (expired.length > 0) {
              const tokens = expired.map((row) => row.token);
              yield* sql`DELETE FROM drive_content_search_pages WHERE token IN ${sql.in(tokens)}`;
              yield* sql`DELETE FROM drive_content_search_cursors WHERE token IN ${sql.in(tokens)}`;
            }
            yield* sql`INSERT INTO drive_content_search_cursors (token, state, expires_at)
          VALUES (${token}, ${encode(state)}, ${now + 900_000})`;
          }),
        );
        return token;
      }),
  });
});

export const layerSql = Layer.effect(ContentSearchCursors, make);
