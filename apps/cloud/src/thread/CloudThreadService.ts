import {
  type ChatAttachment,
  type OrchestrationV2Command,
  type OrchestrationV2SubscribeThreadInput,
  type OrchestrationV2ThreadBoundedSnapshot,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadLaunchResult,
  type OrchestrationV2ThreadStreamItem,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { PreviewPort } from "@signalbox/runner-protocol/PreviewTunnel";
import type {
  BrowsingCommand,
  BrowsingMember,
  BrowsingRecord,
  BrowsingStreamItem,
} from "@t3tools/contracts/signalboxBrowsing";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CloudAttachments } from "../attachments/CloudAttachments.ts";
import { remoteThreadWorktree } from "../user/contextProjects.ts";
import { ThreadContexts, type ThreadPlace, type ThreadTurn } from "../user/threadContexts.ts";
import type { BrowsingDispatched } from "./browsing/ThreadBrowsing.ts";
import type { PreviewLinkResult } from "./preview/PreviewGateway.ts";
import { commandThreadId, unsupported } from "./threadDecider.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";
import { ThreadKindTurns, withLevel } from "./ThreadKindTurns.ts";
import {
  type Actor,
  ThreadCommandRejectedError,
  type ThreadCreation,
  ThreadNotFoundError,
} from "./ThreadEngine.ts";

/**
 * The one way into cloud threads. The client socket's RPC handlers, the HTTP
 * snapshot routes, and later MCP tools, schedules and assistant deliveries all
 * call these methods, so a capability works the same from every entry point
 * and none of them carries logic of its own.
 */

export type CloudThreadError =
  | ThreadNotFoundError
  | ThreadCommandRejectedError
  | ThreadDirectory.ThreadObjectError;

type Batch = ReadonlyArray<OrchestrationV2ThreadStreamItem>;

/**
 * How long a subscription waits before resuming after its thread object went
 * away: quick for an eviction, backing off to 5 s while the object stays down.
 */
const resumeDelay = (failed: number) => Math.min(250 * 2 ** (failed - 1), 5_000);
const MAX_FAILED_RESUMES = 20;
const isThreadObjectError = Schema.is(ThreadDirectory.ThreadObjectError);

/**
 * A thread object's live stream that survives the object: when it is evicted
 * or redeployed mid-stream, `open` runs again after a backoff. A live stream
 * only ends because its object went away. `delivered` sees every item, so
 * `open` can resume after the last one.
 */
const resuming = <A, E>(input: {
  readonly operation: string;
  readonly threadId: ThreadId;
  readonly open: Stream.Stream<A, E | ThreadDirectory.ThreadObjectError>;
  readonly delivered: (item: A) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    // Failed attempts in a row; any delivered item resets it.
    const failures = yield* Ref.make(0);
    const attempt = (): Stream.Stream<A, E | ThreadDirectory.ThreadObjectError> =>
      input.open.pipe(
        Stream.tap((item) => Ref.set(failures, 0).pipe(Effect.andThen(input.delivered(item)))),
        Stream.concat(
          Stream.fail(
            new ThreadDirectory.ThreadObjectError({
              operation: input.operation,
              cause: "The thread object closed the stream.",
            }),
          ),
        ),
        Stream.catchIf(
          (error): error is ThreadDirectory.ThreadObjectError => isThreadObjectError(error),
          (error) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const failed = yield* Ref.updateAndGet(failures, (count) => count + 1);
                // An object that keeps failing without delivering anything is broken, not busy.
                if (failed > MAX_FAILED_RESUMES) return Stream.fail(error);
                yield* Effect.logWarning(`thread ${input.operation} interrupted; resuming`, {
                  threadId: input.threadId,
                  attempt: failed,
                  cause: error,
                });
                yield* Effect.sleep(resumeDelay(failed));
                return Stream.suspend(attempt);
              }),
            ),
        ),
      );
    return attempt();
  });

export class CloudThreadService extends Context.Service<
  CloudThreadService,
  {
    readonly dispatchCommand: (
      actor: Actor,
      command: OrchestrationV2Command,
    ) => Effect.Effect<{ readonly sequence: number }, CloudThreadError>;
    readonly launchThread: (
      actor: Actor,
      input: OrchestrationV2ThreadLaunchInput,
    ) => Effect.Effect<OrchestrationV2ThreadLaunchResult, CloudThreadError>;
    /**
     * The whole thread at its current sequence. Cloud threads are short
     * enough to send whole, so this is also the bounded window clients load
     * first, with no older history behind it.
     */
    readonly threadSnapshot: (
      actor: Actor,
      threadId: ThreadId,
    ) => Effect.Effect<
      OrchestrationV2ThreadBoundedSnapshot,
      ThreadNotFoundError | ThreadDirectory.ThreadObjectError
    >;
    /** Older history before a bounded window: none, since the window is the whole thread. */
    readonly threadHistoryPage: (
      actor: Actor,
      threadId: ThreadId,
    ) => Effect.Effect<
      OrchestrationV2ThreadHistoryPage,
      ThreadNotFoundError | ThreadDirectory.ThreadObjectError
    >;
    /**
     * `subscribeThread` that survives its thread object: when the object is
     * evicted or redeployed mid-stream, the subscription resumes from the last
     * sequence it delivered, so the client sees neither a gap nor a repeat.
     */
    readonly subscribeThread: (
      actor: Actor,
      input: OrchestrationV2SubscribeThreadInput,
    ) => Stream.Stream<Batch, CloudThreadError>;
    /**
     * The web servers the thread's machine runs, now and after every change.
     * Survives its thread object the same way, starting over from a snapshot.
     */
    readonly previews: (
      actor: Actor,
      threadId: ThreadId,
    ) => Stream.Stream<
      ReadonlyArray<PreviewPort>,
      ThreadNotFoundError | ThreadDirectory.ThreadObjectError
    >;
    /**
     * The thread's browser tabs (#585): the record, then every change, with
     * `you` naming the subscriber in the snapshot. Survives its thread object
     * by starting over from a fresh snapshot.
     */
    readonly browsing: (
      actor: Actor,
      threadId: ThreadId,
      you: BrowsingMember,
    ) => Stream.Stream<
      ReadonlyArray<BrowsingStreamItem>,
      ThreadNotFoundError | ThreadDirectory.ThreadObjectError
    >;
    /** Applies a browsing command as `by`; the record's sequence after it. */
    readonly browse: (
      actor: Actor,
      threadId: ThreadId,
      by: BrowsingMember,
      command: BrowsingCommand,
    ) => Effect.Effect<BrowsingDispatched, CloudThreadError>;
    /** The thread's browser tabs as of now. */
    readonly browsingRecord: (
      actor: Actor,
      threadId: ThreadId,
    ) => Effect.Effect<
      { readonly sequence: number; readonly record: BrowsingRecord },
      ThreadNotFoundError | ThreadDirectory.ThreadObjectError
    >;
    /** Whether `actor` can see `threadId` right now. */
    readonly canSee: (actor: Actor, threadId: ThreadId) => Effect.Effect<boolean>;
    /** A link that opens `actor`'s preview of `port` (see `preview/PreviewGateway.ts`). */
    readonly openPreview: (
      actor: Actor,
      threadId: ThreadId,
      port: number,
    ) => Effect.Effect<PreviewLinkResult, ThreadDirectory.ThreadObjectError>;
    /**
     * A turn's diagnostic record (JSON), by its run or trace id, or the
     * thread's recent turns for null: what happened on its machines, the
     * Runner's lines and its model requests. Null when the actor cannot see
     * the thread or no turn matches.
     */
    readonly turnDiagnostics: (
      actor: Actor,
      threadId: ThreadId,
      key: string | null,
    ) => Effect.Effect<string | null, ThreadDirectory.ThreadObjectError>;
  }
>()("@signalbox/cloud/thread/CloudThreadService") {}

/** The highest sequence a batch brings the client to, if it moves the cursor at all. */
const cursorAfter = (batch: Batch): number | undefined => {
  let cursor: number | undefined;
  for (const item of batch) {
    if (item.kind === "snapshot") cursor = item.snapshotSequence;
    if (item.kind === "event" || item.kind === "unknown-event") cursor = item.sequence;
  }
  return cursor;
};

/**
 * A new thread's place, its own branch when its drive is backed by a remote
 * (#135), and what its turn runs on and follows.
 */
const placed = (
  place: ThreadPlace | null,
  threadId: ThreadId,
  turn: ThreadTurn | null,
): ThreadCreation => ({
  place: place === null ? null : { contextId: place.contextId, driveId: place.driveId },
  worktree: place?.remote === true ? remoteThreadWorktree(place.driveId, threadId) : null,
  pools: turn?.pools ?? null,
  ...(turn === null ? {} : { instructions: turn.instructions, secrets: turn.secrets }),
});

/**
 * Runs `send` with `attachments` claimed into `threadId` (`CloudAttachments.claim`).
 * A thread that refuses the message never holds the copies, so they go again; after
 * any other failure the message may have landed, so they stay.
 */
const withClaimed = <A, E>(
  claims: CloudAttachments["Service"],
  input: {
    readonly actor: Actor;
    readonly threadId: ThreadId;
    readonly command: { readonly id: string; readonly type: string };
    readonly attachments: ReadonlyArray<ChatAttachment>;
  },
  send: (claimed: ReadonlyArray<ChatAttachment>) => Effect.Effect<A, E>,
) =>
  input.attachments.length === 0
    ? send(input.attachments)
    : claims
        .claim({
          userId: input.actor.userId,
          threadId: input.threadId,
          commandId: input.command.id,
          attachments: input.attachments,
        })
        .pipe(
          Effect.mapError((error) =>
            ThreadCommandRejectedError.forCommand(input.command, error.reason),
          ),
          Effect.flatMap((claimed) =>
            send(claimed.attachments).pipe(
              Effect.tapError((error) => (isRefusal(error) ? claimed.release : Effect.void)),
            ),
          ),
        );

const isRejected = Schema.is(ThreadCommandRejectedError);
const isNotFound = Schema.is(ThreadNotFoundError);
const isRefusal = (error: unknown) => isRejected(error) || isNotFound(error);

/** Commands that can start a turn or pick a model: they carry the resolved pools, instructions and secrets. */
const PICKS_A_POOL: ReadonlySet<OrchestrationV2Command["type"]> = new Set([
  "thread.create",
  "message.dispatch",
  "thread.model-selection.set",
]);

/** What a command sends, for the thread's kind (`ThreadKindTurns`). */
const messageOf = (command: OrchestrationV2Command) =>
  command.type === "message.dispatch" ? { text: command.text, title: command.titleSeed } : null;

const make = Effect.gen(function* () {
  const directory = yield* ThreadDirectory.ThreadDirectory;
  const crypto = yield* Crypto.Crypto;
  const threadContexts = yield* ThreadContexts;
  const attachments = yield* CloudAttachments;
  const kindTurns = yield* ThreadKindTurns;

  /** The thread's turn from its home's chain, with its kind's level last on it. */
  const turnOf = (
    threadId: ThreadId,
    projectId: ProjectId | null,
    message: Parameters<ThreadKindTurns["Service"]["beforeTurn"]>[1],
  ) =>
    Effect.map(
      // A first message waits on its classifier; the chain resolves meanwhile.
      Effect.all(
        [threadContexts.turn(threadId, projectId), kindTurns.beforeTurn(threadId, message)],
        { concurrency: 2 },
      ),
      ([turn, level]) => ({ ...turn, instructions: withLevel(turn.instructions, level) }),
    );

  const dispatchCommand: CloudThreadService["Service"]["dispatchCommand"] = (actor, command) =>
    Effect.gen(function* () {
      const threadId = commandThreadId(command);
      if (threadId === null) {
        return yield* ThreadCommandRejectedError.forCommand(
          { id: command.commandId, type: command.type },
          unsupported(command.type),
        );
      }
      // Only a create can make a thread, so only a create names its place. The
      // thread object rejects a new thread without one, after replaying retries.
      const place =
        command.type === "thread.create"
          ? yield* threadContexts.placeOfProject(command.projectId)
          : null;
      // Resolved on every turn start, so a thread that moved runs on its new home's chain.
      const turn = PICKS_A_POOL.has(command.type)
        ? yield* turnOf(
            threadId,
            command.type === "thread.create" ? command.projectId : null,
            messageOf(command),
          )
        : null;
      const creation = placed(place, threadId, turn);
      if (command.type !== "message.dispatch") {
        return yield* directory.forThread(threadId).dispatch(actor, command, creation);
      }
      return yield* withClaimed(
        attachments,
        {
          actor,
          threadId,
          command: { id: command.commandId, type: command.type },
          attachments: command.attachments,
        },
        (claimed) =>
          directory
            .forThread(threadId)
            .dispatch(actor, { ...command, attachments: claimed }, creation),
      );
    });

  const launchThread: CloudThreadService["Service"]["launchThread"] = (actor, input) =>
    Effect.gen(function* () {
      const place = yield* threadContexts.placeOfProject(input.projectId);
      // Receipts live in the thread's object, so a launch without an id needs
      // the same id on every retry: derive it from who launched and the command id.
      const threadId =
        input.threadId ??
        ThreadId.make(
          `thread:${yield* Effect.orDie(
            crypto
              .digest("SHA-256", new TextEncoder().encode(`${actor.userId}\n${input.commandId}`))
              .pipe(Effect.map(Hex.encode)),
          )}`,
        );
      const message = input.initialMessage;
      const creation = placed(
        place,
        threadId,
        yield* turnOf(
          threadId,
          input.projectId,
          message === undefined ? null : { text: message.text, title: input.title },
        ),
      );
      return yield* withClaimed(
        attachments,
        {
          actor,
          threadId,
          command: { id: input.commandId, type: "thread.launch" },
          attachments: message?.attachments ?? [],
        },
        (claimed) =>
          directory.forThread(threadId).launch(
            actor,
            {
              ...input,
              threadId,
              ...(message === undefined
                ? {}
                : { initialMessage: { ...message, attachments: claimed } }),
            },
            creation,
          ),
      );
    });

  const threadSnapshot: CloudThreadService["Service"]["threadSnapshot"] = (actor, threadId) =>
    Effect.map(
      directory.forThread(threadId).snapshot(actor),
      ({ snapshotSequence, projection }) => ({
        snapshotSequence,
        projection,
        historyCursor: null,
        hasMoreHistory: false,
        latestLocalTurnOrdinal: projection.turnItems.reduce<number | null>(
          (latest, item) => (latest === null || item.ordinal > latest ? item.ordinal : latest),
          null,
        ),
      }),
    );

  const threadHistoryPage: CloudThreadService["Service"]["threadHistoryPage"] = (actor, threadId) =>
    Effect.map(directory.forThread(threadId).snapshot(actor), ({ snapshotSequence }) => ({
      snapshotSequence,
      items: [],
      nextCursor: null,
      hasMoreHistory: false,
    }));

  const subscribeThread: CloudThreadService["Service"]["subscribeThread"] = (actor, input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const handle = directory.forThread(input.threadId);
        const cursor = yield* Ref.make(input.afterSequence);
        return yield* resuming({
          operation: "subscribe",
          threadId: input.threadId,
          open: Stream.unwrap(
            Effect.map(Ref.get(cursor), (afterSequence) =>
              handle.subscribe(actor, {
                ...input,
                ...(afterSequence === undefined ? {} : { afterSequence }),
              }),
            ),
          ),
          delivered: (batch) => {
            const next = cursorAfter(batch);
            return next === undefined ? Effect.void : Ref.set(cursor, next);
          },
        });
      }),
    );

  const previews: CloudThreadService["Service"]["previews"] = (actor, threadId) =>
    Stream.unwrap(
      resuming({
        operation: "previews",
        threadId,
        open: directory.forThread(threadId).previews(actor),
        delivered: () => Effect.void,
      }),
    );

  const browsing: CloudThreadService["Service"]["browsing"] = (actor, threadId, you) =>
    Stream.unwrap(
      resuming({
        operation: "browsing",
        threadId,
        open: directory.forThread(threadId).browsing(actor, you),
        delivered: () => Effect.void,
      }),
    );

  const openPreview: CloudThreadService["Service"]["openPreview"] = (actor, threadId, port) =>
    directory.forThread(threadId).previewLink(actor, port);

  const canSee: CloudThreadService["Service"]["canSee"] = (actor, threadId) =>
    directory
      .forThread(threadId)
      .summary(actor)
      .pipe(
        Effect.map((summary) => summary !== null),
        Effect.orElseSucceed(() => false),
      );

  return CloudThreadService.of({
    canSee,
    previews,
    browsing,
    browse: (actor, threadId, by, command) =>
      directory.forThread(threadId).browse(actor, by, command),
    browsingRecord: (actor, threadId) => directory.forThread(threadId).browsingRecord(actor),
    openPreview,
    dispatchCommand,
    launchThread,
    threadSnapshot,
    threadHistoryPage,
    subscribeThread,
    turnDiagnostics: (actor, threadId, key) =>
      directory.forThread(threadId).diagnostics(actor, key),
  });
});

export const layer = Layer.effect(CloudThreadService, make);
