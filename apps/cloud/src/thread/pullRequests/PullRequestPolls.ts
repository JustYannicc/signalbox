import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * When a thread last asked GitHub about each of its linked pull requests,
 * and when GitHub asked it to wait until. Kept in storage rather than memory
 * because an idle thread's object is evicted between polls, and its backoff
 * has to survive that. The table comes with the thread (`ThreadStore`'s
 * migration `0008_pull_request_polls`).
 */

export const migratePullRequestPolls = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE pull_request_polls (
    key TEXT PRIMARY KEY,
    polled_at INTEGER NOT NULL,
    retry_at INTEGER
  )`;
});

export interface PullRequestPoll {
  /** `threadPullRequestKeyOf` the link. */
  readonly key: string;
  readonly polledAt: number;
  /** GitHub's rate limit asked to wait until then. */
  readonly retryAt: number | null;
}

const PollRow = Schema.Struct({
  key: Schema.String,
  polled_at: Schema.Number,
  retry_at: Schema.NullOr(Schema.Number),
});
const decodeRows = Schema.decodeUnknownSync(Schema.Array(PollRow));

export class PullRequestPolls extends Context.Service<
  PullRequestPolls,
  {
    readonly all: Effect.Effect<ReadonlyMap<string, PullRequestPoll>, SqlError>;
    /** Replaces every poll: links no longer on the thread drop out. */
    readonly replace: (polls: ReadonlyArray<PullRequestPoll>) => Effect.Effect<void, SqlError>;
  }
>()("@signalbox/cloud/thread/pullRequests/PullRequestPolls") {}

export const layer = Layer.effect(
  PullRequestPolls,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return PullRequestPolls.of({
      all: sql`SELECT key, polled_at, retry_at FROM pull_request_polls`.pipe(
        Effect.map(
          (rows) =>
            new Map(
              decodeRows(rows).map((row) => [
                row.key,
                { key: row.key, polledAt: row.polled_at, retryAt: row.retry_at },
              ]),
            ),
        ),
      ),
      replace: (polls) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM pull_request_polls`;
          for (const poll of polls) {
            yield* sql`INSERT INTO pull_request_polls (key, polled_at, retry_at)
              VALUES (${poll.key}, ${poll.polledAt}, ${poll.retryAt})`;
          }
        }).pipe(sql.withTransaction),
    });
  }),
);
