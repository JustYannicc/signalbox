import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { KernelBrowser } from "./KernelApi.ts";

/**
 * Where the person's object keeps their browser's sessions (`PersonBrowsers`):
 * one row per Kernel session. Fork tables, so they create themselves. A
 * session's CDP URL is a credential, stored like the 1Password token:
 * Durable Object storage is encrypted at rest.
 */

const ensureTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS signalbox_person_browser_sessions (
    session_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    cdp_ws_url TEXT NOT NULL,
    writer INTEGER NOT NULL,
    started_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS signalbox_person_browser_sessions_thread
    ON signalbox_person_browser_sessions (thread_id)`;
});

const SessionRow = Schema.Struct({
  session_id: Schema.String,
  thread_id: Schema.String,
  cdp_ws_url: Schema.String,
  writer: Schema.BooleanFromBit,
});
export type SessionRow = typeof SessionRow.Type;
const decodeRows = Schema.decodeUnknownSync(Schema.Array(SessionRow));

export const makeBrowserSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.orDie(ensureTables);
  return {
    /** The person's sessions not ended yet, newest first. */
    open: Effect.map(
      sql`SELECT session_id, thread_id, cdp_ws_url, writer FROM signalbox_person_browser_sessions
        ORDER BY started_at DESC`,
      decodeRows,
    ),
    record: (threadId: string, browser: KernelBrowser, writer: boolean) =>
      Effect.flatMap(
        Clock.currentTimeMillis,
        (now) => sql`INSERT INTO signalbox_person_browser_sessions
          (session_id, thread_id, cdp_ws_url, writer, started_at)
          VALUES (${browser.session_id}, ${threadId}, ${browser.cdp_ws_url},
            ${writer ? 1 : 0}, ${now})`,
      ),
    /** Forgets an ended session, and with it its CDP URL. */
    ended: (sessionId: string) =>
      sql`DELETE FROM signalbox_person_browser_sessions WHERE session_id = ${sessionId}`,
    /** The thread's session, if one is open. */
    ofThread: (threadId: string) =>
      Effect.map(
        sql`SELECT session_id, thread_id, cdp_ws_url, writer FROM signalbox_person_browser_sessions
          WHERE thread_id = ${threadId} ORDER BY started_at DESC LIMIT 1`,
        (rows) => decodeRows(rows)[0] ?? null,
      ),
  };
});
