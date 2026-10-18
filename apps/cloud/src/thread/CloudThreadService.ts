import {
  type OrchestrationV2Command,
  type OrchestrationV2DispatchCommandResult,
  type OrchestrationV2SubscribeThreadInput,
  type OrchestrationV2ThreadBoundedSnapshot,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadLaunchResult,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId,
  SecretRequestError,
  type SecretRequestAnswerInput,
} from "@t3tools/contracts";
import type { PullResult } from "@signalbox/runner-protocol/PullProtocol";
import type {
  BrowsingCommand,
  BrowsingMember,
  BrowsingRecord,
  BrowsingStreamItem,
} from "@t3tools/contracts/signalboxBrowsing";
import type {
  AgentBrowserInput,
  AgentBrowserStep,
  AgentBrowserUpdate,
} from "@t3tools/contracts/signalboxPreviews";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { BrowsingDispatched } from "./browsing/ThreadBrowsing.ts";
import type { PreviewLinkResult } from "./preview/PreviewGateway.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";
import type { BrowserReply } from "./threadWire.ts";
import * as Threads from "./Threads.ts";
import { resuming } from "./core/resuming.ts";
import type {
  Actor,
  ThreadCommandRejectedError,
  ThreadNotFoundError,
  ThreadObjectError,
} from "./ThreadAccess.ts";
import type { PullInput } from "./threadWire.ts";

/**
 * Compatibility entry for core thread calls alongside browser and preview capabilities.
 * Core callers use Threads; the auxiliary capabilities keep their existing signatures.
 */

export type CloudThreadError = ThreadNotFoundError | ThreadCommandRejectedError | ThreadObjectError;

type Batch = ReadonlyArray<OrchestrationV2ThreadStreamItem>;

export class CloudThreadService extends Context.Service<
  CloudThreadService,
  {
    readonly answerSecret: (
      actor: Actor,
      input: SecretRequestAnswerInput,
    ) => Effect.Effect<void, SecretRequestError>;
    readonly dispatchCommand: (
      actor: Actor,
      command: OrchestrationV2Command,
    ) => Effect.Effect<OrchestrationV2DispatchCommandResult, CloudThreadError>;
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
      ThreadNotFoundError | ThreadObjectError
    >;
    /** Older history before a bounded window: none, since the window is the whole thread. */
    readonly threadHistoryPage: (
      actor: Actor,
      threadId: ThreadId,
    ) => Effect.Effect<OrchestrationV2ThreadHistoryPage, ThreadNotFoundError | ThreadObjectError>;
    /** Asks the thread's owner token to refresh one link currently visible on the thread. */
    readonly requestPullRequestSync: (
      actor: Actor,
      threadId: ThreadId,
      key: string,
    ) => Effect.Effect<void, CloudThreadError>;
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
    ) => Stream.Stream<ThreadDirectory.ThreadPreviews, ThreadNotFoundError | ThreadObjectError>;
    /**
     * The thread's browser tabs (#585): the record, then every change, with
     * `you` naming the subscriber in the snapshot. Survives its thread object
     * by starting over from a fresh snapshot.
     */
    readonly browsing: (
      actor: Actor,
      threadId: ThreadId,
      you: BrowsingMember,
    ) => Stream.Stream<ReadonlyArray<BrowsingStreamItem>, ThreadNotFoundError | ThreadObjectError>;
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
      ThreadNotFoundError | ThreadObjectError
    >;
    /** Whether `actor` can see `threadId` right now. */
    readonly canSee: (actor: Actor, threadId: ThreadId) => Effect.Effect<boolean>;
    /** A link that opens `actor`'s preview of `port` (see `preview/PreviewGateway.ts`). */
    readonly openPreview: (
      actor: Actor,
      threadId: ThreadId,
      port: number,
      handoff?: boolean,
    ) => Effect.Effect<PreviewLinkResult, ThreadObjectError>;
    /**
     * The agent's browser, mirrored, while the stream is read (see
     * `preview/BrowserMirror.ts`). Survives its thread object, starting over
     * as a new viewer; a viewer that fell behind ends with
     * `BrowserWatchBehindError` instead, for its client to reopen.
     */
    readonly browserWatch: (
      actor: Actor,
      threadId: ThreadId,
      tabId: string | null,
    ) => Stream.Stream<
      AgentBrowserUpdate,
      ThreadNotFoundError | ThreadObjectError | ThreadDirectory.BrowserWatchBehindError
    >;
    /** Input from `actor`'s watch stream `viewerId`: take over, drive, hand back. */
    readonly browserInput: (
      actor: Actor,
      threadId: ThreadId,
      viewerId: string,
      input: AgentBrowserInput,
    ) => Effect.Effect<BrowserReply<null>, ThreadObjectError>;
    /** The thread's browser trail, oldest first (see `preview/BrowserTrail.ts`). */
    readonly browserTrail: (
      actor: Actor,
      threadId: ThreadId,
    ) => Effect.Effect<BrowserReply<ReadonlyArray<AgentBrowserStep>>, ThreadObjectError>;
    /** One trail step's rrweb recording, a JSON array. */
    readonly browserStep: (
      actor: Actor,
      threadId: ThreadId,
      stepId: string,
    ) => Effect.Effect<BrowserReply<string>, ThreadObjectError>;
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
    ) => Effect.Effect<string | null, ThreadObjectError>;
    /** Pulls one thread-owned remote branch through its persisted operation. */
    readonly pull: (
      actor: Actor,
      threadId: ThreadId,
      input: PullInput,
    ) => Effect.Effect<PullResult, CloudThreadError>;
    /** The persisted thread owner's id after checking its home and the actor's write access. */
    readonly pullOwner: (
      actor: Actor,
      threadId: ThreadId,
      driveId: string,
    ) => Effect.Effect<
      { readonly userId: string; readonly driveId: string } | null,
      CloudThreadError
    >;
    /** The remote head already recorded for this operation, even after it completes. */
    readonly pullTarget: (
      actor: Actor,
      threadId: ThreadId,
      driveId: string,
      operationId: string,
      branch: string,
    ) => Effect.Effect<string | null, CloudThreadError>;
    /** Claims the thread while GitHub publication reads its exact branch refs. */
    readonly reservePublication: (
      actor: Actor,
      threadId: ThreadId,
      driveId: string,
      operationId: string,
    ) => Effect.Effect<void, CloudThreadError>;
    readonly releasePublication: (
      actor: Actor,
      threadId: ThreadId,
      driveId: string,
      operationId: string,
    ) => Effect.Effect<void, CloudThreadError>;
  }
>()("@signalbox/cloud/thread/CloudThreadService") {}

const make = Effect.gen(function* () {
  const directory = yield* ThreadDirectory.ThreadDirectory;
  const threads = yield* Threads.Threads;

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

  const openPreview: CloudThreadService["Service"]["openPreview"] = (
    actor,
    threadId,
    port,
    handoff,
  ) => directory.forThread(threadId).previewLink(actor, port, handoff);

  const canSee: CloudThreadService["Service"]["canSee"] = (actor, threadId) =>
    directory
      .forThread(threadId)
      .summary(actor)
      .pipe(
        Effect.map((summary) => summary !== null),
        Effect.orElseSucceed(() => false),
      );

  const browserWatch: CloudThreadService["Service"]["browserWatch"] = (actor, threadId, tabId) =>
    Stream.unwrap(
      resuming({
        operation: "browserWatch",
        threadId,
        open: directory.forThread(threadId).browserWatch(actor, tabId),
        delivered: () => Effect.void,
      }),
    );

  return CloudThreadService.of({
    answerSecret: (actor, input) =>
      directory
        .forThread(input.threadId)
        .answerSecret(actor, input)
        .pipe(
          Effect.catchTags({
            ThreadObjectError: () => Effect.fail(new SecretRequestError({ reason: "load_failed" })),
          }),
        ),
    canSee,
    previews,
    browsing,
    browse: (actor, threadId, by, command) =>
      directory.forThread(threadId).browse(actor, by, command),
    browsingRecord: (actor, threadId) => directory.forThread(threadId).browsingRecord(actor),
    openPreview,
    browserWatch,
    browserInput: (actor, threadId, viewerId, input) =>
      directory.forThread(threadId).browserInput(actor, viewerId, input),
    browserTrail: (actor, threadId) => directory.forThread(threadId).browserTrail(actor),
    browserStep: (actor, threadId, stepId) =>
      directory.forThread(threadId).browserStep(actor, stepId),
    dispatchCommand: threads.dispatch,
    launchThread: threads.launch,
    threadSnapshot: threads.snapshot,
    threadHistoryPage: threads.history,
    requestPullRequestSync: (actor, threadId, key) =>
      directory.forThread(threadId).requestPullRequestSync(actor, key),
    subscribeThread: threads.subscribe,
    turnDiagnostics: (actor, threadId, key) =>
      directory.forThread(threadId).diagnostics(actor, key),
    pull: (actor, threadId, input) => directory.forThread(threadId).pull(actor, input),
    pullOwner: (actor, threadId, driveId) =>
      directory.forThread(threadId).pullOwner(actor, driveId),
    pullTarget: (actor, threadId, driveId, operationId, branch) =>
      directory.forThread(threadId).pullTarget(actor, driveId, operationId, branch),
    reservePublication: (actor, threadId, driveId, operationId) =>
      directory.forThread(threadId).reservePublication(actor, driveId, operationId),
    releasePublication: (actor, threadId, driveId, operationId) =>
      directory.forThread(threadId).releasePublication(actor, driveId, operationId),
  });
});

export const layer = Layer.effect(CloudThreadService, make);
