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
  ProviderSessionId,
  ProviderTurnId,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  RuntimeRequestId,
  RunAttemptId,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { jsonCodec as frameCodec } from "./jsonCodec.ts";
import { DriveAccess, DriveFileChange, Oid, SkippedFolder } from "./DriveProtocol.ts";
import { SecretsAccess } from "./SecretsProtocol.ts";
import { SessionAccess } from "./SessionProtocol.ts";

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
 * 3. The thread sends `turn.start`, `steer` and `interrupt`; the Runner streams
 *    sequenced `batch`es of what happened and the thread `ack`s each once its
 *    events are committed. A batch at or below the acknowledged sequence is a
 *    resend and changes nothing. Batches also carry the machine's usage and
 *    log lines for the turn's diagnostic record.
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
 * checkpoint. A drive backed by a remote repository fetches the remote's
 * default branch at turn start instead, and saves the turn without merging.
 *
 * Each turn also carries the thread's session token (`SessionProtocol.ts`):
 * the Runner streams the harness's own session rows to the thread as they are
 * written, restores them on a new machine before it resumes the harness, and
 * reports a message complete only once its rows are durable.
 *
 * The machine holds no provider keys. Its harnesses reach the models through
 * the ModelGateway named in `MachineEnsureRequest`, with the model token each
 * `turn.start` carries. That token works for that thread, provider and turn
 * only, and stops working when the turn ends.
 *
 * A turn in a folder that names 1Password Environments also carries the
 * owner's service account token for them (`SecretsProtocol.ts`): the Runner
 * reads the values as a harness session starts, and masks them in every
 * frame it sends.
 */

export const RUNNER_PROTOCOL_VERSION = 5;

/** Additive frames are gated by hello capabilities, so existing v5 Runners still connect. */
export const RunnerRuntimeResponse = Schema.Struct({
  runId: RunId,
  requestId: RuntimeRequestId,
  providerSessionId: ProviderSessionId,
  providerTurnId: ProviderTurnId,
  decision: Schema.optional(ProviderApprovalDecision),
  answers: Schema.optional(ProviderUserInputAnswers),
});
export type RunnerRuntimeResponse = typeof RunnerRuntimeResponse.Type;

export const RUNNER_HEARTBEAT_PING = "ping";
export const RUNNER_HEARTBEAT_PONG = "pong";

/** Where a Runner dials in, with `?threadId=`. The token travels in `hello`, never the URL. */
export const RUNNER_CONNECT_PATH = "/api/runner/connect";

/** A user message as the harness gets it: a turn's request, or a steer into a running turn. */
export const RunnerMessageInput = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  createdBy: OrchestrationV2ConversationMessage.fields.createdBy,
  creationSource: OrchestrationV2ConversationMessage.fields.creationSource,
});
export type RunnerMessageInput = typeof RunnerMessageInput.Type;

/** One turn the thread hands to the Runner. Everything the adapter's `startTurn` needs. */
export const RunnerTurn = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  /** The turn's trace id (32 hex), on everything the Runner logs about it. */
  traceId: Schema.String,
  runOrdinal: PositiveInt,
  providerTurnOrdinal: PositiveInt,
  attemptId: RunAttemptId,
  rootNodeId: NodeId,
  appThread: OrchestrationV2AppThread,
  /** The run's provider thread. A null native ref means the harness has no session yet. */
  providerThread: OrchestrationV2ProviderThread,
  message: RunnerMessageInput,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  /**
   * Set when this run continues one its machine was lost under: the harness
   * resumes its restored session and carries on, rather than taking `message`
   * as a new request where the adapter can (Codex continues natively).
   */
  restartContinuationOfRunId: Schema.optional(RunId),
  /**
   * `message`'s text for a new harness session: the conversation so far, then
   * the message. Set on a turn that resumes a session natively, so a Runner
   * whose resume fails starts fresh on it (`onFreshSession`) rather than with
   * no conversation (#653).
   */
  freshSessionText: Schema.optional(Schema.String),
});
export type RunnerTurn = typeof RunnerTurn.Type;

/**
 * `turn` on a new harness session whose prompt is `text`: it counts from 1,
 * resumes nothing, and has nothing to continue, so the harness takes the
 * prompt as the request.
 */
export const onFreshSession = <T extends Omit<RunnerTurn, "traceId">>(turn: T, text: string) => {
  const { restartContinuationOfRunId: _continued, freshSessionText: _fresh, ...rest } = turn;
  return {
    ...rest,
    providerTurnOrdinal: 1,
    providerThread: { ...turn.providerThread, nativeThreadRef: null },
    message: { ...turn.message, text },
  };
};

/**
 * What the machine used since this Runner session began, measured from the
 * cgroup of the Runner's container (`cpu.stat`, `memory.current`,
 * `memory.peak`), the disk holding the machine's home, and the machine's
 * network interfaces. Null where the machine cannot measure it, such as a
 * developer's own Mac. Counters only grow within a session.
 */
export const MachineUsage = Schema.Struct({
  cpuSeconds: Schema.NullOr(Schema.Number),
  memoryBytes: Schema.NullOr(Schema.Number),
  memoryPeakBytes: Schema.NullOr(Schema.Number),
  /** The mean of the session's memory samples. */
  memoryAverageBytes: Schema.NullOr(Schema.Number),
  diskUsedBytes: Schema.NullOr(Schema.Number),
  egressBytes: Schema.NullOr(Schema.Number),
});
export type MachineUsage = typeof MachineUsage.Type;

export const RunnerLogLevel = Schema.Literals(["info", "warning", "error"]);
export type RunnerLogLevel = typeof RunnerLogLevel.Type;

/** What the Runner is built from, so a turn's diagnostics name the exact software it ran on. */
export const RunnerBuild = Schema.Struct({
  /** The image's content digest (`…@sha256:…`), when the machine knows it. */
  imageDigest: Schema.NullOr(Schema.String),
  /** The git revision the Runner was built from. */
  revision: Schema.NullOr(Schema.String),
  /** Each harness CLI's own `--version` output, by command (`claude`, `codex`). */
  cliVersions: Schema.Record(Schema.String, Schema.String),
});
export type RunnerBuild = typeof RunnerBuild.Type;

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
    /** What the thread's machine state leaves out, and how each comes back (#490). */
    skipped: Schema.optional(Schema.Array(SkippedFolder)),
  }),
  /** Something about the drive the thread's transcript should say, such as a merge conflict. */
  Schema.Struct({
    kind: Schema.Literal("drive.notice"),
    runId: RunId,
    message: Schema.String,
  }),
  /**
   * The harness's session could not be saved, so the Runner stopped the turn
   * rather than go on with rows that would be lost with the machine.
   */
  Schema.Struct({
    kind: Schema.Literal("session.notice"),
    runId: RunId,
    message: Schema.String,
  }),
  /** The folder's secrets could not all be loaded: the turn runs without the ones missing. */
  Schema.Struct({
    kind: Schema.Literal("secrets.notice"),
    runId: RunId,
    message: Schema.String,
  }),
  /**
   * The light machine cannot do what the turn needs (a build, or it ran out of
   * memory): the Runner saved the turn's files and session as of now and does
   * nothing more for it, and the thread continues the run on a heavy machine.
   * Only a Runner on a light machine sends it.
   */
  Schema.Struct({
    kind: Schema.Literal("machine.outgrown"),
    runId: RunId,
    reason: Schema.String,
  }),
  /**
   * The answer to `drain` `id` (#493): the Runner saved everything the
   * machine wrote, as far as it could. `unsaved` says why anything wasn't, in
   * the thread's terms. Once the thread has it, the machine can go.
   */
  Schema.Struct({
    kind: Schema.Literal("machine.drained"),
    id: NonNegativeInt,
    unsaved: Schema.Array(Schema.String),
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
  /**
   * The machine's usage so far, sent when a turn starts and ends and every
   * half minute. `runId` is the turn running at that moment, if any.
   */
  Schema.Struct({
    kind: Schema.Literal("usage"),
    runId: Schema.NullOr(RunId),
    usage: MachineUsage,
  }),
  /**
   * A line for the turn's diagnostic record: what went wrong on the machine,
   * bounded and with credentials redacted. `runId` is the turn it is about, if any.
   */
  Schema.Struct({
    kind: Schema.Literal("log"),
    runId: Schema.NullOr(RunId),
    level: RunnerLogLevel,
    message: Schema.String,
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
  /** Absent from Runners built before diagnostics. */
  build: Schema.optional(RunnerBuild),
  /** The Runner answers `drain` (#493). Absent: an older one, let go without asking. */
  drains: Schema.optional(Schema.Boolean),
  /**
   * Every run this Runner process was handed. A run the thread saw start that
   * is missing went with an earlier process on the same machine (#613).
   * Absent from Runners built before it: the thread can't tell.
   */
  takenRunIds: Schema.optional(Schema.Array(RunId)),
  /** The Runner takes `steer` (#562). Absent: an older one, which closes on frames it can't read. */
  steers: Schema.optional(Schema.Boolean),
  /** Takes `runtime-request.respond`; absent on older v5 Runners. */
  runtimeRequestResponses: Schema.optional(Schema.Boolean),
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
    /** Where the harness's session rows go. */
    sessions: SessionAccess,
    /** The secrets of the thread's folders. Absent: none, or a cloud older than this field. */
    secrets: Schema.optionalKey(SecretsAccess),
  }),
  Schema.Struct({ type: Schema.Literal("interrupt"), runId: RunId }),
  /**
   * A message the person sent into `runId` while it runs (#562). Sent again on
   * each reconnect while the run is live; the Runner takes each message once.
   * Only to a Runner whose `hello` said it `steers`.
   */
  Schema.Struct({ type: Schema.Literal("steer"), runId: RunId, message: RunnerMessageInput }),
  /** Replayed from committed runtime requests on reconnect; never sent to an older Runner. */
  Schema.Struct({
    type: Schema.Literal("runtime-request.respond"),
    response: RunnerRuntimeResponse,
  }),
  /**
   * The thread is about to let the machine go (#493): save everything it
   * wrote, then answer `machine.drained` with this `id`. Its tokens hold until
   * then. Sent again on each reconnect until answered; only to a Runner whose
   * `hello` said it `drains`.
   */
  Schema.Struct({ type: Schema.Literal("drain"), id: NonNegativeInt }),
  Schema.Struct({ type: Schema.Literal("end"), reason: Schema.String }),
]);
export type ThreadMessage = typeof ThreadMessage.Type;

/**
 * A thread's machine size (#113): `light` runs the harness and its subagents
 * editing files, `heavy` builds, tests and runs dev servers. A light machine's
 * Runner moves its turn up (`machine.outgrown`) when the turn needs more.
 */
export const MachineClass = Schema.Literals(["light", "heavy"]);
export type MachineClass = typeof MachineClass.Type;

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
  /** The machine's class for this generation. Absent: heavy. */
  machineClass: Schema.optional(MachineClass),
});

/** Where the gateway serves each provider's API, under its origin. */
export const MODEL_GATEWAY_PATHS = { anthropic: "/anthropic", openai: "/openai" } as const;
export type ModelGatewayProvider = keyof typeof MODEL_GATEWAY_PATHS;
export type MachineEnsureRequest = typeof MachineEnsureRequest.Type;

/**
 * Where the Runner keeps threads' working directories and machine state
 * (`workspaces/<thread>/drive`, `machines/<thread>/home`) on every machine
 * class. A thread moves between classes mid-run, and its agent must find its
 * checkout, home and folder instructions at the paths it already knows
 * (#620). The Runner image creates it; a boat VM mounts its disk there.
 */
export const MACHINE_HOME = "/home/user/signalbox";

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
