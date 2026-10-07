import type {
  OrchestrationV2Command,
  OrchestrationV2SubscribeThreadInput,
  OrchestrationV2ThreadLaunchResult,
  OrchestrationV2ThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  type Actor,
  ThreadCommandRejectedError,
  type ThreadCreation,
  ThreadNotFoundError,
  type ThreadSnapshot,
  type ThreadSummary,
} from "./ThreadEngine.ts";
import { type LaunchInputWire, type ThreadObjectReply, wire } from "./threadWire.ts";

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

/** What a thread object answers. `ThreadObject` implements it method for method. */
export interface ThreadObjectApi {
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
}

type CommandFailure = ThreadNotFoundError | ThreadCommandRejectedError | ThreadObjectError;

export interface ThreadHandle {
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

/** Wraps any `ThreadObjectApi` (a Durable Object stub, or a test double) as Effects. */
export function handleFor(api: ThreadObjectApi): ThreadHandle {
  return {
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
      Stream.unwrap(
        call("subscribe", () => api.subscribe(actor, wire.subscribeInput.encode(input))).pipe(
          Effect.filterOrFail(
            (body): body is ReadableStream<Uint8Array> => body !== null,
            () => new ThreadNotFoundError(),
          ),
          Effect.map((body) =>
            Stream.fromReadableStream({
              evaluate: () => body,
              onError: (cause) => new ThreadObjectError({ operation: "subscribe", cause }),
            }).pipe(
              Stream.decodeText,
              Stream.splitLines,
              Stream.filter((line) => line.length > 0),
              Stream.mapEffect((line) =>
                decodeIn("subscribe", () => wire.batch.decode(JSON.parse(line))),
              ),
            ),
          ),
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
    /** The object's own HTTP entry: the Runner's socket. */
    readonly fetch: (request: Request) => Promise<Response>;
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
