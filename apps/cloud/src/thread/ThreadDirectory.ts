import type { PreviewPort } from "@signalbox/runner-protocol/PreviewTunnel";
import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import type { StatusNoteView } from "@signalbox/runner-protocol/StatusLineProtocol";
import type {
  OrchestrationV2Command,
  OrchestrationV2SubscribeThreadInput,
  OrchestrationV2ThreadLaunchResult,
  OrchestrationV2ThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import type {
  AgentBrowserInput,
  AgentBrowserStep,
  AgentBrowserUpdate,
} from "@t3tools/contracts/signalboxPreviews";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { ModelGatewayRecord } from "../modelGateway/modelGatewayRecord.ts";
import type { ThreadContextTurns, ThreadMatch } from "../context/threadContext.ts";
import type {
  BrowsingCommand,
  BrowsingMember,
  BrowsingRecord,
  BrowsingStreamItem,
} from "@t3tools/contracts/signalboxBrowsing";
import type { BrowsingDispatched } from "./browsing/ThreadBrowsing.ts";
import { browsingWire } from "./browsing/browsingWire.ts";
import type { PreviewLinkResult } from "./preview/PreviewGateway.ts";
import type {
  DriveAuthorization,
  ModelAuthorization,
  RemoteAuthorization,
} from "./runner/ThreadRunner.ts";
import {
  type Actor,
  ThreadCommandRejectedError,
  type ThreadCreation,
  ThreadNotFoundError,
  type ThreadSnapshot,
  type ThreadSummary,
} from "./ThreadEngine.ts";
import {
  type BrowserReply,
  BrowserWatchBehind,
  type LaunchInputWire,
  type ThreadMonitor,
  type ThreadObjectReply,
  wire,
} from "./threadWire.ts";

/**
 * How the Worker and user objects reach thread objects. Every thread has
 * exactly one, named by its thread id and always created in the EU
 * jurisdiction. Calls are Durable Object RPC with payloads in their JSON
 * encoding (see `threadWire.ts`); this module encodes and decodes them so
 * callers work with contract values.
 */

export const THREAD_OBJECT_JURISDICTION = "eu";

export class ThreadObjectError extends Schema.TaggedError<ThreadObjectError>()(
  "ThreadObjectError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Thread object call failed (${this.operation}).`;
  }
}

/** A watcher fell behind the agent's browser; its stream ended for good (see `preview/BrowserMirror.ts`). */
export class BrowserWatchBehindError extends Schema.TaggedError<BrowserWatchBehindError>()(
  "BrowserWatchBehindError",
  {},
) {
  override get message(): string {
    return "The view fell behind the browser.";
  }
}

/** What the thread's machine serves, and whether the agent has browsed (its trail has a step). */
export interface ThreadPreviews {
  readonly ports: ReadonlyArray<PreviewPort>;
  readonly browsed: boolean;
}

export interface ThreadLifecycleReceipt {
  readonly trashId: string;
  readonly deletedAt: number;
  readonly purgeAfter: number;
  readonly state: "trashed" | "restored";
}

export interface ThreadTrashInput {
  readonly trashId: string;
  readonly deletedAt: number;
  readonly purgeAfter: number;
}

export interface ThreadRestoreInput {
  readonly trashId: string;
}

export interface ThreadPurgeInput {
  readonly trashId: string;
  readonly empty?: boolean;
}

const isBehind = Schema.is(BrowserWatchBehind);
const ThreadLifecycleReceiptWire = Schema.Struct({
  trashId: Schema.String,
  deletedAt: Schema.Number,
  purgeAfter: Schema.Number,
  state: Schema.Literals(["trashed", "restored"]),
});
const decodeLifecycleReceipt = Schema.decodeUnknownSync(ThreadLifecycleReceiptWire);

/** What a thread object answers. `ThreadObject` implements it method for method. */
export interface ThreadObjectApi {
  readonly trash: (
    actor: Actor,
    input: ThreadTrashInput,
  ) => Promise<ThreadObjectReply<ThreadLifecycleReceipt>>;
  readonly restore: (
    actor: Actor,
    input: ThreadRestoreInput,
  ) => Promise<ThreadObjectReply<ThreadLifecycleReceipt>>;
  readonly purge: (
    actor: Actor,
    input: ThreadPurgeInput,
  ) => Promise<ThreadObjectReply<ThreadLifecycleReceipt>>;
  readonly dispatch: (
    actor: Actor,
    command: unknown,
    creation: ThreadCreation,
  ) => Promise<ThreadObjectReply<{ readonly sequence: number }>>;
  readonly launch: (
    actor: Actor,
    input: unknown,
    creation: ThreadCreation,
  ) => Promise<ThreadObjectReply<unknown>>;
  readonly snapshot: (actor: Actor) => Promise<ThreadObjectReply<unknown>>;
  /** Newline-delimited JSON batches, or null when the actor cannot see the thread. */
  readonly subscribe: (actor: Actor, input: unknown) => Promise<ReadableStream<Uint8Array> | null>;
  /** The thread's current summary, when `actor` owns it. */
  readonly summary: (actor: Actor) => Promise<unknown>;
  /**
   * A turn's diagnostic record as JSON, by run or trace id, or the list of
   * recent turns for null. Null when the actor cannot see the thread or no
   * turn matches.
   */
  readonly diagnostics: (actor: Actor, key: string | null) => Promise<string | null>;
  /** Newline-delimited `{ ports }` snapshots, or null when the actor cannot see the thread. */
  readonly previews: (actor: Actor) => Promise<ReadableStream<Uint8Array> | null>;
  readonly previewLink: (
    actor: Actor,
    port: number,
    handoff?: boolean,
  ) => Promise<PreviewLinkResult>;
  /**
   * The agent's browser, mirrored: newline-delimited `AgentBrowserUpdate`s in
   * their JSON encoding (`wire.browserUpdate`) while read, following `tabId`
   * (null: the agent's current tab). Null when the actor can't see the thread.
   */
  readonly browserWatch: (
    actor: Actor,
    tabId: string | null,
  ) => Promise<ReadableStream<Uint8Array> | null>;
  /** Input from the actor's own watch stream `viewerId` (`wire.browserInput`). */
  readonly browserInput: (
    actor: Actor,
    viewerId: string,
    input: unknown,
  ) => Promise<BrowserReply<null>>;
  /** The browser trail, oldest first (`wire.browserSteps`). */
  readonly browserTrail: (actor: Actor) => Promise<BrowserReply<unknown>>;
  /** One trail step's rrweb recording, a JSON array. */
  readonly browserStep: (actor: Actor, stepId: string) => Promise<BrowserReply<string>>;
  /** Which of `terms` the thread holds, for the context tool; null when none, or it's not the actor's to see. */
  readonly contextMatch: (
    actor: Actor,
    terms: ReadonlyArray<string>,
  ) => Promise<ThreadMatch | null>;
  /** The thread's turns for the context tool (`turn`: just that one); null when the actor can't see it. */
  readonly contextTurns: (actor: Actor, turn: number | null) => Promise<ThreadContextTurns | null>;
  /**
   * The owner's automations: the runs attached to the thread now, in their
   * JSON encoding (`wire.monitors`). Its shell lists them as monitors; an
   * empty list clears them. `not_found` unless `actor` owns the thread.
   */
  readonly setMonitors: (actor: Actor, monitors: unknown) => Promise<ThreadObjectReply<void>>;
  /**
   * The thread's browsing (`browsing/ThreadBrowsing.ts`) as newline-delimited
   * batches of stream items, with `you` in the snapshot. Null when the actor
   * cannot see the thread.
   */
  readonly browsing: (actor: Actor, you: unknown) => Promise<ReadableStream<Uint8Array> | null>;
  /** Applies a browsing command as `by`. `rejected` carries why. */
  readonly browse: (
    actor: Actor,
    by: unknown,
    command: unknown,
  ) => Promise<ThreadObjectReply<unknown>>;
  /** The browsing record now, in its JSON encoding. */
  readonly browsingRecord: (actor: Actor) => Promise<ThreadObjectReply<unknown>>;
}

type CommandFailure = ThreadNotFoundError | ThreadCommandRejectedError | ThreadObjectError;

export interface ThreadHandle {
  readonly trash: (
    actor: Actor,
    input: ThreadTrashInput,
  ) => Effect.Effect<
    ThreadLifecycleReceipt,
    ThreadNotFoundError | ThreadCommandRejectedError | ThreadObjectError
  >;
  readonly restore: (
    actor: Actor,
    input: ThreadRestoreInput,
  ) => Effect.Effect<
    ThreadLifecycleReceipt,
    ThreadNotFoundError | ThreadCommandRejectedError | ThreadObjectError
  >;
  readonly purge: (
    actor: Actor,
    input: ThreadPurgeInput,
  ) => Effect.Effect<
    ThreadLifecycleReceipt,
    ThreadNotFoundError | ThreadCommandRejectedError | ThreadObjectError
  >;
  readonly dispatch: (
    actor: Actor,
    command: OrchestrationV2Command,
    creation: ThreadCreation,
  ) => Effect.Effect<{ readonly sequence: number }, CommandFailure>;
  readonly launch: (
    actor: Actor,
    input: typeof LaunchInputWire.Type,
    creation: ThreadCreation,
  ) => Effect.Effect<OrchestrationV2ThreadLaunchResult, CommandFailure>;
  readonly snapshot: (
    actor: Actor,
  ) => Effect.Effect<ThreadSnapshot, ThreadNotFoundError | ThreadObjectError>;
  /** One subscription. Ends when the object goes away; resuming is the caller's job. */
  readonly subscribe: (
    actor: Actor,
    input: OrchestrationV2SubscribeThreadInput,
  ) => Stream.Stream<
    ReadonlyArray<OrchestrationV2ThreadStreamItem>,
    ThreadNotFoundError | ThreadObjectError
  >;
  readonly summary: (actor: Actor) => Effect.Effect<ThreadSummary | null, ThreadObjectError>;
  /** See `ThreadObjectApi.diagnostics`; the record is passed through as JSON text. */
  readonly diagnostics: (
    actor: Actor,
    key: string | null,
  ) => Effect.Effect<string | null, ThreadObjectError>;
  /** What the thread's machine serves, now and after every change. Ends when the object goes away. */
  readonly previews: (
    actor: Actor,
  ) => Stream.Stream<ThreadPreviews, ThreadNotFoundError | ThreadObjectError>;
  readonly previewLink: (
    actor: Actor,
    port: number,
    handoff?: boolean,
  ) => Effect.Effect<PreviewLinkResult, ThreadObjectError>;
  /**
   * See `ThreadObjectApi.browserWatch`. Ends when the object goes away, or
   * fails with `BrowserWatchBehindError` when the watcher fell behind.
   */
  readonly browserWatch: (
    actor: Actor,
    tabId: string | null,
  ) => Stream.Stream<
    AgentBrowserUpdate,
    ThreadNotFoundError | ThreadObjectError | BrowserWatchBehindError
  >;
  readonly browserInput: (
    actor: Actor,
    viewerId: string,
    input: AgentBrowserInput,
  ) => Effect.Effect<BrowserReply<null>, ThreadObjectError>;
  readonly browserTrail: (
    actor: Actor,
  ) => Effect.Effect<BrowserReply<ReadonlyArray<AgentBrowserStep>>, ThreadObjectError>;
  readonly browserStep: (
    actor: Actor,
    stepId: string,
  ) => Effect.Effect<BrowserReply<string>, ThreadObjectError>;
  readonly contextMatch: (
    actor: Actor,
    terms: ReadonlyArray<string>,
  ) => Effect.Effect<ThreadMatch | null, ThreadObjectError>;
  readonly contextTurns: (
    actor: Actor,
    turn: number | null,
  ) => Effect.Effect<ThreadContextTurns | null, ThreadObjectError>;
  /**
   * See `ThreadObjectApi.setMonitors`. A thread that is gone, or not the
   * actor's, has nothing to show them on, so that changes nothing.
   */
  readonly setMonitors: (
    actor: Actor,
    monitors: ReadonlyArray<ThreadMonitor>,
  ) => Effect.Effect<void, ThreadObjectError>;
  /** One browsing subscription. Ends when the object goes away; resuming is the caller's job. */
  readonly browsing: (
    actor: Actor,
    you: BrowsingMember,
  ) => Stream.Stream<ReadonlyArray<BrowsingStreamItem>, ThreadNotFoundError | ThreadObjectError>;
  readonly browse: (
    actor: Actor,
    by: BrowsingMember,
    command: BrowsingCommand,
  ) => Effect.Effect<
    BrowsingDispatched,
    ThreadNotFoundError | ThreadCommandRejectedError | ThreadObjectError
  >;
  readonly browsingRecord: (
    actor: Actor,
  ) => Effect.Effect<
    { readonly sequence: number; readonly record: BrowsingRecord },
    ThreadNotFoundError | ThreadObjectError
  >;
}

export class ThreadDirectory extends Context.Service<
  ThreadDirectory,
  { readonly forThread: (threadId: ThreadId) => ThreadHandle }
>()("@signalbox/cloud/thread/ThreadDirectory") {}

const call = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ThreadObjectError({ operation, cause }) });

const fromReply = <A>(
  reply: ThreadObjectReply<A>,
): Effect.Effect<A, ThreadNotFoundError | ThreadCommandRejectedError> => {
  switch (reply._tag) {
    case "ok":
      return Effect.succeed(reply.value);
    case "not_found":
      return Effect.fail(new ThreadNotFoundError());
    case "rejected":
      return Effect.fail(
        ThreadCommandRejectedError.forCommand(
          { id: reply.commandId, type: reply.commandType },
          reply.reason,
        ),
      );
  }
};

const decodeIn = <A>(operation: string, decode: () => A) =>
  Effect.try({ try: decode, catch: (cause) => new ThreadObjectError({ operation, cause }) });

/**
 * A thread object's newline-delimited JSON stream, one decoded value per line.
 * Null from `open` means the actor cannot see the thread.
 */
const lines = <A>(
  operation: string,
  open: () => Promise<ReadableStream<Uint8Array> | null>,
  decode: (line: unknown) => A,
): Stream.Stream<A, ThreadNotFoundError | ThreadObjectError> =>
  Stream.unwrap(
    call(operation, open).pipe(
      Effect.filterOrFail(
        (body): body is ReadableStream<Uint8Array> => body !== null,
        () => new ThreadNotFoundError(),
      ),
      Effect.map((body) =>
        Stream.fromReadableStream({
          evaluate: () => body,
          onError: (cause) => new ThreadObjectError({ operation, cause }),
        }).pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.filter((line) => line.length > 0),
          Stream.mapEffect((line) => decodeIn(operation, () => decode(JSON.parse(line)))),
        ),
      ),
    ),
  );

/** Wraps any `ThreadObjectApi` (a Durable Object stub, or a test double) as Effects. */
export function handleFor(api: ThreadObjectApi): ThreadHandle {
  const lifecycle = (
    operation: "trash" | "restore" | "purge",
    run: () => Promise<ThreadObjectReply<unknown>>,
  ) =>
    call(operation, run).pipe(
      Effect.flatMap(fromReply),
      Effect.flatMap((value) => decodeIn(operation, () => decodeLifecycleReceipt(value))),
    );
  return {
    trash: (actor, input) => lifecycle("trash", () => api.trash(actor, input)),
    restore: (actor, input) => lifecycle("restore", () => api.restore(actor, input)),
    purge: (actor, input) => lifecycle("purge", () => api.purge(actor, input)),
    dispatch: (actor, command, creation) =>
      call("dispatch", () => api.dispatch(actor, wire.command.encode(command), creation)).pipe(
        Effect.flatMap(fromReply),
      ),
    launch: (actor, input, creation) =>
      call("launch", () => api.launch(actor, wire.launchInput.encode(input), creation)).pipe(
        Effect.flatMap(fromReply),
        Effect.flatMap((value) => decodeIn("launch", () => wire.launchResult.decode(value))),
      ),
    snapshot: (actor) =>
      call("snapshot", () => api.snapshot(actor)).pipe(
        Effect.flatMap(fromReply),
        // Reads decide no command, so a rejection here is a protocol bug.
        Effect.catchTags({ ThreadCommandRejectedError: (error) => Effect.die(error) }),
        Effect.flatMap((value) => decodeIn("snapshot", () => wire.snapshot.decode(value))),
      ),
    subscribe: (actor, input) =>
      lines(
        "subscribe",
        () => api.subscribe(actor, wire.subscribeInput.encode(input)),
        (line) => wire.batch.decode(line),
      ),
    diagnostics: (actor, key) => call("diagnostics", () => api.diagnostics(actor, key)),
    previews: (actor) =>
      lines(
        "previews",
        () => api.previews(actor),
        (line): ThreadPreviews => {
          const { ports, browsed } = wire.previews.decode(line);
          return { ports, browsed: browsed === true };
        },
      ),
    previewLink: (actor, port, handoff) =>
      call("previewLink", () => api.previewLink(actor, port, handoff)),
    browserWatch: (actor, tabId) =>
      lines(
        "browserWatch",
        () => api.browserWatch(actor, tabId),
        (line) => (isBehind(line) ? null : wire.browserUpdate.decode(line)),
      ).pipe(
        Stream.mapEffect((update) =>
          update === null ? Effect.fail(new BrowserWatchBehindError()) : Effect.succeed(update),
        ),
      ),
    browserInput: (actor, viewerId, input) =>
      call("browserInput", () =>
        api.browserInput(actor, viewerId, wire.browserInput.encode(input)),
      ),
    browserTrail: (actor) =>
      call("browserTrail", () => api.browserTrail(actor)).pipe(
        Effect.flatMap(
          (
            reply,
          ): Effect.Effect<BrowserReply<ReadonlyArray<AgentBrowserStep>>, ThreadObjectError> =>
            reply._tag === "ok"
              ? decodeIn("browserTrail", () => ({
                  _tag: "ok",
                  value: wire.browserSteps.decode(reply.value),
                }))
              : Effect.succeed(reply),
        ),
      ),
    browserStep: (actor, stepId) => call("browserStep", () => api.browserStep(actor, stepId)),
    contextMatch: (actor, terms) => call("contextMatch", () => api.contextMatch(actor, terms)),
    contextTurns: (actor, turn) => call("contextTurns", () => api.contextTurns(actor, turn)),
    setMonitors: (actor, monitors) =>
      call("setMonitors", () => api.setMonitors(actor, wire.monitors.encode(monitors))).pipe(
        Effect.flatMap(fromReply),
        Effect.catchTags({
          ThreadNotFoundError: () => Effect.void,
          // Monitors decide no command, so a rejection here is a protocol bug.
          ThreadCommandRejectedError: (error) => Effect.die(error),
        }),
      ),
    browsing: (actor, you) =>
      lines(
        "browsing",
        () => api.browsing(actor, browsingWire.member.encode(you)),
        (line) => browsingWire.batch.decode(line),
      ),
    browse: (actor, by, command) =>
      call("browse", () =>
        api.browse(actor, browsingWire.member.encode(by), browsingWire.command.encode(command)),
      ).pipe(
        Effect.flatMap(fromReply),
        Effect.flatMap((value) => decodeIn("browse", () => browsingWire.dispatched.decode(value))),
      ),
    browsingRecord: (actor) =>
      call("browsingRecord", () => api.browsingRecord(actor)).pipe(
        Effect.flatMap(fromReply),
        // Reads decide no command, so a rejection here is a protocol bug.
        Effect.catchTags({ ThreadCommandRejectedError: (error) => Effect.die(error) }),
        Effect.flatMap((value) =>
          decodeIn("browsingRecord", () => browsingWire.head.decode(value)),
        ),
      ),
    summary: (actor) =>
      call("summary", () => api.summary(actor)).pipe(
        Effect.flatMap((value) =>
          value === null
            ? Effect.succeed(null)
            : decodeIn("summary", () => wire.summary.decode(value)),
        ),
      ),
  };
}

/** The slice of the `THREADS` Durable Object namespace binding callers use. */
export interface ThreadObjectNamespace {
  readonly idFromName: (name: string) => DurableObjectId;
  readonly jurisdiction: (name: typeof THREAD_OBJECT_JURISDICTION) => {
    readonly idFromName: (name: string) => DurableObjectId;
  };
  readonly get: (id: DurableObjectId) => ThreadObjectApi & {
    /** The object's own HTTP entry: the Runner's sockets and preview requests. */
    readonly fetch: (request: Request) => Promise<Response>;
    readonly authorizeModel: (
      token: string,
      provider: ModelGatewayProvider,
    ) => Promise<ModelAuthorization>;
    readonly recordModelRequest: (record: ModelGatewayRecord) => Promise<void>;
    readonly authorizeDrive: (token: string) => Promise<DriveAuthorization>;
    readonly authorizeRemote: (token: string) => Promise<RemoteAuthorization>;
    /** The thread's status line for its agent (`statusLineJson.read`); null before it exists. */
    readonly statusLine: () => Promise<string | null>;
    /** The agent's note (`statusLineJson.writeRequest`); the stored note, null when the thread is gone. */
    readonly writeStatusNote: (input: string) => Promise<StatusNoteView | null>;
  };
}

/** `localWorkerd`: local workerd has no jurisdictions, so `wrangler dev` uses the plain namespace. */
export const threadObjectStub = (
  namespace: ThreadObjectNamespace,
  threadId: ThreadId,
  options: { readonly localWorkerd: boolean },
) => {
  const ids = options.localWorkerd ? namespace : namespace.jurisdiction(THREAD_OBJECT_JURISDICTION);
  return namespace.get(ids.idFromName(threadId));
};

export const layerDurableObjects = (
  namespace: ThreadObjectNamespace,
  options: { readonly localWorkerd: boolean },
) =>
  Layer.succeed(
    ThreadDirectory,
    ThreadDirectory.of({
      forThread: (threadId) => handleFor(threadObjectStub(namespace, threadId, options)),
    }),
  );
