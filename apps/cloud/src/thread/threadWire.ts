import {
  ModelSelection,
  NonNegativeInt,
  OrchestrationV2Command,
  OrchestrationV2DomainEventJson,
  OrchestrationV2SubscribeThreadInput,
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2ThreadLaunchResult,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import {
  AgentBrowserInput,
  AgentBrowserStep,
  AgentBrowserUpdate,
  SignalboxPreviewPort,
  SignalboxThreadPreviews,
} from "@t3tools/contracts/signalboxPreviews";
import { ThreadStatusNote } from "@t3tools/contracts/signalboxStatusLine";
import { PullResult } from "@signalbox/runner-protocol/PullProtocol";
import * as Schema from "effect/Schema";

/**
 * What crosses Durable Object RPC between the Worker, user objects and thread
 * objects. RPC uses structured clone, which drops the prototypes of decoded
 * values (dates, branded classes), so every payload travels in the same JSON
 * encoding the client protocol uses and is decoded on arrival. The contract's
 * forward-compatible unions decode events a newer object sends during a
 * rollout instead of failing on them.
 */

/** Encode and decode for one schema in its JSON form, for values that cross object RPC. */
export const jsonCodec = <
  S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
>(
  schema: S,
) => {
  const codec = Schema.toCodecJson(schema);
  return {
    encode: Schema.encodeSync(codec) as (value: S["Type"]) => unknown,
    decode: Schema.decodeUnknownSync(codec) as (input: unknown) => S["Type"],
  };
};

export const ThreadSummaryWire = Schema.Struct({
  threadId: ThreadId,
  contextId: SignalboxContextId,
  revision: NonNegativeInt,
  shell: OrchestrationV2ThreadShell,
  /**
   * When a turn first changed files (`threadProjection.workStartedAt`), for
   * the thread's kind. Absent: none yet, or an object from before #46.
   */
  workStartedAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** The thread's status note (#670). Absent: none written yet, or an object from before. */
  statusNote: Schema.optionalKey(ThreadStatusNote),
});

export const LaunchInputWire = Schema.Struct({
  ...OrchestrationV2ThreadLaunchInput.fields,
  modelSelection: ModelSelection,
  threadId: ThreadId,
});

export const ThreadSnapshotWire = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projection: OrchestrationV2ThreadProjection,
});

/**
 * An automation run attached to the thread, listed among its background tasks
 * as a monitor while it runs, so the thread stays in Working.
 */
export const ThreadMonitorWire = Schema.Struct({
  taskId: Schema.String,
  description: Schema.String,
});
export type ThreadMonitor = typeof ThreadMonitorWire.Type;

const PullInputWire = Schema.Struct({
  driveId: Schema.String,
  operationId: Schema.String,
  target: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  branch: Schema.String,
});
export type PullInput = typeof PullInputWire.Type;

export const wire = {
  summary: jsonCodec(ThreadSummaryWire),
  command: jsonCodec(OrchestrationV2Command),
  launchInput: jsonCodec(LaunchInputWire),
  launchResult: jsonCodec(OrchestrationV2ThreadLaunchResult),
  snapshot: jsonCodec(ThreadSnapshotWire),
  subscribeInput: jsonCodec(OrchestrationV2SubscribeThreadInput),
  batch: jsonCodec(Schema.Array(OrchestrationV2ThreadStreamItem)),
  /** `SignalboxThreadPreviews` without its thread id, which the stream's caller knows. */
  previews: jsonCodec(
    Schema.Struct({
      ports: SignalboxThreadPreviews.fields.ports,
      browsed: SignalboxThreadPreviews.fields.browsed,
    }),
  ),
  monitors: jsonCodec(Schema.Array(ThreadMonitorWire)),
  pullInput: jsonCodec(PullInputWire),
  pullResult: jsonCodec(PullResult),
  browserUpdate: jsonCodec(AgentBrowserUpdate),
  browserInput: jsonCodec(AgentBrowserInput),
  browserSteps: jsonCodec(Schema.Array(AgentBrowserStep)),
  /** A thread's domain events with their sequence, on their way to its owner's automations. */
  events: jsonCodec(
    Schema.Array(
      Schema.Struct({ sequence: NonNegativeInt, event: OrchestrationV2DomainEventJson }),
    ),
  ),
};

/** A thread object's answer to a call. Failures travel as values: RPC exceptions lose their type. */
export type ThreadObjectReply<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "not_found" }
  | {
      readonly _tag: "rejected";
      readonly commandId: string;
      readonly commandType: string;
      readonly reason: string;
    };

/** The thread's previews travel as newline-delimited JSON too, one snapshot per line. */
export const previewsLine = (ports: ReadonlyArray<SignalboxPreviewPort>, browsed: boolean) =>
  JSON.stringify(wire.previews.encode(browsed ? { ports, browsed } : { ports }));

/** The agent's browser travels as newline-delimited JSON too, one update per line. */
export const browserUpdateLine = (update: AgentBrowserUpdate) =>
  JSON.stringify(wire.browserUpdate.encode(update));

/**
 * The last line of a watch stream whose viewer fell behind the browser: the
 * stream ends for good, and the client opens a new one when its person is back.
 */
export const BrowserWatchBehind = Schema.TaggedStruct("behind", {});
export const browserBehindLine = JSON.stringify({ _tag: "behind" });

/** A thread object's answer about the agent's browser, or why it has none. */
export type BrowserReply<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "unavailable"; readonly message: string };

const lineEncoder = new TextEncoder();

/** One value of a newline-delimited JSON stream, encoded with `codec`. */
export const jsonLine =
  <A>(codec: { readonly encode: (value: A) => unknown }) =>
  (value: A) =>
    lineEncoder.encode(`${JSON.stringify(codec.encode(value))}\n`);

/** Stream batches travel as newline-delimited JSON, one commit per line. */
export const encodeBatchLine = jsonLine<ReadonlyArray<OrchestrationV2ThreadStreamItem>>(wire.batch);
