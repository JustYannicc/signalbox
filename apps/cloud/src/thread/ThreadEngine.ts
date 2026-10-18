import {
  type CommandId,
  EventId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2SubscribeThreadInput,
  type OrchestrationV2ThreadLaunchInput,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchResult,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId,
} from "@t3tools/contracts";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type {
  ThreadStatusNote,
  ThreadStatusNoteInput,
} from "@t3tools/contracts/signalboxStatusLine";
import type { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import type { FolderInstructions } from "@signalbox/runner-protocol/DriveProtocol";
import { contextAllows } from "../drive/driveAccess.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { traceIdOf } from "./diagnostics/traceId.ts";
import { hasPendingTurnWork, scriptedStep } from "./scriptedTurn.ts";
import { type Decision, decide, decideLaunch, type ThreadWorktree } from "./threadDecider.ts";
import { threadEvent, type DecisionContext } from "./threadEvents.ts";
import { applyEvents, threadShellFromProjection, workStartedAt } from "./threadProjection.ts";
import { noteKey, noteRunId, supersedes } from "./statusLine/statusNotePolicy.ts";
import { type Actor, ThreadNotFoundError, ThreadCommandRejectedError } from "./ThreadAccess.ts";
import * as CheckpointRollback from "./CheckpointRollback.ts";
import { baselineEvents, rollbackEvents } from "./rollbackEvents.ts";
import type { RollbackOperation } from "./rollbackState.ts";
import * as ThreadStore from "./ThreadStore.ts";
import * as PullState from "./PullState.ts";
import * as TurnModels from "./TurnModels.ts";
import {
  commandOnPool,
  forThread,
  onPool,
  type TurnInstructions,
  type TurnPools,
  type TurnSecrets,
} from "./turnPool.ts";
import { poolErrorMessage } from "../pool/PoolDirectory.ts";
import type { ThreadMonitor, ThreadSnapshotWire, ThreadSummaryWire } from "./threadWire.ts";

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

export { type Actor, ThreadNotFoundError, ThreadCommandRejectedError } from "./ThreadAccess.ts";

/**
 * Fixed when a thread is created: the context it acts as and the drive it
 * works in, for its whole life. Null when the command names a project that is
 * none of the actor's, or a drive they can't change: a retry of a command that
 * already landed still replays, a new thread is rejected.
 */
export interface ThreadCreation {
  readonly place: { readonly contextId: SignalboxContextId; readonly driveId: string } | null;
  /** The branch and worktree a new thread gets, when its drive has threads work on their own branch. */
  readonly worktree?: ThreadWorktree | null;
  /**
   * What the owner's tree resolves each project to (`turnPool.ts`), for a
   * command that can start a turn or pick a model. Null for any other: a turn
   * never starts without its pool resolved.
   */
  readonly pools: TurnPools | null;
  /**
   * The `AGENTS.md` of every level on the thread's chain, resolved with
   * `pools`; a turn it starts keeps them for the Runner. Absent: unresolved.
   */
  readonly instructions?: TurnInstructions;
  /**
   * Set by the idle-chat sweep on its `thread.archive`: the thread's
   * `updatedAt` it judged idle at. A thread that changed since stays.
   */
  readonly idleSinceMs?: number;
  /**
   * The 1Password Environments on the thread's chain (#395), resolved with
   * `pools`; a turn it starts keeps them for the thread. Absent: unresolved.
   */
  readonly secrets?: TurnSecrets;
}

const NO_CONTEXT =
  "That project does not exist in this environment, or you can't change its files.";
const POOLS_UNRESOLVED = "Couldn't tell which pool this thread runs on. Try again.";

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
  readonly command?: { readonly id: CommandId; readonly type: string };
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
    readonly rollback: (
      actor: Actor,
      command: Extract<OrchestrationV2Command, { readonly type: "checkpoint.rollback" }>,
    ) => Effect.Effect<
      { readonly sequence: number },
      ThreadNotFoundError | ThreadCommandRejectedError
    >;
    /** Creates the thread and starts its first turn as one command. */
    readonly launch: (
      actor: Actor,
      input: OrchestrationV2ThreadLaunchInput & {
        readonly threadId: ThreadId;
        readonly modelSelection: ModelSelection;
      },
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
    /** Whether `actor` may see the thread, read without the lock. */
    readonly canSee: (actor: Actor) => Effect.Effect<boolean>;
    /** Whether the owner's index has not acknowledged the latest summary yet. */
    readonly hasPendingSummary: Effect.Effect<boolean>;
    /** The unacknowledged summary and whose index it goes to, if any. */
    readonly pendingSummary: Effect.Effect<{
      readonly ownerUserId: string;
      readonly summary: ThreadSummary;
    } | null>;
    readonly acknowledgeSummary: (revision: number) => Effect.Effect<void>;
    /**
     * Replaces the automation runs attached to the thread, which its shell
     * lists as monitors (`threadProjection.ts`). A change to the sidebar row
     * gets a new summary revision. An empty list clears them. Only for the
     * thread's owner, whichever contexts they're in, as their index is.
     */
    readonly setMonitors: (
      actor: Actor,
      monitors: ReadonlyArray<ThreadMonitor>,
    ) => Effect.Effect<void, ThreadNotFoundError>;
    /** The thread's status note (#670); null until one was written or before the thread exists. */
    readonly statusNote: Effect.Effect<ThreadStatusNote | null>;
    /**
     * Replaces the status note, giving the sidebar row a new revision. The
     * agent's note belongs to the live run, else the latest; the runtime's to
     * the run it was written for, and is dropped (null) once a newer run is live.
     */
    readonly writeStatusNote: (
      input: ThreadStatusNoteInput,
      by:
        | { readonly author: "agent" }
        | { readonly author: "runtime"; readonly runId: ThreadStatusNote["runId"] },
    ) => Effect.Effect<ThreadStatusNote | null, ThreadNotFoundError>;
    /** Whether committed events wait for the owner's automations (`eventOutbox.ts`). */
    readonly hasPendingEvents: Effect.Effect<boolean>;
    /** Up to `limit` committed events the owner's automations have not acknowledged, oldest first. */
    readonly pendingEvents: (limit: number) => Effect.Effect<{
      readonly ownerUserId: string;
      readonly threadId: ThreadId;
      readonly events: ReadonlyArray<ThreadStore.StoredEvent>;
    } | null>;
    readonly acknowledgeEvents: (through: number) => Effect.Effect<void>;
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
  /** The automation runs attached to the thread, kept outside its log. */
  readonly monitors: ReadonlyArray<ThreadMonitor>;
  /** The status note, kept outside its log like the monitors. */
  readonly statusNote: ThreadStatusNote | null;
  /** `summaryKey` of the current projection, so a commit computes only the new one. */
  readonly summaryKey: string;
}

/**
 * The summary without its timestamp, which moves on every streamed chunk:
 * the sidebar row, and when the thread's work started.
 */
const summaryKey = (
  projection: OrchestrationV2ThreadProjection | null,
  monitors: ReadonlyArray<ThreadMonitor>,
  note: ThreadStatusNote | null,
) => {
  if (projection === null) return "";
  const { updatedAt: _updatedAt, ...rest } = threadShellFromProjection(projection, monitors);
  const started = workStartedAt(projection);
  return JSON.stringify({
    ...rest,
    ...(started === null ? {} : { workStartedAt: DateTime.toEpochMillis(started) }),
    statusNote: noteKey(note),
  });
};

const toStreamItem = (stored: ThreadStore.StoredEvent): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence: stored.sequence,
  event: stored.event,
});

const make = Effect.gen(function* () {
  const store = yield* ThreadStore.ThreadStore;
  const pullState = yield* PullState.PullState;
  const crypto = yield* Crypto.Crypto;
  const turnModels = yield* TurnModels.TurnModels;
  const rollbackService = yield* CheckpointRollback.CheckpointRollback;
  const lock = yield* Semaphore.make(1);
  const published = yield* PubSub.unbounded<Batch>();

  // Storage failures inside an object are fatal for the request; the caller sees a defect.
  // An object whose thread was never created has no tables, and reads nothing.
  // A thread created by an older build gets the tables added since.
  const initial = (yield* Effect.orDie(store.initialized))
    ? yield* Effect.orDie(
        Effect.andThen(
          store.initialize,
          Effect.all({
            events: store.events(0),
            owner: store.owner,
            monitors: store.monitors,
            statusNote: store.statusNote,
          }),
        ),
      )
    : { events: [], owner: null, monitors: [], statusNote: null };
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
    monitors: initial.monitors,
    statusNote: initial.statusNote,
    summaryKey: summaryKey(initialProjection, initial.monitors, initial.statusNote),
  });

  const serialized = lock.withPermits(1);

  const context = Effect.map(DateTime.now, (now): DecisionContext => ({ now }));

  const stamp = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
    Effect.forEach(events, (event) =>
      Effect.map(Effect.orDie(crypto.randomUUIDv4()), (id) => ({ ...event, id: EventId.make(id) })),
    );

  /** Commits decided events and publishes them. Callers hold the lock. */
  const commit = Effect.fnUntraced(function* (input: {
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly rollback?: RollbackOperation;
    readonly command?: {
      readonly id: CommandId;
      readonly type: string;
      readonly traceId?: string | undefined;
      readonly rejection?: string;
    };
    /** Set by the commit that creates the thread. */
    readonly owner?: ThreadStore.ThreadOwner;
    readonly machine?: ThreadStore.MachineLease;
    /** The chain's instructions for the run this commit starts. */
    readonly instructions?: {
      readonly runId: string;
      readonly levels: ReadonlyArray<FolderInstructions>;
    };
    /** The chain's secrets, as of the run this commit starts. */
    readonly secrets?: ReadonlyArray<OnePasswordEnvironmentId>;
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
    const nextKey = summaryKey(projection, current.monitors, current.statusNote);
    const head = yield* Effect.orDie(
      store.commit({
        head: current.head,
        events,
        ...(input.rollback ? { rollback: input.rollback } : {}),
        ...(input.command ? { command: input.command } : {}),
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
        ...(current.thread === null ? { owner } : {}),
        ...(input.machine ? { machine: input.machine } : {}),
        summaryChanged: nextKey !== current.summaryKey,
      }),
    );
    yield* Ref.set(state, { ...current, head, thread: { owner, projection }, summaryKey: nextKey });
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
    command: {
      readonly id: CommandId;
      readonly type: string;
      readonly createsThread: boolean;
      /** The project a command that creates the thread names. */
      readonly projectId?: string;
    },
    decideWith: (
      projection: OrchestrationV2ThreadProjection | null,
      ctx: DecisionContext,
      /** The pool the thread's turns run on; null when its chain has none. Undefined: unresolved. */
      pool: string | null | undefined,
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
        if (current.thread !== null && (yield* Effect.orDie(store.pendingRollback)) !== null) {
          return yield* ThreadCommandRejectedError.forCommand(
            command,
            "Undo recovery is still pending. Try again shortly.",
          );
        }
        const { place } = creation;
        if (current.thread === null && place === null) {
          return yield* ThreadCommandRejectedError.forCommand(command, NO_CONTEXT);
        }
        const projectId = current.thread?.projection.thread.projectId ?? command.projectId;
        const pool =
          creation.pools === null || projectId === undefined
            ? undefined
            : forThread(creation.pools, projectId);
        const decision = decideWith(current.thread?.projection ?? null, yield* context, pool);
        const refuse = (message: string, options: { readonly record: boolean }) =>
          Effect.gen(function* () {
            // Only a thread that exists keeps receipts; an unknown id leaves no trace.
            if (options.record && current.thread !== null) {
              yield* Effect.orDie(store.recordRejection({ command, message }));
            }
            return yield* ThreadCommandRejectedError.forCommand(command, message);
          });
        const refusePool = (error: Parameters<typeof poolErrorMessage>[0]) =>
          Effect.flatMap(poolErrorMessage(error), (message) => refuse(message, { record: false }));
        if (decision._tag === "rejected") {
          return yield* refuse(decision.message, { record: true });
        }
        // The receipt names the turn this command started, so a client's retry finds its trace.
        const started = decision.events.find((event) => event.type === "run.created");
        if (
          started !== undefined &&
          current.thread !== null &&
          (yield* Effect.orDie(pullState.pending)) !== null
        ) {
          return yield* refuse("Wait for this thread's pull to finish before starting a turn.", {
            record: false,
          });
        }
        // A turn starts only on its thread's pool, on a model it serves. A pool
        // that can't be asked right now leaves no receipt, so a retry asks
        // again. Asked under the lock, from the pool's cache: only a pool whose
        // models were never read wakes its container here, once.
        if (started !== undefined) {
          if (pool === undefined) return yield* refuse(POOLS_UNRESOLVED, { record: false });
          yield* turnModels
            .check({
              ownerId: current.thread?.owner.userId ?? actor.userId,
              pool,
              selection: started.payload.modelSelection,
            })
            .pipe(
              Effect.catchTags({
                ModelNotServedError: (error) => refuse(error.message, { record: true }),
                PoolNeededError: (error) => refuse(error.message, { record: true }),
                ProviderUnavailableError: (error) => refuse(error.message, { record: true }),
                PoolRejectedError: (error) => refusePool(error),
                PoolObjectError: (error) => refusePool(error),
              }),
            );
        }
        const sequence = yield* commit({
          events: decision.events,
          command: {
            ...command,
            ...(started === undefined
              ? {}
              : {
                  traceId: yield* traceIdOf(started.payload.id).pipe(
                    Effect.provideService(Crypto.Crypto, crypto),
                  ),
                }),
          },
          ...(place === null ? {} : { owner: { userId: actor.userId, ...place } }),
          ...(started === undefined ||
          creation.instructions === undefined ||
          projectId === undefined
            ? {}
            : {
                instructions: {
                  runId: started.payload.id,
                  levels: forThread(creation.instructions, projectId),
                },
              }),
          ...(started === undefined || creation.secrets === undefined || projectId === undefined
            ? {}
            : { secrets: forThread(creation.secrets, projectId) }),
        });
        return { sequence, replayed: false };
      }),
    );

  // Callers hold the engine lock. Each stage commits before the next external effect.
  const recoverRollback = Effect.fnUntraced(function* () {
    let operation = yield* Effect.orDie(store.pendingRollback);
    if (operation === null) return null;
    if (operation.stage === "prepared") {
      const restoring = operation;
      const failure = yield* rollbackService
        .restore(restoring)
        .pipe(
          Effect.as(null),
          Effect.catchTags({ RollbackRestoreRejectedError: (error) => Effect.succeed(error) }),
        );
      if (failure !== null) {
        const current = yield* Ref.get(state);
        if (current.thread === null) return yield* Effect.die("Undo recovery lost its thread.");
        yield* rollbackService.arm;
        yield* commit({
          events: [
            threadEvent(yield* context, "thread.metadata-updated", {
              ...current.thread.projection.thread,
              rollbackRequestId: operation.commandId,
              rollbackFailure: { requestId: operation.commandId, message: failure.message },
            }),
          ],
          rollback: {
            ...operation,
            stage: "failed",
            failure: { category: failure.category, message: failure.message },
          },
          command: {
            id: operation.commandId,
            type: "checkpoint.rollback",
            rejection: failure.message,
          },
        });
        return yield* ThreadCommandRejectedError.forCommand(
          { id: operation.commandId, type: "checkpoint.rollback" },
          failure.message,
        );
      }
      operation = { ...operation, stage: "files-restored" };
      yield* commit({ events: [], rollback: operation });
    }
    if (operation.stage === "files-restored") {
      const current = yield* Ref.get(state);
      if (current.thread === null) return yield* Effect.die("Undo recovery lost its thread.");
      yield* commit({
        events: rollbackEvents(current.thread.projection, operation, yield* context),
        rollback: { ...operation, stage: "conversation-updated" },
      });
      operation = { ...operation, stage: "conversation-updated" };
    }
    return yield* commit({
      events: [],
      rollback: { ...operation, stage: "completed" },
      command: { id: operation.commandId, type: "checkpoint.rollback" },
    });
  });

  const rollback: ThreadEngine["Service"]["rollback"] = (actor, command) =>
    serialized(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const thread = visibleTo(current, actor);
        if (thread === null) return yield* new ThreadNotFoundError();
        const receipt = yield* Effect.orDie(store.receipt(command.commandId));
        if (receipt?._tag === "accepted") return { sequence: receipt.sequence };
        if (receipt?._tag === "rejected")
          return yield* ThreadCommandRejectedError.forCommand(
            { id: command.commandId, type: command.type },
            receipt.message,
          );
        const pending = yield* Effect.orDie(store.pendingRollback);
        if (pending !== null && pending.commandId !== command.commandId) {
          return yield* ThreadCommandRejectedError.forCommand(
            { id: command.commandId, type: command.type },
            "Undo recovery is still pending. Try again shortly.",
          );
        }
        if (pending === null) {
          const publication = yield* Effect.orDie(pullState.publication);
          if (
            (yield* Effect.orDie(pullState.pending)) !== null ||
            (publication !== null && publication.until_ms > (yield* Clock.currentTimeMillis))
          ) {
            return yield* ThreadCommandRejectedError.forCommand(
              { id: command.commandId, type: command.type },
              "Wait for this thread's Git operation to finish before undoing.",
            );
          }
          const machine = yield* Effect.orDie(store.machine);
          const operation = yield* rollbackService
            .prepare(thread.projection, thread.owner, command, machine.generation)
            .pipe(
              Effect.tapError((error) =>
                Effect.orDie(
                  store.recordRejection({
                    command: { id: command.commandId, type: command.type },
                    message: error.reason,
                  }),
                ),
              ),
            );
          yield* rollbackService.arm;
          yield* commit({
            events: [
              threadEvent(yield* context, "thread.metadata-updated", {
                ...thread.projection.thread,
                rollbackRequestId: operation.commandId,
                rollbackFailure: null,
              }),
            ],
            rollback: operation,
            machine: {
              ...ThreadStore.NO_MACHINE,
              generation: machine.generation + 1,
              machineClass: machine.machineClass,
              movedUp: machine.movedUp,
            },
          });
        }
        yield* rollbackService.arm;
        const sequence = yield* recoverRollback();
        return { sequence: sequence ?? current.head };
      }),
    );

  const dispatch: ThreadEngine["Service"]["dispatch"] = (actor, command, creation) =>
    command.type === "checkpoint.rollback"
      ? rollback(actor, command)
      : runCommand(
          actor,
          creation,
          {
            id: command.commandId,
            type: command.type,
            createsThread: command.type === "thread.create",
            ...(command.type === "thread.create" ? { projectId: command.projectId } : {}),
          },
          (projection, ctx, pool) => {
            const onItsPool =
              typeof pool === "string" ? commandOnPool(command, projection, pool) : command;
            return decide(
              projection,
              onItsPool.type === "thread.create" && creation.worktree
                ? {
                    ...onItsPool,
                    branch: creation.worktree.branch,
                    worktreePath: creation.worktree.path,
                  }
                : onItsPool,
              ctx,
              creation.idleSinceMs === undefined ? {} : { idleSinceMs: creation.idleSinceMs },
            );
          },
        ).pipe(Effect.map(({ sequence }) => ({ sequence })));

  const launch: ThreadEngine["Service"]["launch"] = (actor, input, creation) =>
    Effect.gen(function* () {
      const result = yield* runCommand(
        actor,
        creation,
        {
          id: input.commandId,
          type: "thread.launch",
          createsThread: true,
          projectId: input.projectId,
        },
        (projection, ctx, pool) =>
          decideLaunch(
            projection,
            typeof pool === "string"
              ? { ...input, modelSelection: onPool(input.modelSelection, pool) }
              : input,
            ctx,
            creation.worktree ?? null,
          ),
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
        // Callbacks can persist Git state before returning an empty event decision.
        if (current.thread !== null && (yield* Effect.orDie(store.pendingRollback)) !== null) {
          return yield* Effect.die("Undo recovery blocks thread writes.");
        }
        const decision = yield* decideWith(current.thread?.projection ?? null, yield* context);
        if (decision.events.length > 0 || decision.command !== undefined) {
          yield* commit({
            events: decision.events,
            ...(decision.command ? { command: decision.command } : {}),
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
      yield* recoverRollback().pipe(
        Effect.catchTags({ ThreadCommandRejectedError: () => Effect.succeed(null) }),
      );
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

  const hasTurnWork: ThreadEngine["Service"]["hasTurnWork"] = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    return (
      current.thread !== null &&
      ((yield* Effect.orDie(store.pendingRollback)) !== null ||
        hasPendingTurnWork(current.thread.projection))
    );
  });

  const summaryOf = (
    thread: Thread,
    current: Pick<State, "monitors" | "statusNote">,
    revision: number,
  ): ThreadSummary => {
    const started = workStartedAt(thread.projection);
    return {
      threadId: thread.projection.thread.id,
      contextId: thread.owner.contextId,
      revision,
      shell: threadShellFromProjection(thread.projection, current.monitors),
      ...(started === null ? {} : { workStartedAt: started }),
      ...(current.statusNote === null ? {} : { statusNote: current.statusNote }),
    };
  };

  const summary: ThreadEngine["Service"]["summary"] = (actor) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const thread = ownedBy(current, actor);
      if (thread === null) return null;
      const outbox = yield* Effect.orDie(store.outbox);
      return summaryOf(thread, current, outbox.revision);
    });

  const undelivered = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (current.thread === null) return null;
    const outbox = yield* Effect.orDie(store.outbox);
    return outbox.revision > outbox.delivered
      ? { thread: current.thread, current, revision: outbox.revision }
      : null;
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
            summary: summaryOf(pending.thread, pending.current, pending.revision),
          },
  );

  const acknowledgeSummary: ThreadEngine["Service"]["acknowledgeSummary"] = (revision) =>
    Effect.orDie(store.acknowledgeSummary(revision));

  const setMonitors: ThreadEngine["Service"]["setMonitors"] = (actor, monitors) =>
    serialized(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const thread = ownedBy(current, actor);
        if (thread === null) return yield* new ThreadNotFoundError();
        // Stored even while a turn hides them, so they show once it ends.
        const nextKey = summaryKey(thread.projection, monitors, current.statusNote);
        yield* Effect.orDie(
          store.saveMonitors({ monitors, summaryChanged: nextKey !== current.summaryKey }),
        );
        yield* Ref.set(state, { ...current, monitors, summaryKey: nextKey });
      }),
    );

  const statusNote: ThreadEngine["Service"]["statusNote"] = Effect.map(
    Ref.get(state),
    (current) => current.statusNote,
  );

  const writeStatusNote: ThreadEngine["Service"]["writeStatusNote"] = (input, by) =>
    serialized(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.thread === null) return yield* new ThreadNotFoundError();
        const { projection } = current.thread;
        if (by.author === "runtime" && supersedes(projection, by.runId)) return null;
        const note: ThreadStatusNote = {
          ...input,
          writtenAt: yield* DateTime.now,
          writtenBy: by.author,
          runId: by.author === "runtime" ? by.runId : noteRunId(projection),
        };
        const nextKey = summaryKey(projection, current.monitors, note);
        yield* Effect.orDie(
          store.saveStatusNote({ note, summaryChanged: nextKey !== current.summaryKey }),
        );
        yield* Ref.set(state, { ...current, statusNote: note, summaryKey: nextKey });
        return note;
      }),
    );

  const hasPendingEvents: ThreadEngine["Service"]["hasPendingEvents"] = Effect.gen(function* () {
    const { thread, head } = yield* Ref.get(state);
    return thread !== null && (yield* Effect.orDie(store.eventsDelivered)) < head;
  });

  const pendingEvents: ThreadEngine["Service"]["pendingEvents"] = (limit) =>
    Effect.gen(function* () {
      const { thread } = yield* Ref.get(state);
      if (thread === null) return null;
      const delivered = yield* Effect.orDie(store.eventsDelivered);
      const events = yield* Effect.orDie(store.events(delivered, limit));
      return events.length === 0
        ? null
        : { ownerUserId: thread.owner.userId, threadId: thread.projection.thread.id, events };
    });

  const acknowledgeEvents: ThreadEngine["Service"]["acknowledgeEvents"] = (through) =>
    Effect.orDie(store.acknowledgeEvents(through));

  const canSee: ThreadEngine["Service"]["canSee"] = (actor) =>
    Effect.map(Ref.get(state), (current) => visibleTo(current, actor) !== null);

  if (initialProjection !== null) {
    const baseline = baselineEvents(initialProjection, yield* context);
    if (baseline.length > 0) yield* commit({ events: baseline });
  }

  return ThreadEngine.of({
    canSee,
    dispatch,
    rollback,
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
    setMonitors,
    statusNote,
    writeStatusNote,
    hasPendingEvents,
    pendingEvents,
    acknowledgeEvents,
  });
});

export const layer = Layer.effect(ThreadEngine, make);
