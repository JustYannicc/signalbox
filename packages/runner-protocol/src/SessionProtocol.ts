import { NonNegativeInt } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { jsonCodec } from "./jsonCodec.ts";

/**
 * How a thread's machine keeps its harness sessions off the machine (#112,
 * #132). Each harness writes its own session as JSON lines: Claude Code its
 * transcript and subagent sidecars, Codex its rollout files. The Runner
 * streams every line to the thread's object as it is written, verbatim, so a
 * new machine can restore the session at its latest durable row and resume it
 * natively. Thinking signatures and encrypted reasoning are never parsed.
 *
 * A session is a set of streams, each an append-only list of rows:
 *
 * - `append` adds rows to a stream at `offset`, the number of rows the
 *   machine believes the stream already holds. Rows land only directly after
 *   the stored ones, so a stream is always a gapless prefix of what the
 *   harness wrote. A repeat of rows already stored is acknowledged and
 *   changes nothing; rows past a gap are answered `gap` with the stored count.
 * - `streams` lists the streams under a prefix with their row counts.
 * - `rows` reads one stream, a page at a time from row `from`.
 *
 * Every call carries the thread's session token as a bearer token. It names
 * the thread and its machine generation; a token from an older machine is
 * refused, so a machine the thread gave up on can never write again.
 */

export const SESSION_API_PREFIX = "/api/runner/sessions";
export const SESSION_PATHS = {
  append: `${SESSION_API_PREFIX}/append`,
  streams: `${SESSION_API_PREFIX}/streams`,
  rows: `${SESSION_API_PREFIX}/rows`,
} as const;

/** Claude Code's streams: `claude/<session id>`, and `claude/<session id>/<subpath>` for sidecars. */
export const CLAUDE_STREAM_PREFIX = "claude/";
/** Codex's streams: `codex/<path under CODEX_HOME/sessions>`. */
export const CODEX_STREAM_PREFIX = "codex/";

/**
 * Slash-separated, non-empty segments, none of them `.` or `..`, without
 * control characters. Names are only keys here; the machine still checks a
 * name before it turns one into a path.
 */
export const isStreamName = (name: string) =>
  name.length > 0 &&
  name.length <= 1024 &&
  [...name].every((char) => char > "\u001f" && char !== "\u007f" && char !== "\\") &&
  name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

export const StreamName = Schema.String.check(Schema.makeFilter(isStreamName));

/** What a thread's machine gets with each turn: the token for its session streams. */
export const SessionAccess = Schema.Struct({ token: Schema.String });
export type SessionAccess = typeof SessionAccess.Type;

export const SessionAppend = Schema.Struct({
  stream: StreamName,
  offset: NonNegativeInt,
  /** Each row one JSON line, without its newline. */
  rows: Schema.Array(Schema.String),
});
export type SessionAppend = typeof SessionAppend.Type;

/** `stored`: the rows are durable; `gap`: nothing was written, the stream holds `count` rows. */
export const SessionAppendResult = Schema.Struct({
  _tag: Schema.Literals(["stored", "gap"]),
  count: NonNegativeInt,
});
export type SessionAppendResult = typeof SessionAppendResult.Type;

export const SessionStreams = Schema.Struct({
  streams: Schema.Array(Schema.Struct({ stream: StreamName, count: NonNegativeInt })),
});
export type SessionStreams = typeof SessionStreams.Type;

/** One page of a stream's rows; `more` until the last. */
export const SessionRowsPage = Schema.Struct({
  rows: Schema.Array(Schema.String),
  more: Schema.Boolean,
});
export type SessionRowsPage = typeof SessionRowsPage.Type;

/** Most bytes of rows the machine sends in one `append`. Bigger batches are split. */
export const MAX_APPEND_BYTES = 8 * 1024 * 1024;
/** About the most row text one `rows` page carries; a page always holds at least one row. */
export const ROWS_PAGE_CHARS = 4 * 1024 * 1024;

export const sessionJson = {
  append: jsonCodec(SessionAppend),
  appendResult: jsonCodec(SessionAppendResult),
  streams: jsonCodec(SessionStreams),
  rows: jsonCodec(SessionRowsPage),
};
