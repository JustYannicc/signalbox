import type { ClaudeSdkRequest } from "./ClaudeSdkIo.ts";
import {
  CheckpointId,
  ModelSelection,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  ProviderApprovalDecision,
  ProviderSessionId,
  ProviderTurnId,
  ProviderUserInputAnswers,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderContinuationCompletion,
  ProviderContinuationObservation,
  OrchestrationV2Notification,
  MessageId,
} from "@t3tools/contracts";
import {
  ProviderAdapterV2Error,
  ProviderAdapterV2RuntimePolicy,
  ProviderAdapterV2TurnMessage,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";
import { HarnessError } from "./Harness.ts";
import type { ClaudeNativeOpenInput } from "./ClaudeNativeAdapter.ts";
import type { ClaudeModelCatalog } from "@signalbox/provider-claude/ClaudeModelCatalog";
import type { NodeRuntimeIdentity } from "../isolate/NodeProcess.ts";
import type { KernelExitStatus } from "../kernel/KernelProcessTable.ts";
import type { SdkSpawnOptions } from "./claude/SdkTypes.ts";
import type { ClaudeSpawnDiagnostic } from "./ClaudeSpawnContext.ts";
import type { HarnessTurnStage } from "./HarnessTurnProgress.ts";
import type {
  ReleaseModuleOmittedEvent,
  ReleaseModuleOmittedFailure,
} from "./HarnessProcessLifetime.ts";
import type { ClaudeToolHookInput } from "./ClaudeToolObservation.ts";

export function claudeRpcCodec<
  S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
>(schema: S) {
  const codec = Schema.toCodecJson(schema);
  return { encode: Schema.encodeSync(codec), decode: Schema.decodeUnknownSync(codec) };
}

const snapshot = Schema.Struct({
  providerThread: OrchestrationV2ProviderThread,
  providerTurns: Schema.Array(OrchestrationV2ProviderTurn),
  messages: Schema.Array(OrchestrationV2ConversationMessage),
  runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequest),
  providerPayload: Schema.optionalKey(Schema.Unknown),
});
const release = Schema.Struct({
  harness: Schema.Literals(["claude-code", "codex"]),
  version: Schema.String,
  manifestSha256: Schema.String,
  modules: Schema.Record(
    Schema.String,
    Schema.Struct({ bytes: Schema.Number, sha256: Schema.String }),
  ),
});
const session = Schema.Struct({
  threadId: ThreadId,
  providerSessionId: ProviderSessionId,
  modelSelection: ModelSelection,
  runtimePolicy: ProviderAdapterV2RuntimePolicy,
  resumeFromSession: Schema.optionalKey(OrchestrationV2ProviderSession),
  initialNativeThreadId: Schema.optionalKey(Schema.String),
  initialProviderItemIdentityVersion: Schema.optionalKey(Schema.Literal(2)),
});
export const claudeSdkOpenCodec = claudeRpcCodec(
  Schema.Struct({
    release,
    session,
    creation: Schema.optionalKey(Schema.Struct({ providerThread: OrchestrationV2ProviderThread })),
    checkpoint: Schema.optionalKey(
      Schema.Struct({
        release,
        providerSession: OrchestrationV2ProviderSession,
        snapshot,
        revision: Schema.Struct({ commit: Schema.String }),
      }),
    ),
  }),
);
export type ClaudeSdkOpenInput = Omit<ClaudeNativeOpenInput, "modelTransport">;

const ensureThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optionalKey(Schema.String),
  modelSelection: ModelSelection,
  runtimePolicy: ProviderAdapterV2RuntimePolicy,
  providerSessionId: Schema.optionalKey(ProviderSessionId),
  existingProviderThread: Schema.optionalKey(OrchestrationV2ProviderThread),
});
const resumeThread = Schema.Struct({
  providerThread: OrchestrationV2ProviderThread,
  threadId: Schema.optionalKey(ThreadId),
  modelSelection: Schema.optionalKey(ModelSelection),
  runtimePolicy: Schema.optionalKey(ProviderAdapterV2RuntimePolicy),
});
const turn = Schema.Struct({
  appThread: OrchestrationV2AppThread,
  threadId: ThreadId,
  runId: RunId,
  runOrdinal: Schema.Number,
  nativeThreadHasTurns: Schema.optionalKey(Schema.Boolean),
  providerTurnOrdinal: Schema.Number,
  restartContinuationOfRunId: Schema.optionalKey(RunId),
  attemptId: RunAttemptId,
  rootNodeId: NodeId,
  providerThread: OrchestrationV2ProviderThread,
  message: ProviderAdapterV2TurnMessage,
  modelSelection: ModelSelection,
  runtimePolicy: ProviderAdapterV2RuntimePolicy,
  appContext: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, text: Schema.String })),
  ),
});
const nativeLoad = Schema.Union([
  Schema.Struct({ method: Schema.Literal("ensureThread"), input: ensureThread }),
  Schema.Struct({ method: Schema.Literal("resumeThread"), input: resumeThread }),
]);
const method = <
  I extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
  O extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
>(
  input: I,
  output: O,
) => ({ input: claudeRpcCodec(input), output: claudeRpcCodec(output) });
const threadInput = Schema.Struct({ providerThread: OrchestrationV2ProviderThread });

export const claudeSdkMethods = {
  ensureThread: method(ensureThread, OrchestrationV2ProviderThread),
  resumeThread: method(resumeThread, OrchestrationV2ProviderThread),
  startTurn: method(turn, Schema.Void),
  compactThread: method(turn, Schema.Void),
  steerTurn: method(
    Schema.Struct({
      threadId: ThreadId,
      runId: RunId,
      providerThread: OrchestrationV2ProviderThread,
      providerTurnId: ProviderTurnId,
      message: ProviderAdapterV2TurnMessage,
    }),
    Schema.Void,
  ),
  interruptTurn: method(
    Schema.Struct({
      providerThread: OrchestrationV2ProviderThread,
      providerTurnId: ProviderTurnId,
      requestRuntimeRestart: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Void,
  ),
  stopTask: method(
    Schema.Struct({ providerThread: OrchestrationV2ProviderThread, taskId: Schema.String }),
    Schema.Void,
  ),
  stopSubagent: method(
    Schema.Struct({
      providerThread: OrchestrationV2ProviderThread,
      nativeTaskId: Schema.String,
      requestedAt: Schema.optionalKey(Schema.DateTimeUtc),
    }),
    Schema.Union([
      Schema.Void,
      Schema.Struct({
        status: Schema.Literals(["completed", "failed", "cancelled"]),
        completedAt: Schema.DateTimeUtc,
        result: OrchestrationV2Subagent.fields.result,
      }),
    ]),
  ),
  respondToRuntimeRequest: method(
    Schema.Struct({
      requestId: RuntimeRequestId,
      decision: Schema.optionalKey(ProviderApprovalDecision),
      answers: Schema.optionalKey(ProviderUserInputAnswers),
      response: Schema.optionalKey(Schema.Unknown),
    }),
    Schema.Void,
  ),
  readThreadSnapshot: method(threadInput, snapshot),
  rollbackThread: method(
    Schema.Struct({
      providerThread: OrchestrationV2ProviderThread,
      target: Schema.Union([
        Schema.Struct({
          type: Schema.Literal("thread_start"),
          checkpointId: CheckpointId,
          appRunOrdinal: Schema.Literal(0),
        }),
        Schema.Struct({
          type: Schema.Literal("provider_turn"),
          checkpointId: CheckpointId,
          appRunOrdinal: Schema.Number,
          providerTurn: OrchestrationV2ProviderTurn,
        }),
      ]),
      providerThreadTurns: Schema.Array(OrchestrationV2ProviderTurn),
    }),
    snapshot,
  ),
  forkThread: method(
    Schema.Struct({
      sourceProviderThread: OrchestrationV2ProviderThread,
      targetThreadId: ThreadId,
      ownerNodeId: Schema.optionalKey(NodeId),
      providerTurnId: Schema.optionalKey(ProviderTurnId),
      sourceProviderTurns: Schema.optionalKey(Schema.Array(OrchestrationV2ProviderTurn)),
      modelSelection: Schema.optionalKey(ModelSelection),
      runtimePolicy: Schema.optionalKey(ProviderAdapterV2RuntimePolicy),
    }),
    OrchestrationV2ProviderThread,
  ),
  hasPendingBackgroundWork: method(Schema.Void, Schema.Boolean),
  hasPendingBackgroundWorkForThread: method(OrchestrationV2ProviderThread, Schema.Boolean),
  configureMcp: method(
    Schema.Struct({
      configuration: Schema.Struct({
        epoch: Schema.Number,
        servers: Schema.Record(Schema.String, Schema.Struct({ url: Schema.String })),
      }),
      load: nativeLoad,
    }),
    Schema.Void,
  ),
} as const;
export type ClaudeSdkMethod = keyof typeof claudeSdkMethods;
export const claudeSdkErrorCodec = claudeRpcCodec(
  Schema.Union([HarnessError, ProviderAdapterV2Error]),
);
export const claudeSdkSessionCodec = claudeRpcCodec(OrchestrationV2ProviderSession);
export const claudeSdkContinuationCodec = claudeRpcCodec(
  Schema.Struct({
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    driver: ProviderDriverKind,
    detail: Schema.NullOr(Schema.String),
    completions: Schema.optionalKey(Schema.NonEmptyArray(ProviderContinuationCompletion)),
    observations: Schema.optionalKey(Schema.NonEmptyArray(ProviderContinuationObservation)),
    notification: Schema.optionalKey(OrchestrationV2Notification),
    delegatedCompletion: Schema.optionalKey(
      Schema.Struct({ parentRunId: RunId, generation: Schema.Number, messageId: MessageId }),
    ),
    delivery: Schema.optionalKey(Schema.Literals(["adapter_buffered", "message_text"])),
    messageId: Schema.optionalKey(MessageId),
  }),
);
export type ClaudeSdkReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

export interface ClaudeSdkProcessContext {
  readonly identity: NodeRuntimeIdentity;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly mcpOrigin: string;
}
export type ClaudeCliLaunch = Omit<SdkSpawnOptions, "signal"> & { readonly manifestSha256: string };
export type ClaudeSdkReport =
  | { readonly type: "milestone"; readonly stage: HarnessTurnStage }
  | { readonly type: "spawn"; readonly context: ClaudeSpawnDiagnostic }
  | {
      readonly type: "omission";
      readonly event: ReleaseModuleOmittedEvent;
      readonly failure: ReleaseModuleOmittedFailure;
    };

export interface ClaudeCliProcessPort {
  readonly streams: () => Promise<{
    readonly stdin: WritableStream<Uint8Array>;
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
  }>;
  readonly launch: (request: ClaudeCliLaunch) => Promise<void>;
  readonly exited: () => Promise<KernelExitStatus>;
  readonly assertCompatibility: () => Promise<void>;
  readonly signal: (reason: unknown, signal: 9 | 15) => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly report: (report: ClaudeSdkReport) => Promise<void>;
  readonly model: (id: string, request: ClaudeSdkRequest) => Promise<Response>;
  readonly cancelIo: (id: string, reason: unknown) => Promise<void>;
  readonly observeTool: (
    input: ClaudeToolHookInput,
    toolUseId: string | undefined,
  ) => Promise<void>;
  readonly fs: (
    id: string,
    operation: string,
    args: ReadonlyArray<unknown>,
  ) => Promise<ClaudeSdkFsReply>;
  readonly continuation: (request: unknown) => Promise<void>;
}
export type ClaudeSdkFsReply =
  | { readonly kind: "value"; readonly value: unknown }
  | {
      readonly kind: "metadata";
      readonly value: Readonly<Record<string, unknown>>;
      readonly types: Readonly<Record<string, boolean>>;
    }
  | { readonly kind: "entries"; readonly entries: readonly ClaudeSdkFsReply[] }
  | {
      readonly kind: "handle";
      readonly id: number;
      readonly fd: number;
      readonly directory: boolean;
    }
  | { readonly kind: "error"; readonly fields: Readonly<Record<string, unknown>> };
export interface ClaudeSdkSessionPort {
  readonly describe: () => Promise<{
    readonly providerSession: unknown;
    readonly modelCatalog: ClaudeModelCatalog;
  }>;
  readonly events: () => Promise<ReadableStream<Uint8Array>>;
  readonly execute: (
    id: string,
    method: ClaudeSdkMethod,
    input: unknown,
  ) => Promise<ClaudeSdkReply>;
  readonly cancel: (id: string, reason: unknown) => Promise<void>;
  readonly dispose: () => Promise<void>;
}
export interface ClaudeSdkHostService {
  readonly open: (
    input: unknown,
    context: ClaudeSdkProcessContext,
    process: ClaudeCliProcessPort,
  ) => Promise<ClaudeSdkSessionPort>;
}
