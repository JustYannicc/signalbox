import type {
  OrchestrationV2ArchivedShellStreamItem,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2SubscribeShellInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/sql/SqlError";

import { contextAllows } from "../drive/driveAccess.ts";
import * as Environment from "../environment.ts";
import * as PushNotifier from "../push/PushNotifier.ts";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import * as SearchBackfill from "../search/SearchBackfill.ts";
import type { ThreadSummary } from "../thread/ThreadEngine.ts";
import { contextProjects } from "./contextProjects.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserDriveIndex from "./UserDriveIndex.ts";
import * as UserStore from "./UserStore.ts";

/**
 * A user's sidebar, served from their object's thread index: the snapshot
 * `GET /api/orchestration/shell` and `subscribeShell` start from, and the
 * `thread.updated` items that follow as thread objects deliver summaries,
 * each of which may also push to the user's phones (`PushNotifier`).
 * Its projects are the drives of the user's contexts (see `contextProjects`);
 * when those change, open subscriptions get a fresh snapshot. Threads of a
 * context the user has left stay indexed but out of sight.
 */

type ShellItem = Extract<OrchestrationV2ShellStreamItem, { readonly kind: "thread.updated" }>;
type ShellUpdate =
  | {
      readonly kind: "thread.changed";
      readonly item: ShellItem;
      readonly contextId: ThreadSummary["contextId"];
    }
  | { readonly kind: "projects.changed" };
const PROJECTS_CHANGED: ShellUpdate = { kind: "projects.changed" };

export class UserShell extends Context.Service<
  UserShell,
  {
    readonly snapshot: Effect.Effect<OrchestrationV2ShellSnapshot, SqlError>;
    readonly subscribe: (
      input: OrchestrationV2SubscribeShellInput,
    ) => Effect.Effect<Stream.Stream<OrchestrationV2ShellStreamItem>, SqlError>;
    readonly subscribeArchived: Effect.Effect<
      Stream.Stream<OrchestrationV2ArchivedShellStreamItem>,
      SqlError
    >;
    /** A thread object's outbox delivery. Idempotent: an old revision changes nothing. */
    readonly recordThreadSummary: (summary: ThreadSummary) => Effect.Effect<void, SqlError>;
    /**
     * Drops the index and pulls every member thread's summary again. The
     * result matches the index the outbox built. Returns how many threads it
     * indexed.
     */
    readonly rebuildThreadIndex: Effect.Effect<
      number,
      SqlError | ThreadDirectory.ThreadObjectError
    >;
  }
>()("@signalbox/cloud/user/UserShell") {}

const make = Effect.gen(function* () {
  const store = yield* UserStore.UserStore;
  const contexts = yield* UserContexts.UserContexts;
  const driveIndex = yield* UserDriveIndex.UserDriveIndex;
  const { contextIds } = contexts;
  const directory = yield* ThreadDirectory.ThreadDirectory;
  const pushes = yield* PushNotifier.PushNotifier;
  const searchBackfill = yield* Effect.serviceOption(SearchBackfill.SearchBackfill);
  // Pushes outlive the delivery that caused them, so a slow APNs never holds up the thread.
  const scope = yield* Effect.scope;
  // Thread updates and project changes share one queue, so a subscriber sees
  // them in the order they happened.
  const updates = yield* PubSub.unbounded<ShellUpdate>();

  const snapshot: UserShell["Service"]["snapshot"] = Effect.gen(function* () {
    const current = yield* contexts.contexts;
    const ids = current.map((context) => context.id);
    const projects = contextProjects(current, yield* driveIndex.drives);
    // The index last, so the snapshot is as recent as the thread updates around it.
    const index = yield* store.threadIndex;
    return Environment.shellSnapshot({
      sequence: index.sequence,
      threads: index.threads
        .filter((thread) => contextAllows(ids, thread.contextId))
        .map((thread) => thread.shell),
      projects,
    });
  });

  yield* contexts.contextsChanged.pipe(
    Stream.runForEach(() => PubSub.publish(updates, PROJECTS_CHANGED)),
    Effect.forkScoped,
  );

  /** A subscriber's next item for `update`; a project change becomes a fresh snapshot. */
  const toItem = (update: ShellUpdate) =>
    update.kind === "projects.changed"
      ? snapshot.pipe(
          Effect.map((next): OrchestrationV2ShellStreamItem | null => ({
            kind: "snapshot",
            snapshot: next,
          })),
          // The next change or reconnect brings the projects; the thread updates keep flowing.
          Effect.catch((cause) =>
            Effect.as(Effect.logWarning("cloud shell project update failed", { cause }), null),
          ),
        )
      : Effect.map(contextIds, (ids) =>
          contextAllows(ids, update.contextId) ? update.item : null,
        ).pipe(
          Effect.catch(() => Effect.as(Effect.logWarning("cloud shell access check failed"), null)),
        );

  const publish = (summary: ThreadSummary, sequence: number) => {
    const item: ShellItem = {
      kind: "thread.updated",
      sequence,
      location: summary.shell.archivedAt === null ? "active" : "archive",
      thread: summary.shell,
    };
    return Effect.asVoid(
      PubSub.publish(updates, { kind: "thread.changed", item, contextId: summary.contextId }),
    );
  };

  /** Indexes the summary; open sidebars hear of it only while its context is the user's. */
  const record = (summary: ThreadSummary) =>
    Effect.gen(function* () {
      const written = yield* store.recordThreadSummary(summary);
      if (Option.isSome(searchBackfill)) {
        yield* searchBackfill.value
          .observeThread(summary.threadId)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("search snapshot queue failed", { cause }),
            ),
          );
      }
      if (written === null || !contextAllows(yield* contextIds, summary.contextId)) return;
      yield* publish(summary, written.sequence);
      yield* Effect.forkIn(
        pushes.threadChanged({ previous: written.previous, next: summary.shell }),
        scope,
      );
    });

  const subscribe: UserShell["Service"]["subscribe"] = (input) =>
    Effect.gen(function* () {
      // Subscribe before reading, so an update between the two is not lost.
      const scope = yield* Scope.make();
      const subscription = yield* PubSub.subscribe(updates).pipe(Scope.provide(scope));
      const current = yield* snapshot.pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      // The index keeps no update log, so only a client already current skips the snapshot.
      const resumed = input.afterSequence === current.snapshotSequence;
      const head: Array<OrchestrationV2ShellStreamItem> = [
        ...(resumed ? [] : [{ kind: "snapshot", snapshot: current } as const]),
        ...(input.requestCompletionMarker ? [{ kind: "synchronized" } as const] : []),
      ];
      return Stream.concat(
        Stream.fromIterable(head),
        Stream.fromSubscription(subscription).pipe(
          Stream.filter(
            (update) =>
              update.kind === "projects.changed" || update.item.sequence > current.snapshotSequence,
          ),
          Stream.mapEffect(toItem),
          Stream.filter((item) => item !== null),
        ),
      ).pipe(Stream.ensuring(Scope.close(scope, Exit.void)));
    });

  const subscribeArchived: UserShell["Service"]["subscribeArchived"] = Effect.map(
    subscribe({}),
    (stream) =>
      stream.pipe(
        Stream.mapAccum(
          () => new Set<ThreadId>(),
          (archivedIds, item): [Set<ThreadId>, Array<OrchestrationV2ArchivedShellStreamItem>] => {
            if (item.kind === "snapshot") {
              return [
                new Set(item.snapshot.archivedThreads.map((thread) => thread.id)),
                [
                  {
                    kind: "snapshot",
                    snapshot: {
                      schemaVersion: item.snapshot.schemaVersion,
                      snapshotSequence: item.snapshot.snapshotSequence,
                      projects: item.snapshot.projects,
                      threads: item.snapshot.archivedThreads,
                    },
                  },
                ],
              ];
            }
            if (item.kind !== "thread.updated") return [archivedIds, []];
            if (item.location === "archive" && item.thread.deletedAt === null) {
              archivedIds.add(item.thread.id);
              return [
                archivedIds,
                [{ kind: "thread.updated", sequence: item.sequence, thread: item.thread }],
              ];
            }
            return [
              archivedIds,
              archivedIds.delete(item.thread.id)
                ? [{ kind: "thread.removed", sequence: item.sequence, threadId: item.thread.id }]
                : [],
            ];
          },
        ),
      ),
  );

  const rebuildThreadIndex: UserShell["Service"]["rebuildThreadIndex"] = Effect.gen(function* () {
    const profile = yield* store.profile;
    if (profile === null) return 0;
    // Pull every summary before touching the index: one unreachable thread
    // fails the rebuild and leaves the current index as it was.
    const summaries = yield* Effect.forEach(
      yield* store.threadMembers,
      // Summaries of every context: the index keeps threads of contexts the user left.
      (threadId) => directory.forThread(threadId).summary({ userId: profile.id, contextIds: [] }),
      { concurrency: 8 },
    );
    const present = summaries.filter((summary) => summary !== null);
    const recorded = yield* store.replaceThreadIndex(present);
    const ids = yield* contextIds;
    yield* Effect.forEach(
      recorded.filter(({ summary }) => contextAllows(ids, summary.contextId)),
      ({ summary, sequence }) => publish(summary, sequence),
    );
    return present.length;
  });

  return UserShell.of({
    snapshot,
    subscribe,
    subscribeArchived,
    recordThreadSummary: record,
    rebuildThreadIndex,
  });
});

export const layer = Layer.effect(UserShell, make);
