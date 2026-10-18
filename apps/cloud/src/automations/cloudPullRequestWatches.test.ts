import { AutomationError, CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";

import type { AutomationThreadsShape } from "@signalbox/automations/host";
import type { WorkflowEngineShape } from "@signalbox/automations/WorkflowEngine";

import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { applyEvents, threadShellFromProjection } from "../thread/threadProjection.ts";
import { decide } from "../thread/threadDecider.ts";
import {
  ensureCloudPullRequestWatches,
  makeCloudPullRequestWatches,
} from "./cloudPullRequestWatches.ts";

type PullRequestWatchRequest = Parameters<WorkflowEngineShape["watchPullRequest"]>[0];
const threadId = ThreadId.make("thread-1");
const target = {
  host: "github.com",
  repository: "owner/repo",
  number: 4,
  url: "https://github.com/owner/repo/pull/4",
} as const;
const at = (iso: string) => ({ now: DateTime.makeUnsafe(iso) });

const makeWatchedShell = () => {
  const created = decide(
    null,
    {
      type: "thread.create",
      commandId: CommandId.make("create"),
      createdBy: "user",
      creationSource: "web",
      threadId,
      projectId: ProjectId.make("project-1"),
      title: "Ship it",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "signalbox/4",
      worktreePath: null,
    },
    at("2026-10-18T09:00:00.000Z"),
  );
  if (created._tag !== "accepted") throw new Error(created.message);
  const projection = applyEvents(null, created.events)!;
  const linked = decide(
    projection,
    {
      type: "thread.pull-request.link",
      commandId: CommandId.make("link"),
      threadId,
      ...target,
      source: "agent",
    },
    at("2026-10-18T09:01:00.000Z"),
  );
  if (linked._tag !== "accepted") throw new Error(linked.message);
  const linkedProjection = applyEvents(projection, linked.events)!;
  const watched = decide(
    linkedProjection,
    {
      type: "thread.pull-request.watch",
      commandId: CommandId.make("watch"),
      threadId,
      host: target.host,
      repository: target.repository,
      number: target.number,
      watching: true,
    },
    at("2026-10-18T09:02:00.000Z"),
  );
  if (watched._tag !== "accepted") throw new Error(watched.message);
  return threadShellFromProjection(applyEvents(linkedProjection, watched.events)!);
};

const withoutWatch = (shell: ReturnType<typeof makeWatchedShell>) => {
  const link = shell.pullRequests?.find((entry) => entry.number === target.number);
  if (link === undefined) throw new Error("The test pull request isn't linked.");
  const { watch: _watch, ...unwatched } = link;
  return {
    ...shell,
    pullRequests: shell.pullRequests?.map((entry) => (entry === link ? unwatched : entry)),
  };
};

const watchStartedAt = (shell: ReturnType<typeof makeWatchedShell>) => {
  const startedAt = shell.pullRequests?.find((entry) => entry.number === target.number)?.watch
    ?.startedAt;
  if (startedAt === undefined) throw new Error("The test pull request isn't watched.");
  return startedAt;
};

const insertAppliedWatch = (sql: SqlClient.SqlClient, startedAt: string) =>
  sql`
    INSERT INTO signalbox_automation_thread_pr_watches
      (thread_id, key, host, repository, number, url, state, started_at)
    VALUES
      ('thread-1', 'github.com/owner/repo#4', 'github.com', 'owner/repo', 4,
        'https://github.com/owner/repo/pull/4', 'applied', ${startedAt})
  `;

const runWithSqlite = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

describe("cloud pull request watches", () => {
  it.effect("cancels applied watches when the current shell is gone", () =>
    runWithSqlite(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* ensureCloudPullRequestWatches;
        yield* sql`
          INSERT INTO signalbox_automation_thread_pr_watches
            (thread_id, key, host, repository, number, url, state)
          VALUES
            ('thread-1', 'github.com/owner/repo#4', 'github.com', 'owner/repo', 4,
              'https://github.com/owner/repo/pull/4', 'applied')
        `;
        const calls: Array<PullRequestWatchRequest> = [];
        const engine = {
          watchPullRequest: (request: PullRequestWatchRequest) =>
            Effect.sync(() => {
              calls.push(request);
              return { watching: false, wasWatching: true };
            }),
        } satisfies Pick<WorkflowEngineShape, "watchPullRequest">;
        const threads = {
          getThreadShell: () => Effect.succeed(null),
        } satisfies Pick<AutomationThreadsShape, "getThreadShell">;
        const watches = yield* makeCloudPullRequestWatches({
          engine,
          threads,
          runningAttached: () => Effect.succeed(undefined),
          clearWatch: () => Effect.void,
          sql,
        });

        yield* watches.reconcile("thread-1");

        expect(calls).toEqual([
          {
            threadId: "thread-1",
            ...target,
            watching: false,
          },
        ]);
        expect(
          yield* sql<{ readonly key: string }>`
            SELECT key FROM signalbox_automation_thread_pr_watches
            WHERE thread_id = 'thread-1'
          `,
        ).toEqual([]);
      }),
    ),
  );

  it.effect("reconciles an unwatch that lands while the watch run is starting", () =>
    runWithSqlite(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* ensureCloudPullRequestWatches;
        let shell = makeWatchedShell();
        const calls: Array<PullRequestWatchRequest> = [];
        const active = new Set<string>();
        const engine = {
          watchPullRequest: (request: PullRequestWatchRequest) =>
            Effect.sync(() => {
              calls.push(request);
              const key = `${request.threadId}:${request.host}/${request.repository}#${request.number}`;
              if (request.watching) {
                active.add(key);
                // This models a concurrent thread command committed while start is in flight.
                shell = withoutWatch(shell);
                return { watching: true, wasWatching: false };
              }
              const wasWatching = active.delete(key);
              return { watching: false, wasWatching };
            }),
        } satisfies Pick<WorkflowEngineShape, "watchPullRequest">;
        const threads = {
          getThreadShell: () => Effect.succeed(shell),
        } satisfies Pick<AutomationThreadsShape, "getThreadShell">;
        const watches = yield* makeCloudPullRequestWatches({
          engine,
          threads,
          runningAttached: () => Effect.succeed(undefined),
          clearWatch: () => Effect.void,
          sql,
        });

        const result = yield* watches.reconcile("thread-1", { target, watching: true });

        expect(result).toEqual({ watching: false, wasWatching: true });
        expect(calls.map((request) => request.watching)).toEqual([true, false]);
        expect(active.size).toBe(0);
        expect(
          yield* sql<{ readonly key: string }>`
            SELECT key FROM signalbox_automation_thread_pr_watches
            WHERE thread_id = 'thread-1'
          `,
        ).toEqual([]);
      }),
    ),
  );

  it.effect("retries a pending journal after an ambiguous start failure", () =>
    runWithSqlite(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* ensureCloudPullRequestWatches;
        let shell = makeWatchedShell();
        const active = new Set<string>();
        let starts = 0;
        const key = `thread-1:${target.host}/${target.repository}#${target.number}`;
        const engine = {
          watchPullRequest: (request: PullRequestWatchRequest) =>
            Effect.gen(function* () {
              if (!request.watching) {
                const wasWatching = active.delete(key);
                return { watching: false, wasWatching };
              }
              starts += 1;
              const wasWatching = active.has(key);
              active.add(key);
              if (starts === 1)
                return yield* Effect.fail(new AutomationError({ message: "Reply was lost." }));
              return { watching: true, wasWatching };
            }),
        } satisfies Pick<WorkflowEngineShape, "watchPullRequest">;
        const threads = {
          getThreadShell: () => Effect.succeed(shell),
        } satisfies Pick<AutomationThreadsShape, "getThreadShell">;
        const watches = yield* makeCloudPullRequestWatches({
          engine,
          threads,
          runningAttached: () => Effect.succeed(undefined),
          clearWatch: () => Effect.void,
          sql,
        });

        const first = yield* Effect.exit(watches.reconcile("thread-1"));
        expect(first._tag).toBe("Failure");
        expect(
          yield* sql<{ readonly state: string }>`
            SELECT state FROM signalbox_automation_thread_pr_watches
            WHERE thread_id = 'thread-1'
          `,
        ).toEqual([{ state: "pending" }]);

        expect(yield* watches.resumePending()).toBe(false);

        expect(starts).toBe(2);
        expect(active.size).toBe(1);
        expect(
          yield* sql<{ readonly state: string }>`
            SELECT state FROM signalbox_automation_thread_pr_watches
            WHERE thread_id = 'thread-1'
          `,
        ).toEqual([{ state: "applied" }]);

        shell = withoutWatch(shell);
        yield* watches.reconcile("thread-1");
        expect(active.size).toBe(0);
        expect(
          yield* sql<{ readonly key: string }>`
            SELECT key FROM signalbox_automation_thread_pr_watches
            WHERE thread_id = 'thread-1'
          `,
        ).toEqual([]);
      }),
    ),
  );

  it.effect("clears a finished watch after a restart", () =>
    runWithSqlite(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* ensureCloudPullRequestWatches;
        let shell: ReturnType<typeof makeWatchedShell> | null = makeWatchedShell();
        const startedAt = watchStartedAt(shell);
        yield* insertAppliedWatch(sql, startedAt);
        const cleared: Array<{ threadId: string; startedAt: string }> = [];
        const engine = {
          watchPullRequest: (request: PullRequestWatchRequest) =>
            Effect.succeed({ watching: request.watching, wasWatching: false }),
        } satisfies Pick<WorkflowEngineShape, "watchPullRequest">;
        const threads = {
          getThreadShell: () => Effect.succeed(shell),
        } satisfies Pick<AutomationThreadsShape, "getThreadShell">;

        // A new Cloud automations instance recovers the same SQLite journal.
        const watches = yield* makeCloudPullRequestWatches({
          engine,
          threads,
          runningAttached: () => Effect.succeed(undefined),
          clearWatch: (threadId, _target, expectedStartedAt) =>
            Effect.sync(() => {
              cleared.push({ threadId, startedAt: expectedStartedAt });
              shell = shell === null ? null : withoutWatch(shell);
            }),
          sql,
        });

        expect(yield* watches.reconcileEnded()).toBe(false);
        expect(cleared).toEqual([{ threadId: "thread-1", startedAt }]);
        expect(shell?.pullRequests?.[0]).not.toHaveProperty("watch");
        expect(
          yield* sql<{ readonly key: string }>`
            SELECT key FROM signalbox_automation_thread_pr_watches
            WHERE thread_id = 'thread-1'
          `,
        ).toEqual([]);
      }),
    ),
  );

  it.effect("keeps the journal when cleanup commits but its reply is lost", () =>
    runWithSqlite(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* ensureCloudPullRequestWatches;
        let shell: ReturnType<typeof makeWatchedShell> | null = makeWatchedShell();
        const startedAt = watchStartedAt(shell);
        yield* insertAppliedWatch(sql, startedAt);
        let clearAttempts = 0;
        const engine = {
          watchPullRequest: (request: PullRequestWatchRequest) =>
            Effect.succeed({ watching: request.watching, wasWatching: false }),
        } satisfies Pick<WorkflowEngineShape, "watchPullRequest">;
        const threads = {
          getThreadShell: () => Effect.succeed(shell),
        } satisfies Pick<AutomationThreadsShape, "getThreadShell">;
        const first = yield* makeCloudPullRequestWatches({
          engine,
          threads,
          runningAttached: () => Effect.succeed(undefined),
          clearWatch: (_threadId, _target, expectedStartedAt) =>
            Effect.gen(function* () {
              clearAttempts += 1;
              if (expectedStartedAt !== startedAt) {
                return yield* Effect.fail(
                  new AutomationError({ message: "Wrong watch generation." }),
                );
              }
              shell = shell === null ? null : withoutWatch(shell);
              return yield* Effect.fail(new AutomationError({ message: "Reply was lost." }));
            }),
          sql,
        });

        const failedCleanup = yield* Effect.exit(first.reconcileEnded());
        expect(failedCleanup._tag).toBe("Failure");
        expect(
          yield* sql<{ readonly started_at: string | null }>`
            SELECT started_at FROM signalbox_automation_thread_pr_watches
            WHERE thread_id = 'thread-1'
          `,
        ).toEqual([{ started_at: startedAt }]);

        const afterRestart = yield* makeCloudPullRequestWatches({
          engine,
          threads,
          runningAttached: () => Effect.succeed(undefined),
          clearWatch: () => Effect.void,
          sql,
        });
        expect(yield* afterRestart.reconcileEnded()).toBe(false);
        expect(clearAttempts).toBe(1);
        expect(
          yield* sql<{ readonly key: string }>`
            SELECT key FROM signalbox_automation_thread_pr_watches
            WHERE thread_id = 'thread-1'
          `,
        ).toEqual([]);
      }),
    ),
  );

  it.effect("doesn't clear a watch that was replaced during terminal cleanup", () =>
    runWithSqlite(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* ensureCloudPullRequestWatches;
        let shell = makeWatchedShell();
        const oldStartedAt = watchStartedAt(shell);
        const newStartedAt = "2026-10-18T10:00:00.000Z";
        yield* insertAppliedWatch(sql, oldStartedAt);
        const link = shell.pullRequests?.find((entry) => entry.number === target.number);
        if (link?.watch === undefined) throw new Error("The test pull request isn't watched.");
        const nextWatch = { ...link.watch, startedAt: newStartedAt };
        const starts: Array<PullRequestWatchRequest> = [];
        const engine = {
          watchPullRequest: (request: PullRequestWatchRequest) =>
            Effect.sync(() => {
              starts.push(request);
              return { watching: true, wasWatching: false };
            }),
        } satisfies Pick<WorkflowEngineShape, "watchPullRequest">;
        const threads = {
          getThreadShell: () => Effect.succeed(shell),
        } satisfies Pick<AutomationThreadsShape, "getThreadShell">;
        let clearAttempts = 0;
        const watches = yield* makeCloudPullRequestWatches({
          engine,
          threads,
          runningAttached: () => Effect.succeed(undefined),
          clearWatch: (_threadId, _target, expectedStartedAt) =>
            Effect.sync(() => {
              clearAttempts += 1;
              expect(expectedStartedAt).toBe(oldStartedAt);
              shell = {
                ...shell,
                pullRequests: shell.pullRequests?.map((entry) =>
                  entry === link ? { ...entry, watch: nextWatch } : entry,
                ),
              };
            }),
          sql,
        });

        expect(yield* watches.reconcileEnded()).toBe(false);
        expect(clearAttempts).toBe(1);
        expect(watchStartedAt(shell)).toBe(newStartedAt);
        expect(
          yield* sql<{ readonly key: string }>`
            SELECT key FROM signalbox_automation_thread_pr_watches
            WHERE thread_id = 'thread-1'
          `,
        ).toEqual([]);

        yield* watches.reconcile("thread-1");
        expect(starts.map((request) => request.watching)).toEqual([true]);
        expect(watchStartedAt(shell)).toBe(newStartedAt);
        expect(
          yield* sql<{ readonly started_at: string | null }>`
            SELECT started_at FROM signalbox_automation_thread_pr_watches
            WHERE thread_id = 'thread-1'
          `,
        ).toEqual([{ started_at: newStartedAt }]);
      }),
    ),
  );
});
