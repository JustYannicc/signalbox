import { toJson } from "@signalbox/automations/json";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Subscription credentials stay in their owner's encrypted Durable Object storage. */
export interface SubscriptionRow {
  readonly id: string;
  readonly project_id: string;
  readonly repository: string;
  readonly secret: string;
  readonly hook_id: number | null;
  readonly events_json: string;
  readonly enabled: number;
  readonly error: string | null;
  readonly retry_at: number | null;
  readonly mode: "webhook" | "release-poll" | "unavailable";
  readonly poll_seeded: number;
}

export const makeGitHubWebhookStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS signalbox_github_subscriptions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, repository TEXT NOT NULL,
    secret TEXT NOT NULL, hook_id INTEGER, events_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, error TEXT, retry_at INTEGER DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'webhook', poll_seeded INTEGER NOT NULL DEFAULT 0,
    UNIQUE (project_id, repository)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS signalbox_github_pr_facts (
    subscription_id TEXT NOT NULL, number INTEGER NOT NULL, head_sha TEXT NOT NULL,
    checks_state TEXT, mergeability TEXT, PRIMARY KEY (subscription_id, number)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS signalbox_github_releases_seen (
    subscription_id TEXT NOT NULL, release_id INTEGER NOT NULL,
    PRIMARY KEY (subscription_id, release_id)
  )`;
  return {
    list: sql<SubscriptionRow>`SELECT * FROM signalbox_github_subscriptions`,
    get: (id: string) =>
      sql<SubscriptionRow>`SELECT * FROM signalbox_github_subscriptions WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]),
      ),
    insert: (input: {
      readonly id: string;
      readonly projectId: string;
      readonly repository: string;
      readonly secret: string;
      readonly events: ReadonlyArray<string>;
    }) =>
      sql`INSERT INTO signalbox_github_subscriptions (id, project_id, repository, secret, events_json)
        VALUES (${input.id}, ${input.projectId}, ${input.repository}, ${input.secret}, ${toJson(input.events)})
        ON CONFLICT (project_id, repository) DO NOTHING`,
    want: (id: string, events: ReadonlyArray<string>) => sql`UPDATE signalbox_github_subscriptions
      SET events_json = ${toJson(events)}, enabled = 1, retry_at = 0, error = NULL, mode = 'webhook' WHERE id = ${id}`,
    disable: (id: string) =>
      sql`UPDATE signalbox_github_subscriptions SET enabled = 0, retry_at = 0 WHERE id = ${id}`,
    ready: (id: string, hookId: number, events: string) => sql`UPDATE signalbox_github_subscriptions
      SET hook_id = ${hookId}, error = NULL,
        retry_at = CASE WHEN enabled = 1 AND events_json = ${events} THEN NULL ELSE 0 END,
        mode = 'webhook' WHERE id = ${id}`,
    failed: (id: string, error: string, mode: SubscriptionRow["mode"]) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE signalbox_github_subscriptions SET error = ${error}, mode = ${mode},
        retry_at = ${now + 5 * 60_000} WHERE id = ${id}`;
      }),
    polled: (id: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE signalbox_github_subscriptions SET poll_seeded = 1,
        retry_at = ${now + 5 * 60_000} WHERE id = ${id}`;
      }),
    remove: (id: string) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM signalbox_github_subscriptions WHERE id = ${id} AND enabled = 0`;
        // If it was enabled again while GitHub removed its hook, install it again.
        yield* sql`UPDATE signalbox_github_subscriptions SET hook_id = NULL, retry_at = 0 WHERE id = ${id}`;
      }).pipe(sql.withTransaction),
    nextAt: sql<{
      readonly at: number | null;
    }>`SELECT MIN(retry_at) AS at FROM signalbox_github_subscriptions`.pipe(
      Effect.map((rows) => rows[0]?.at ?? null),
    ),
    previous: (id: string, number: number) =>
      sql<{
        readonly head_sha: string;
        readonly checks_state: string | null;
        readonly mergeability: string | null;
      }>`
      SELECT head_sha, checks_state, mergeability FROM signalbox_github_pr_facts
      WHERE subscription_id = ${id} AND number = ${number}`.pipe(Effect.map((rows) => rows[0])),
    facts: (
      id: string,
      number: number,
      facts: {
        readonly headSha: string;
        readonly checksState: string | null;
        readonly mergeability: string | null;
      },
    ) => sql`
      INSERT INTO signalbox_github_pr_facts (subscription_id, number, head_sha, checks_state, mergeability)
      VALUES (${id}, ${number}, ${facts.headSha}, ${facts.checksState}, ${facts.mergeability})
      ON CONFLICT (subscription_id, number) DO UPDATE SET head_sha = excluded.head_sha,
        checks_state = excluded.checks_state, mergeability = excluded.mergeability`,
    seen: (id: string, releaseId: number) =>
      sql<{ readonly release_id: number }>`
      SELECT release_id FROM signalbox_github_releases_seen
      WHERE subscription_id = ${id} AND release_id = ${releaseId}`.pipe(
        Effect.map((rows) => rows.length > 0),
      ),
    see: (
      id: string,
      releaseId: number,
    ) => sql`INSERT INTO signalbox_github_releases_seen (subscription_id, release_id)
      VALUES (${id}, ${releaseId}) ON CONFLICT DO NOTHING`,
  };
});

export type GitHubWebhookStore = Effect.Success<typeof makeGitHubWebhookStore>;
