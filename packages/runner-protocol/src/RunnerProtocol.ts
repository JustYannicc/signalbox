import {
  ChatAttachment,
  MessageId,
  ModelSelection,
  NodeId,
  NonNegativeInt,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  PositiveInt,
  ProviderInteractionMode,
  RunAttemptId,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { jsonCodec as frameCodec } from "./jsonCodec.ts";
import { DriveAccess, DriveFileChange, Oid } from "./DriveProtocol.ts";

/**
 * The wire protocol between a thread's Durable Object and the Runner driving
 * its harness on a machine. The Runner dials one outbound WebSocket per
 * thread and speaks first:
 *
 * 1. `hello` names the protocol and image, the machine, the generation and
 *    token the thread minted for this machine, and the last batch the Runner
 *    saw acknowledged. A stale or unknown generation is `refused`.
 * 2. The thread answers `welcome` with the last batch it committed and the
 *    run it considers live. The Runner drops everything up to that batch,
 *    resends the rest in order, and stops any turn the thread no longer wants.
 * 3. The thread sends `turn.start` and `interrupt`; the Runner streams
 *    sequenced `batch`es of what happened and the thread `ack`s each once its
 *    events are committed. A batch at or below the acknowledged sequence is a
 *    resend and changes nothing.
 * 4. Either side sends `end` before closing for good.
 *
 * Every frame is one JSON text message, except the heartbeat: the Runner sends
 * the bare text `ping` and the thread answers `pong`, without waking a
 * hibernating object. A Runner that hears nothing for a while treats the
 * socket as dead and reconnects, since a dropped network sends no close.
 *
 * Each turn also names the thread's drive (`DriveProtocol.ts`): the Runner
 * checks the thread's branch out as the harness's working directory, saves
 * after each batch of tool calls, and reconciles with the drive's `main`
 * before it reports the turn's end, reporting the turn's commit as a
 * checkpoint.
 *
 * The machine holds no provider keys. Its harnesses reach the models through
 * the ModelGateway named in `MachineEnsureRequest`, with the model token each
 * `turn.start` carries. That token works for that thread, provider and turn
 * only, and stops working when the turn ends.
 */

export const RUNNER_PROTOCOL_VERSION = 3;

export const RUNNER_HEARTBEAT_PING = "ping";
export const RUNNER_HEARTBEAT_PONG = "pong";

/** Where a Runner dials in, with `?threadId=`. The token travels in `hello`, never the URL. */
export const RUNNER_CONNECT_PATH = "/api/runner/connect";

/** One turn the thread hands to the Runner. Everything the adapter's `startTurn` needs. */
export const RunnerTurn = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  runOrdinal: PositiveInt,
  providerTurnOrdinal: PositiveInt,
  attemptId: RunAttemptId,
  rootNodeId: NodeId,
  appThread: OrchestrationV2AppThread,
  /** The run's provider thread. A null native ref means the harness has no session yet. */
  providerThread: OrchestrationV2ProviderThread,
  message: Schema.Struct({
    messageId: MessageId,
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
    createdBy: OrchestrationV2ConversationMessage.fields.createdBy,
    creationSource: OrchestrationV2ConversationMessage.fields.creationSource,
  }),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type RunnerTurn = typeof RunnerTurn.Type;

/** Something that happened on the machine, in the order it happened. */
export const RunnerItem = Schema.Union([
  /** The harness has the turn: its session and provider thread as loaded. */
  Schema.Struct({
    kind: Schema.Literal("turn.started"),
    runId: RunId,
    providerSession: OrchestrationV2ProviderSession,
    providerThread: OrchestrationV2ProviderThread,
  }),
  /** The turn never reached the harness. */
  Schema.Struct({
    kind: Schema.Literal("turn.failed"),
    runId: RunId,
    message: Schema.String,
  }),
  /**
   * The turn's files, saved: `start` is the thread's branch when the turn
   * began (null: nothing yet), `commit` the branch after the turn, before
   * `main` was merged in. Sent before the turn's `turn.terminal`.
   */
  Schema.Struct({
    kind: Schema.Literal("drive.checkpoint"),
    runId: RunId,
    start: Schema.NullOr(Oid),
    commit: Oid,
    files: Schema.Array(DriveFileChange),
  }),
  /** Something about the drive the thread's transcript should say, such as a merge conflict. */
  Schema.Struct({
    kind: Schema.Literal("drive.notice"),
    runId: RunId,
    message: Schema.String,
  }),
  /**
   * One event from the provider adapter (upstream's `ProviderAdapterV2Event`),
   * in its JSON encoding. Left opaque here so an adapter event this protocol
   * has never heard of still arrives; the thread decides what it means.
   */
  Schema.Struct({
    kind: Schema.Literal("provider"),
    runId: RunId,
    event: Schema.Record(Schema.String, Schema.Unknown),
  }),
]);
export type RunnerItem = typeof RunnerItem.Type;

export const RunnerHello = Schema.Struct({
  type: Schema.Literal("hello"),
  protocolVersion: PositiveInt,
  imageVersion: Schema.String,
  machineId: Schema.String,
  threadId: ThreadId,
  generation: PositiveInt,
  token: Schema.String,
  lastAckedSequence: NonNegativeInt,
});
export type RunnerHello = typeof RunnerHello.Type;

/** Runner to thread. */
export const RunnerMessage = Schema.Union([
  RunnerHello,
  Schema.Struct({
    type: Schema.Literal("batch"),
    /** Counts from 1 within a generation, with no gaps. */
    sequence: PositiveInt,
    items: Schema.Array(RunnerItem),
  }),
  Schema.Struct({ type: Schema.Literal("end"), reason: Schema.String }),
]);
export type RunnerMessage = typeof RunnerMessage.Type;

export const RunnerRefusal = Schema.Literals([
  "protocol_version",
  "unknown_thread",
  "stale_generation",
  "unknown_generation",
  "bad_token",
]);
export type RunnerRefusal = typeof RunnerRefusal.Type;

/** Thread to Runner. */
export const ThreadMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("welcome"),
    generation: PositiveInt,
    ackedSequence: NonNegativeInt,
    /** The run the thread considers live. The Runner stops any other turn it is still running. */
    activeRunId: Schema.NullOr(RunId),
  }),
  Schema.Struct({
    type: Schema.Literal("refused"),
    reason: RunnerRefusal,
    message: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("ack"), sequence: PositiveInt }),
  Schema.Struct({
    type: Schema.Literal("turn.start"),
    turn: RunnerTurn,
    /** The harness's credential at the ModelGateway, for this turn only. */
    modelToken: Schema.String,
    /** The drive the turn works in. Null when this cloud stores no drives. */
    drive: Schema.NullOr(DriveAccess),
  }),
  Schema.Struct({ type: Schema.Literal("interrupt"), runId: RunId }),
  Schema.Struct({ type: Schema.Literal("end"), reason: Schema.String }),
]);
export type ThreadMessage = typeof ThreadMessage.Type;

/**
 * What a thread asks a machine backend for: a Runner for this thread at this
 * generation, holding this token, whose harnesses reach their models through
 * `modelGatewayUrl`. Asking again for the same generation is a no-op; a higher
 * generation replaces the thread's older Runner.
 */
export const MachineEnsureRequest = Schema.Struct({
  threadId: ThreadId,
  generation: PositiveInt,
  token: Schema.String,
  modelGatewayUrl: Schema.String,
});

/** Where the gateway serves each provider's API, under its origin. */
export const MODEL_GATEWAY_PATHS = { anthropic: "/anthropic", openai: "/openai" } as const;
export type ModelGatewayProvider = keyof typeof MODEL_GATEWAY_PATHS;
export type MachineEnsureRequest = typeof MachineEnsureRequest.Type;

/**
 * What a VM's Runner runs: the file a machine backend writes onto a thread's
 * machine (`runner machine` reads it). A new generation in it replaces the
 * Runner; a different `image` restarts the machine's Runner on that image.
 */
export const RunnerMachineConfig = Schema.Struct({
  ...MachineEnsureRequest.fields,
  /** The cloud's origin the Runner dials, e.g. `https://app.signalbox.run`. */
  cloudUrl: Schema.String,
  /** The Runner image the machine should run. */
  image: Schema.String,
});
export type RunnerMachineConfig = typeof RunnerMachineConfig.Type;

export const runnerFrame = frameCodec(RunnerMessage);
export const threadFrame = frameCodec(ThreadMessage);
export const machineEnsureJson = frameCodec(MachineEnsureRequest);
export const machineConfigJson = frameCodec(RunnerMachineConfig);
