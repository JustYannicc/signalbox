import {
  type OrchestrationV2Command,
  type OrchestrationV2SubscribeThreadInput,
  type OrchestrationV2ThreadBoundedSnapshot,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadLaunchResult,
  type OrchestrationV2ThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import type { PreviewPort } from "@signalbox/runner-protocol/PreviewTunnel";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ThreadContexts } from "../user/threadContexts.ts";
import type { PreviewLinkResult } from "./preview/PreviewGateway.ts";
import { commandThreadId, unsupported } from "./threadDecider.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";
import {
  type Actor,
  ThreadCommandRejectedError,
  type ThreadNotFoundError,
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

const make = Effect.gen(function* () {
  const directory = yield* ThreadDirectory.ThreadDirectory;
  const crypto = yield* Crypto.Crypto;
  const threadContexts = yield* ThreadContexts;

  const dispatchCommand: CloudThreadService["Service"]["dispatchCommand"] = (actor, command) =>
    Effect.gen(function* () {
      const threadId = commandThreadId(command);
      if (threadId === null) {
        return yield* ThreadCommandRejectedError.forCommand(
          { id: command.commandId, type: command.type },
          unsupported(command.type),
        );
      }
      // Only a create can make a thread, so only a create names its context. The
      // thread object rejects a new thread without one, after replaying retries.
      const contextId =
        command.type === "thread.create"
          ? yield* threadContexts.contextOfProject(command.projectId)
          : null;
      return yield* directory.forThread(threadId).dispatch(actor, command, { contextId });
    });

  const launchThread: CloudThreadService["Service"]["launchThread"] = (actor, input) =>
    Effect.gen(function* () {
      const contextId = yield* threadContexts.contextOfProject(input.projectId);
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
      return yield* directory
        .forThread(threadId)
        .launch(actor, { ...input, threadId }, { contextId });
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

  const openPreview: CloudThreadService["Service"]["openPreview"] = (actor, threadId, port) =>
    directory.forThread(threadId).previewLink(actor, port);

  return CloudThreadService.of({
    previews,
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
