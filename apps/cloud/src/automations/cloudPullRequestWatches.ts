import {
  AutomationError,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import type { AutomationThreadsShape } from "@signalbox/automations/host";
import type { WorkflowEngineShape } from "@signalbox/automations/WorkflowEngine";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { watchPullRequestForThread } from "./cloudTools.ts";

type WatchTarget = Pick<ThreadPullRequestLink, "host" | "repository" | "number" | "url">;
type WatchResult = { readonly watching: boolean; readonly wasWatching: boolean };
type WatchRequest = { readonly target: WatchTarget; readonly watching: boolean };

interface WatchRow extends WatchTarget {
  readonly thread_id: string;
  readonly key: string;
  readonly state: "pending" | "applied";
  readonly started_at: string | null;
}

/** The thread owns intent; this journal makes its external workflow effects retryable. */
export const ensureCloudPullRequestWatches = SqlClient.SqlClient.use((sql) =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE IF NOT EXISTS signalbox_automation_thread_pr_watches (
        thread_id TEXT NOT NULL,
        key TEXT NOT NULL,
        host TEXT NOT NULL,
        repository TEXT NOT NULL,
        number INTEGER NOT NULL,
        url TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'applied')),
        started_at TEXT,
        PRIMARY KEY (thread_id, key)
      )`;
  }),
);

export const makeCloudPullRequestWatches = (deps: {
  readonly engine: Pick<WorkflowEngineShape, "watchPullRequest">;
  readonly threads: Pick<AutomationThreadsShape, "getThreadShell">;
  readonly runningAttached: (
    threadId: string,
    key: string,
  ) => Effect.Effect<string | undefined, AutomationError>;
  readonly clearWatch: (
    threadId: string,
    target: WatchTarget,
    startedAt: string,
  ) => Effect.Effect<void, AutomationError>;
  readonly sql: SqlClient.SqlClient;
}) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const sql = deps.sql;
    const desiredFor = (shell: OrchestrationV2ThreadShell | null) => {
      const enabled =
        shell !== null &&
        shell.deletedAt === null &&
        shell.archivedAt === null &&
        shell.settledAt === null &&
        shell.settledOverride !== "settled";
      return new Map(
        (enabled ? visibleThreadPullRequests(shell?.pullRequests ?? []) : [])
          .filter((link) => link.watch !== undefined)
          .map((link) => [threadPullRequestKeyOf(link), link] as const),
      );
    };

    const put = (
      threadId: string,
      target: WatchTarget,
      state: WatchRow["state"],
      startedAt: string | null,
    ) =>
      sql`
        INSERT INTO signalbox_automation_thread_pr_watches
          (thread_id, key, host, repository, number, url, state, started_at)
        VALUES (
          ${threadId}, ${threadPullRequestKeyOf(target)}, ${target.host},
          ${target.repository}, ${target.number}, ${target.url}, ${state}, ${startedAt}
        )
        ON CONFLICT (thread_id, key) DO UPDATE SET
          host = excluded.host,
          repository = excluded.repository,
          number = excluded.number,
          url = excluded.url,
          state = excluded.state,
          started_at = excluded.started_at
      `.pipe(Effect.asVoid);

    const remove = (threadId: string, key: string, startedAt?: string | null) =>
      startedAt === undefined
        ? sql`
            DELETE FROM signalbox_automation_thread_pr_watches
            WHERE thread_id = ${threadId} AND key = ${key}
          `.pipe(Effect.asVoid)
        : sql`
            DELETE FROM signalbox_automation_thread_pr_watches
            WHERE thread_id = ${threadId} AND key = ${key} AND started_at IS ${startedAt}
          `.pipe(Effect.asVoid);

    const reconcile = (threadId: string, request?: WatchRequest) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const requestedKey =
            request === undefined ? undefined : threadPullRequestKeyOf(request.target);
          let requestedOutcome: WatchResult | undefined;

          // A concurrent command can change intent while the workflow engine is starting or
          // stopping. Repeat from the latest authorized shell until its effects are journaled.
          let forceStart = request?.watching === true;
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const shell = yield* deps.threads.getThreadShell(ThreadId.make(threadId));
            const desired = desiredFor(shell);
            const desiredKeys = new Set(desired.keys());
            const applied = yield* sql<WatchRow>`
              SELECT thread_id, key, host, repository, number, url, state, started_at
              FROM signalbox_automation_thread_pr_watches
              WHERE thread_id = ${threadId}
            `;
            const appliedByKey = new Map(applied.map((row) => [row.key, row] as const));

            for (const row of applied) {
              if (desiredKeys.has(row.key)) continue;
              // Keep a durable cancellation marker until the engine confirms it.
              yield* put(threadId, row, "pending", row.started_at);
              const outcome = yield* deps.engine.watchPullRequest(
                {
                  threadId,
                  host: row.host,
                  repository: row.repository,
                  number: row.number,
                  url: row.url,
                  watching: false,
                },
                {},
              );
              yield* remove(threadId, row.key, row.started_at);
              if (row.key === requestedKey) requestedOutcome = outcome;
            }

            for (const [key, link] of desired) {
              if (shell === null) continue;
              const previous = appliedByKey.get(key);
              const startRequested = forceStart && key === requestedKey;
              const startedAt = link.watch!.startedAt;
              if (
                previous?.state === "applied" &&
                previous.started_at === startedAt &&
                !startRequested
              ) {
                if (key === requestedKey) requestedOutcome = { watching: true, wasWatching: true };
                continue;
              }

              // Journal before starting so retries can resume after an ambiguous engine failure.
              yield* put(threadId, link, "pending", startedAt);
              const outcome = yield* watchPullRequestForThread(deps.engine, shell, link, true);
              yield* put(threadId, link, "applied", startedAt);
              if (key === requestedKey) requestedOutcome = outcome;
            }

            // An explicit unwatch also cleans up a workflow whose start succeeded
            // before its first journal row, or whose row was lost.
            if (
              request?.watching === false &&
              requestedKey !== undefined &&
              !desiredKeys.has(requestedKey) &&
              !appliedByKey.has(requestedKey)
            ) {
              yield* put(threadId, request.target, "pending", null);
              requestedOutcome = yield* deps.engine.watchPullRequest(
                { threadId, ...request.target, watching: false },
                {},
              );
              yield* remove(threadId, requestedKey, null);
            }

            forceStart = false;
            const latestShell = yield* deps.threads.getThreadShell(ThreadId.make(threadId));
            const latestDesired = desiredFor(latestShell);
            const rows = yield* sql<WatchRow>`
              SELECT thread_id, key, host, repository, number, url, state, started_at
              FROM signalbox_automation_thread_pr_watches
              WHERE thread_id = ${threadId}
            `;
            const converged =
              rows.length === latestDesired.size &&
              rows.every(
                (row) =>
                  row.state === "applied" &&
                  latestDesired.get(row.key)?.watch?.startedAt === row.started_at,
              );
            if (!converged) continue;

            if (request === undefined) return { watching: false, wasWatching: false };
            return {
              watching: latestDesired.has(requestedKey!),
              wasWatching: requestedOutcome?.wasWatching ?? false,
            };
          }

          return yield* new AutomationError({
            message: "Pull request watch intent kept changing during reconciliation; retry it.",
          });
        }),
      );

    const resumePending = () =>
      Effect.gen(function* () {
        const threads = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id
          FROM signalbox_automation_thread_pr_watches
          WHERE state = 'pending'
          GROUP BY thread_id
          ORDER BY thread_id
          LIMIT 50
        `;
        let retrySoon = false;
        for (const { thread_id } of threads) {
          yield* reconcile(thread_id).pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                retrySoon = true;
                yield* Effect.logWarning("Pending pull request watch reconciliation failed", {
                  threadId: thread_id,
                  cause,
                });
              }),
            ),
          );
        }
        const remaining = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id
          FROM signalbox_automation_thread_pr_watches
          WHERE state = 'pending'
          LIMIT 1
        `;
        return retrySoon || remaining.length > 0;
      });

    const reconcileEnded = () =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          let retrySoon = false;
          const applied = yield* sql<WatchRow & { readonly started_at: string }>`
            SELECT thread_id, key, host, repository, number, url, state, started_at
            FROM signalbox_automation_thread_pr_watches
            WHERE state = 'applied' AND started_at IS NOT NULL
          `;

          for (const row of applied) {
            const shell = yield* deps.threads.getThreadShell(ThreadId.make(row.thread_id));
            const link = desiredFor(shell).get(row.key);
            const watch = link?.watch;
            if (shell === null || link === undefined || watch === undefined) {
              if (yield* deps.runningAttached(row.thread_id, `pull-request:${row.key}`)) {
                yield* deps.engine.watchPullRequest(
                  {
                    threadId: row.thread_id,
                    host: row.host,
                    repository: row.repository,
                    number: row.number,
                    url: row.url,
                    watching: false,
                  },
                  {},
                );
              }
              yield* remove(row.thread_id, row.key, row.started_at);
              continue;
            }

            const startedAt = watch.startedAt;
            if (row.started_at !== startedAt) {
              // A new watch generation is explicit intent; refresh the attached automation.
              yield* put(row.thread_id, link, "pending", startedAt);
              yield* watchPullRequestForThread(deps.engine, shell, link, true);
              yield* put(row.thread_id, link, "applied", startedAt);
              continue;
            }
            const attached = `pull-request:${row.key}`;
            if (yield* deps.runningAttached(row.thread_id, attached)) continue;

            yield* deps.clearWatch(row.thread_id, row, startedAt);
            const latest = yield* deps.threads.getThreadShell(ThreadId.make(row.thread_id));
            if (desiredFor(latest).get(row.key)?.watch?.startedAt === startedAt) {
              // The guarded thread command did not clear this generation. Keep the receipt
              // and retry; a concurrent rewatch is handled by its newer generation instead.
              retrySoon = true;
              continue;
            }
            yield* remove(row.thread_id, row.key, row.started_at);
          }

          return retrySoon;
        }),
      );

    return { reconcile, resumePending, reconcileEnded };
  });
