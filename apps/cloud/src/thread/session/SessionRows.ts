import {
  ROWS_PAGE_CHARS,
  type SessionAppend,
  type SessionAppendResult,
  type SessionRowsPage,
} from "@signalbox/runner-protocol/SessionProtocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * A thread's harness session rows (`SessionProtocol.ts`), stored verbatim in
 * the thread object's own database. A stream only ever grows by rows placed
 * directly after the stored ones, so what is stored is always a prefix of what
 * the harness wrote, and resuming from it never skips a row.
 *
 * The tables are fork-owned and create themselves on first use rather than
 * taking a `ThreadStore` migration number another change may also claim. A
 * row longer than a Durable Object's SQLite value limit (2 MB) is split into
 * parts.
 */

/** UTF-16 units per stored part: at most 1.5 MB of UTF-8, under the 2 MB value limit. */
const PART_LENGTH = 500_000;

/** `body` in parts of at most `PART_LENGTH`, never splitting a surrogate pair. */
const parts = (body: string) => {
  const result: Array<string> = [];
  let start = 0;
  do {
    let end = Math.min(start + PART_LENGTH, body.length);
    const last = body.charCodeAt(end - 1);
    if (end < body.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    result.push(body.slice(start, end));
    start = end;
  } while (start < body.length);
  return result;
};

export interface SessionStream {
  readonly stream: string;
  readonly count: number;
}

export class SessionRows extends Context.Service<
  SessionRows,
  {
    /** Adds rows at `offset`, or answers `gap` when the stream holds fewer rows than that. */
    readonly append: (input: SessionAppend) => Effect.Effect<SessionAppendResult, SqlError>;
    /** Streams whose names start with `prefix`, with their row counts. */
    readonly streams: (prefix: string) => Effect.Effect<ReadonlyArray<SessionStream>, SqlError>;
    /** Rows of `stream` from row `from`, one page: about `ROWS_PAGE_CHARS`, at least one row. */
    readonly rows: (stream: string, from: number) => Effect.Effect<SessionRowsPage, SqlError>;
  }
>()("@signalbox/cloud/thread/session/SessionRows") {}

const decodeCounts = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ count: Schema.Number })),
);
const decodeStreams = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ stream: Schema.String, count: Schema.Number })),
);
const decodeSizes = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ row: Schema.Number, size: Schema.Number })),
);
const decodeParts = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ row: Schema.Number, body: Schema.String })),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  let ready = false;
  const tables = Effect.suspend(() =>
    ready
      ? Effect.void
      : Effect.gen(function* () {
          yield* sql`CREATE TABLE IF NOT EXISTS session_streams (
            stream TEXT PRIMARY KEY,
            count INTEGER NOT NULL
          )`;
          yield* sql`CREATE TABLE IF NOT EXISTS session_rows (
            stream TEXT NOT NULL,
            row INTEGER NOT NULL,
            part INTEGER NOT NULL,
            body TEXT NOT NULL,
            PRIMARY KEY (stream, row, part)
          )`;
          ready = true;
        }),
  );

  const countOf = (stream: string) =>
    sql`SELECT count FROM session_streams WHERE stream = ${stream}`.pipe(
      Effect.map((rows) => decodeCounts(rows)[0]?.count ?? 0),
    );

  const append: SessionRows["Service"]["append"] = (input) =>
    Effect.gen(function* () {
      yield* tables;
      const count = yield* countOf(input.stream);
      if (input.offset > count) return { _tag: "gap", count } as const;
      // Rows below `count` are a resend of what is stored; only the rest is new.
      const fresh = input.rows.slice(count - input.offset);
      for (const [index, body] of fresh.entries()) {
        const row = count + index;
        for (const [part, slice] of parts(body).entries()) {
          yield* sql`INSERT INTO session_rows (stream, row, part, body)
            VALUES (${input.stream}, ${row}, ${part}, ${slice})`;
        }
      }
      const next = count + fresh.length;
      if (fresh.length > 0) {
        yield* sql`INSERT INTO session_streams (stream, count) VALUES (${input.stream}, ${next})
          ON CONFLICT (stream) DO UPDATE SET count = excluded.count`;
      }
      return { _tag: "stored", count: next } as const;
    }).pipe(sql.withTransaction);

  const streams: SessionRows["Service"]["streams"] = (prefix) =>
    Effect.andThen(
      tables,
      // A range, so the primary key serves it: every name starting with `prefix`.
      sql`SELECT stream, count FROM session_streams
        WHERE stream >= ${prefix} AND stream < ${`${prefix}\uffff`} ORDER BY stream`.pipe(
        Effect.map(decodeStreams),
      ),
    );

  const rows: SessionRows["Service"]["rows"] = (stream, from) =>
    Effect.gen(function* () {
      yield* tables;
      // Which rows fit the page, by stored size, before reading any of them.
      const sizes = decodeSizes(
        yield* sql`SELECT row, SUM(length(body)) AS size FROM session_rows
          WHERE stream = ${stream} AND row >= ${from} GROUP BY row ORDER BY row`,
      );
      let end = from;
      let chars = 0;
      for (const { row, size } of sizes) {
        if (row > end || (row > from && chars + size > ROWS_PAGE_CHARS)) break;
        chars += size;
        end = row + 1;
      }
      const joined: Array<string> = [];
      for (const { row, body } of decodeParts(
        yield* sql`SELECT row, body FROM session_rows
          WHERE stream = ${stream} AND row >= ${from} AND row < ${end} ORDER BY row, part`,
      )) {
        joined[row - from] = (joined[row - from] ?? "") + body;
      }
      return { rows: joined, more: end < from + sizes.length };
    });

  return SessionRows.of({ append, streams, rows });
});

export const layer = Layer.effect(SessionRows, make);
