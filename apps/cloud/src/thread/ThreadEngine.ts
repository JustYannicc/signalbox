import {
  type CommandId,
  EventId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2SubscribeThreadInput,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadLaunchResult,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId,
} from "@t3tools/contracts";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { contextAllows } from "../drive/driveAccess.ts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { hasPendingTurnWork, scriptedStep } from "./scriptedTurn.ts";
import { type Decision, decide, decideLaunch } from "./threadDecider.ts";
import type { DecisionContext } from "./threadEvents.ts";
import { applyEvents, threadShellFromProjection } from "./threadProjection.ts";
import * as ThreadStore from "./ThreadStore.ts";
import type { ThreadSnapshotWire, ThreadSummaryWire } from "./threadWire.ts";

/**
 * One thread's orchestration, inside its Durable Object. Commands and provider
 * steps run one at a time: decide against the projection, commit the events
 * with the command's receipt, then publish them to subscribers. A command id
 * that already has a receipt returns its original result without deciding
 * again, so a client retrying a send never starts a second turn.
 *
 * Events are only published after they commit, so a subscriber never sees an
 * event the log could lose.
 */

export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()(
  "ThreadNotFoundError",
  {},
) {
  override get message(): string {
    return "Thread not found.";
  }
}

export class ThreadCommandRejectedError extends Schema.TaggedError<ThreadCommandRejectedError>()(
  "ThreadCommandRejectedError",
  { commandId: Schema.String, commandType: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }

  static forCommand(
    command: { readonly id: string; readonly type: string },
    reason: string,
  ): ThreadCommandRejectedError {
    return new ThreadCommandRejectedError({
      commandId: command.id,
      commandType: command.type,
      reason,
    });
  }
}

/**
 * Who is acting. Only a thread's owner can read or change it until sharing
 * lands, and only while they're still in its context: `contextIds` are the
 * owner's contexts as their own object holds them at the time of the call.
 */
export interface Actor {
  readonly userId: string;
  readonly contextIds: ReadonlyArray<SignalboxContextId>;
}

/**
 * Fixed when a thread is created: the context it acts as and the drive it
 * works in, for its whole life. Null when the command names a project that is
 * none of the actor's, or a drive they can't change: a retry of a command that
 * already landed still replays, a new thread is rejected.
 */
export interface ThreadCreation {
  readonly place: { readonly contextId: SignalboxContextId; readonly driveId: string } | null;
}

const NO_CONTEXT =
  "That project does not exist in this environment, or you can't change its files.";

/**
 * A thread's sidebar row as its owner's index stores it. `revision` grows with
 * every change to the row, so delivering an old one again changes nothing.
 */
export type ThreadSummary = typeof ThreadSummaryWire.Type;

export type ThreadSnapshot = typeof ThreadSnapshotWire.Type;

/** What `apply` commits: events, the machine lease to store with them, and the caller's result. */
export interface EngineDecision<A> {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly machine?: ThreadStore.MachineLease;
  readonly result: A;
}

/** Replays longer than this send a snapshot instead, as the self-hosted server does. */
const MAX_REPLAY_EVENTS = 512;

type Batch = ReadonlyArray<ThreadStore.StoredEvent>;

export class ThreadEngine extends Context.Service<
  ThreadEngine,
  {
    readonly dispatch: (
      actor: Actor,
      command: OrchestrationV2Command,
      creation: ThreadCreation,
    ) => Effect.Effect<
      { readonly sequence: number },
      ThreadNotFoundError | ThreadCommandRejectedError
    >;
    /** Creates the thread and starts its first turn as one command. */
    readonly launch: (
      actor: Actor,
      input: OrchestrationV2ThreadLaunchInput & { readonly threadId: ThreadId },
      creation: ThreadCreation,
    ) => Effect.Effect<
      OrchestrationV2ThreadLaunchResult,
      ThreadNotFoundError | ThreadCommandRejectedError
    >;
    readonly snapshot: (actor: Actor) => Effect.Effect<ThreadSnapshot, ThreadNotFoundError>;
    /**
     * `subscribeThread`: a snapshot or the events after the client's cursor,
     * the completion marker when asked for, then live batches as they commit.
     */
    readonly subscribe: (
      actor: Actor,
      input: OrchestrationV2SubscribeThreadInput,
    ) => Effect.Effect<
      Stream.Stream<ReadonlyArray<OrchestrationV2ThreadStreamItem>>,
      ThreadNotFoundError
    >;
    /**
     * Decides and commits under the thread's lock, for work that is not a
     * client command (a Runner's report, the machine lease). `decideWith`
     * sees the projection, null before the thread exists.
     */
    readonly apply: <A>(
      decideWith: (
        projection: OrchestrationV2ThreadProjection | null,
        ctx: DecisionContext,
      ) => Effect.Effect<EngineDecision<A>>,
    ) => Effect.Effect<A>;
    /** The committed projection, read without the lock, for checks that decide nothing. */
    readonly projection: Effect.Effect<OrchestrationV2ThreadProjection | null>;
    /** Runs one scripted provider step. True while turn work remains. */
    readonly step: Effect.Effect<boolean>;
    readonly hasTurnWork: Effect.Effect<boolean>;
    /** The current summary, for an owner's index rebuild. Null for anyone else. */
    readonly summary: (actor: Actor) => Effect.Effect<ThreadSummary | null>;
    /** Whether the owner's index has not acknowledged the latest summary yet. */
    readonly hasPendingSummary: Effect.Effect<boolean>;
    /** The unacknowledged summary and whose index it goes to, if any. */
    readonly pendingSummary: Effect.Effect<{
      readonly ownerUserId: string;
      readonly summary: ThreadSummary;
    } | null>;
    readonly acknowledgeSummary: (revision: number) => Effect.Effect<void>;
  }
>()("@signalbox/cloud/thread/ThreadEngine") {}

/** A thread that exists: created, owned, with its read model. */
interface Thread {
  readonly owner: ThreadStore.ThreadOwner;
  readonly projection: OrchestrationV2ThreadProjection;
}

interface State {
  readonly head: number;
  readonly thread: Thread | null;
  /** `summaryKey` of the current projection, so a commit computes only the new one. */
  readonly summaryKey: string;
}

/** The sidebar row without its timestamp, which moves on every streamed chunk. */
const summaryKey = (projection: OrchestrationV2ThreadProjection | null) => {
  if (projection === null) return "";
  const { updatedAt: _updatedAt, ...rest } = threadShellFromProjection(projection);
  return JSON.stringify(rest);
};

const toStreamItem = (stored: ThreadStore.StoredEvent): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence: stored.sequence,
  event: stored.event,
});

const make = Effect.gen(function* () {
  const store = yield* ThreadStore.ThreadStore;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const published = yield* PubSub.unbounded<Batch>();

  // Storage failures inside an object are fatal for the request; the caller sees a defect.
  // An object whose thread was never created has no tables, and reads nothing.
  // A thread created by an older build gets the tables added since.
  const initial = (yield* Effect.orDie(store.initialized))
    ? yield* Effect.orDie(
        Effect.andThen(
          store.initialize,
          Effect.all({ events: store.events(0), owner: store.owner }),
        ),
      )
    : { events: [], owner: null };
  const initialProjection = applyEvents(
    null,
    initial.events.map((stored) => stored.event),
  );
  const state = yield* Ref.make<State>({
    head: initial.events.at(-1)?.sequence ?? 0,
    thread:
      initial.owner === null || initialProjection === null
        ? null
        : { owner: initial.owner, projection: initialProjection },
    summaryKey: summaryKey(initialProjection),
  });

  const serialized = lock.withPermits(1);

  const context = Effect.map(DateTime.now, (now): DecisionContext => ({ now }));

  const stamp = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
    Effect.forEach(events, (event) =>
      Effect.map(Effect.orDie(crypto.randomUUIDv4), (id) => ({ ...event, id: EventId.make(id) })),
    );

  /** Commits decided events and publishes them. Callers hold the lock. */
  const commit = Effect.fnUntraced(function* (input: {
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly command?: { readonly id: CommandId; readonly type: string };
    /** Set by the commit that creates the thread. */
    readonly owner?: ThreadStore.ThreadOwner;
    readonly machine?: ThreadStore.MachineLease;
  }) {
    const current = yield* Ref.get(state);
    const owner = current.thread?.owner ?? input.owner;
    const events = yield* stamp(input.events);
    const projection = applyEvents(current.thread?.projection ?? null, events);
    if (owner === undefined || projection === null) {
      return yield* Effect.die("A thread's first commit must create it.");
    }
    // The thread's first commit creates its storage.
    if (current.thread === null) yield* Effect.orDie(store.initialize);
    const nextKey = summaryKey(projection);
    const head = yield* Effect.orDie(
      store.commit({
        head: current.head,
        events,
        ...(input.command ? { command: input.command } : {}),
        ...(current.thread === null ? { owner } : {}),
        ...(input.machine ? { machine: input.machine } : {}),
        summaryChanged: nextKey !== current.summaryKey,
      }),
    );
    yield* Ref.set(state, { head, thread: { owner, projection }, summaryKey: nextKey });
    if (events.length > 0) {
      yield* PubSub.publish(
        published,
        events.map((event, index) => ({ sequence: current.head + index + 1, event })),
      );
    }
    return head;
  });

  /**
   * The thread as `actor` may see it: only its owner, while they're in its
   * context. Anyone else sees what an unknown id shows.
   */
  const visibleTo = (current: State, actor: Actor) =>
    current.thread !== null &&
    current.thread.owner.userId === actor.userId &&
    contextAllows(actor.contextIds, current.thread.owner.contextId)
      ? current.thread
      : null;

  /** The thread when `actor` owns it, whichever contexts they're in: for their index. */
  const ownedBy = (current: State, actor: Actor) =>
    current.thread !== null && current.thread.owner.userId === actor.userId ? current.thread : null;

  const readable = (actor: Actor) =>
    Effect.flatMap(Ref.get(state), (current) => {
      const thread = visibleTo(current, actor);
      return thread === null
        ? Effect.fail(new ThreadNotFoundError())
        : Effect.succeed({ head: current.head, projection: thread.projection });
    });

  /**
   * Replays a receipt, or decides and commits. `decideWith` sees the
   * projection under the lock; only a command that `createsThread` may run
   * before the thread exists.
   */
  const runCommand = (
    actor: Actor,
    creation: ThreadCreation,
    command: { readonly id: CommandId; readonly type: string; readonly createsThread: boolean },
    decideWith: (
      projection: OrchestrationV2ThreadProjection | null,
      ctx: DecisionContext,
    ) => Decision,
  ) =>
    serialized(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.thread === null ? !command.createsThread : !visibleTo(current, actor)) {
          return yield* new ThreadNotFoundError();
        }
        // Only a thread that exists has receipts: its creation writes the owner.
        const receipt =
          current.thread === null ? null : yield* Effect.orDie(store.receipt(command.id));
        if (receipt?._tag === "accepted") return { sequence: receipt.sequence, replayed: true };
        if (receipt?._tag === "rejected") {
          return yield* ThreadCommandRejectedError.forCommand(command, receipt.message);
        }
        const { place } = creation;
        if (current.thread === null && place === null) {
          return yield* ThreadCommandRejectedError.forCommand(command, NO_CONTEXT);
        }
        const decision = decideWith(current.thread?.projection ?? null, yield* context);
        if (decision._tag === "rejected") {
          // Only a thread that exists keeps receipts; an unknown id leaves no trace.
          if (current.thread !== null) {
            yield* Effect.orDie(store.recordRejection({ command, message: decision.message }));
          }
          return yield* ThreadCommandRejectedError.forCommand(command, decision.message);
        }
        const sequence = yield* commit({
          events: decision.events,
          command,
          ...(place === null ? {} : { owner: { userId: actor.userId, ...place } }),
        });
        return { sequence, replayed: false };
      }),
    );

  const dispatch: ThreadEngine["Service"]["dispatch"] = (actor, command, creation) =>
    runCommand(
      actor,
      creation,
      {
        id: command.commandId,
        type: command.type,
        createsThread: command.type === "thread.create",
      },
      (projection, ctx) => decide(projection, command, ctx),
    ).pipe(Effect.map(({ sequence }) => ({ sequence })));

  const launch: ThreadEngine["Service"]["launch"] = (actor, input, creation) =>
    Effect.gen(function* () {
      const result = yield* runCommand(
        actor,
        creation,
        { id: input.commandId, type: "thread.launch", createsThread: true },
        (projection, ctx) => decideLaunch(projection, input, ctx),
      );
      const { projection } = yield* readable(actor);
      return { threadId: input.threadId, projection, resumed: result.replayed };
    });

  const snapshot: ThreadEngine["Service"]["snapshot"] = (actor) =>
    Effect.map(readable(actor), ({ head, projection }) => ({ snapshotSequence: head, projection }));

  const subscribe: ThreadEngine["Service"]["subscribe"] = (actor, input) =>
    serialized(
      Effect.gen(function* () {
        const { head, projection } = yield* readable(actor);
        const after = input.afterSequence;
        // Decide before reading: a client with no cursor, one before the
        // thread's creation (sequence 1), or one too far behind gets a snapshot.
        const replayable =
          after !== undefined && after >= 1 && after <= head && head - after <= MAX_REPLAY_EVENTS;
        const caughtUp: Array<OrchestrationV2ThreadStreamItem> = replayable
          ? (yield* Effect.orDie(store.events(after))).map(toStreamItem)
          : [{ kind: "snapshot", snapshotSequence: head, projection }];
        if (input.requestCompletionMarker === true) caughtUp.push({ kind: "synchronized" });
        // Subscribed under the lock, so no commit lands between the catch-up
        // and the live tail. The stream owns the subscription's scope.
        const scope = yield* Scope.make();
        const subscription = yield* PubSub.subscribe(published).pipe(Scope.provide(scope));
        return Stream.concat(
          Stream.make(caughtUp),
          Stream.fromSubscription(subscription).pipe(
            Stream.map((batch) => batch.map(toStreamItem)),
          ),
        ).pipe(Stream.ensuring(Scope.close(scope, Exit.void)));
      }),
    );

  const apply: ThreadEngine["Service"]["apply"] = (decideWith) =>
    serialized(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const decision = yield* decideWith(current.thread?.projection ?? null, yield* context);
        if (decision.events.length > 0) {
          yield* commit({
            events: decision.events,
            ...(decision.machine ? { machine: decision.machine } : {}),
          });
        } else if (decision.machine) {
          yield* Effect.orDie(store.saveMachine(decision.machine));
        }
        return decision.result;
      }),
    );

  const step: ThreadEngine["Service"]["step"] = serialized(
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      if (current.thread === null) return false;
      const events = scriptedStep(current.thread.projection, yield* context);
      if (events.length > 0) yield* commit({ events });
      const after = yield* Ref.get(state);
      return after.thread !== null && hasPendingTurnWork(after.thread.projection);
    }),
  );

  const projection: ThreadEngine["Service"]["projection"] = Effect.map(
    Ref.get(state),
    (current) => current.thread?.projection ?? null,
  );

  const hasTurnWork: ThreadEngine["Service"]["hasTurnWork"] = Effect.map(
    Ref.get(state),
    (current) => current.thread !== null && hasPendingTurnWork(current.thread.projection),
  );

  const summaryOf = (thread: Thread, revision: number): ThreadSummary => ({
    threadId: thread.projection.thread.id,
    contextId: thread.owner.contextId,
    revision,
    shell: threadShellFromProjection(thread.projection),
  });

  const summary: ThreadEngine["Service"]["summary"] = (actor) =>
    Effect.gen(function* () {
      const thread = ownedBy(yield* Ref.get(state), actor);
      if (thread === null) return null;
      const outbox = yield* Effect.orDie(store.outbox);
      return summaryOf(thread, outbox.revision);
    });

  const undelivered = Effect.gen(function* () {
    const { thread } = yield* Ref.get(state);
    if (thread === null) return null;
    const outbox = yield* Effect.orDie(store.outbox);
    return outbox.revision > outbox.delivered ? { thread, revision: outbox.revision } : null;
  });

  const hasPendingSummary: ThreadEngine["Service"]["hasPendingSummary"] = Effect.map(
    undelivered,
    (pending) => pending !== null,
  );

  const pendingSummary: ThreadEngine["Service"]["pendingSummary"] = Effect.map(
    undelivered,
    (pending) =>
      pending === null
        ? null
        : {
            ownerUserId: pending.thread.owner.userId,
            summary: summaryOf(pending.thread, pending.revision),
          },
  );

  const acknowledgeSummary: ThreadEngine["Service"]["acknowledgeSummary"] = (revision) =>
    Effect.orDie(store.acknowledgeSummary(revision));

  return ThreadEngine.of({
    dispatch,
    launch,
    snapshot,
    subscribe,
    apply,
    projection,
    step,
    hasTurnWork,
    summary,
    hasPendingSummary,
    pendingSummary,
    acknowledgeSummary,
  });
});

export const layer = Layer.effect(ThreadEngine, make);
