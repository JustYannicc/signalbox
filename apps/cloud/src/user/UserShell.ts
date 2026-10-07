import type {
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2SubscribeShellInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/sql/SqlError";

import * as Environment from "../environment.ts";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import type { ThreadSummary } from "../thread/ThreadEngine.ts";
import { contextProjects } from "./contextProjects.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserStore from "./UserStore.ts";

/**
 * A user's sidebar, served from their object's thread index: the snapshot
 * `GET /api/orchestration/shell` and `subscribeShell` start from, and the
 * `thread.updated` items that follow as thread objects deliver summaries.
 * Its projects are the user's contexts' (see `contextProjects`); when those
 * change, open subscriptions get a fresh snapshot.
 */

type ShellItem = Extract<OrchestrationV2ShellStreamItem, { readonly kind: "thread.updated" }>;
type ShellUpdate = ShellItem | { readonly kind: "projects.changed" };
const PROJECTS_CHANGED: ShellUpdate = { kind: "projects.changed" };

export class UserShell extends Context.Service<
  UserShell,
  {
    readonly snapshot: Effect.Effect<OrchestrationV2ShellSnapshot, SqlError>;
    readonly subscribe: (
      input: OrchestrationV2SubscribeShellInput,
    ) => Effect.Effect<Stream.Stream<OrchestrationV2ShellStreamItem>, SqlError>;
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
  const directory = yield* ThreadDirectory.ThreadDirectory;
  // Thread updates and project changes share one queue, so a subscriber sees
  // them in the order they happened.
  const updates = yield* PubSub.unbounded<ShellUpdate>();

  const snapshot: UserShell["Service"]["snapshot"] = Effect.gen(function* () {
    const projects = contextProjects(yield* contexts.contexts);
    // The index last, so the snapshot is as recent as the thread updates around it.
    return Environment.shellSnapshot({ ...(yield* store.threadIndex), projects });
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
      : Effect.succeed(update);

  const publish = (summary: ThreadSummary, sequence: number) => {
    const item: ShellItem = {
      kind: "thread.updated",
      sequence,
      location: summary.shell.archivedAt === null ? "active" : "archive",
      thread: summary.shell,
    };
    return Effect.asVoid(PubSub.publish(updates, item));
  };

  const record = (summary: ThreadSummary) =>
    Effect.flatMap(store.recordThreadSummary(summary), (sequence) =>
      sequence === null ? Effect.void : publish(summary, sequence),
    );

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
              update.kind === "projects.changed" || update.sequence > current.snapshotSequence,
          ),
          Stream.mapEffect(toItem),
          Stream.filter((item) => item !== null),
        ),
      ).pipe(Stream.ensuring(Scope.close(scope, Exit.void)));
    });

  const rebuildThreadIndex: UserShell["Service"]["rebuildThreadIndex"] = Effect.gen(function* () {
    const profile = yield* store.profile;
    if (profile === null) return 0;
    // Pull every summary before touching the index: one unreachable thread
    // fails the rebuild and leaves the current index as it was.
    const summaries = yield* Effect.forEach(
      yield* store.threadMembers,
      (threadId) => directory.forThread(threadId).summary({ userId: profile.id }),
      { concurrency: 8 },
    );
    const present = summaries.filter((summary) => summary !== null);
    const recorded = yield* store.replaceThreadIndex(present);
    yield* Effect.forEach(recorded, ({ summary, sequence }) => publish(summary, sequence));
    return present.length;
  });

  return UserShell.of({
    snapshot,
    subscribe,
    recordThreadSummary: record,
    rebuildThreadIndex,
  });
});

export const layer = Layer.effect(UserShell, make);
