import {
  OrchestrationV2AppThread,
  OrchestrationV2Subagent,
  NonNegativeInt,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Schema from "effect/Schema";

import type {
  NativeChildBatchInput,
  NativeChildPending as NativeChildPendingType,
} from "../NativeChildProtocol.ts";
export type {
  NativeChildBatchInput,
  NativeChildBatchInputAppThread,
  NativeChildBatchResult,
  NativeChildPending,
  NativeChildPendingItem,
  ProviderRunnerItem,
} from "../NativeChildProtocol.ts";

const ProviderRunnerItemWire = Schema.Struct({
  kind: Schema.Literal("provider"),
  runId: RunId,
  event: Schema.Record(Schema.String, Schema.Unknown),
});

const NativeChildBatch = Schema.Struct({
  parentThreadId: ThreadId,
  parentRunId: RunId,
  childThreadId: ThreadId,
  generation: NonNegativeInt,
  sequence: NonNegativeInt,
  owner: Schema.Struct({
    userId: Schema.String,
    contextId: SignalboxContextId,
    driveId: Schema.NullOr(Schema.String),
  }),
  appThread: OrchestrationV2AppThread,
  attestation: OrchestrationV2Subagent,
  items: Schema.Array(ProviderRunnerItemWire),
});

const NativeChildPending = Schema.Struct({
  parentRunId: RunId,
  childThreadId: ThreadId,
  appThread: Schema.optionalKey(OrchestrationV2AppThread),
  createdByDriver: Schema.optionalKey(Schema.String),
  creationDecode: Schema.optionalKey(Schema.Boolean),
  invalidDriver: Schema.Boolean,
  materialized: Schema.Boolean,
  items: Schema.Array(ProviderRunnerItemWire),
});

const codec = Schema.toCodecJson(NativeChildBatch);
export const nativeChildBatchWire = {
  encode: Schema.encodeSync(codec) as (input: NativeChildBatchInput) => unknown,
  decode: Schema.decodeUnknownSync(codec) as (input: unknown) => NativeChildBatchInput,
};

const pendingCodec = Schema.fromJsonString(Schema.Array(Schema.toCodecJson(NativeChildPending)));
export const nativeChildPendingWire = {
  encode: Schema.encodeSync(pendingCodec) as (
    input: ReadonlyArray<NativeChildPendingType>,
  ) => string,
  decode: Schema.decodeUnknownSync(pendingCodec) as (
    input: string,
  ) => ReadonlyArray<NativeChildPendingType>,
};
