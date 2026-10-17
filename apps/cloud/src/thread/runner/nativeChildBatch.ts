import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  OrchestrationV2AppThread,
  OrchestrationV2Subagent,
  NonNegativeInt,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Schema from "effect/Schema";

import type { ThreadOwner } from "../ThreadStore.ts";

export type ProviderRunnerItem = Extract<RunnerItem, { readonly kind: "provider" }>;

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

export interface NativeChildBatchInput {
  readonly parentThreadId: ThreadId;
  readonly parentRunId: RunId;
  readonly childThreadId: ThreadId;
  readonly generation: number;
  readonly sequence: number;
  readonly owner: ThreadOwner;
  /** Present on the batch that first introduces the child to the parent Runner. */
  readonly appThread: NativeChildBatchInputAppThread;
  readonly attestation: typeof OrchestrationV2Subagent.Type;
  readonly items: ReadonlyArray<ProviderRunnerItem>;
}

/** A refusal crosses the Durable Object boundary as data; storage failures still reject the RPC. */
export type NativeChildBatchResult =
  | { readonly _tag: "saved" }
  | { readonly _tag: "child_mismatch" };

export type NativeChildPending = typeof NativeChildPending.Type;

export type NativeChildBatchInputAppThread = typeof OrchestrationV2AppThread.Type;

const codec = Schema.toCodecJson(NativeChildBatch);
export const nativeChildBatchWire = {
  encode: Schema.encodeSync(codec) as (input: NativeChildBatchInput) => unknown,
  decode: Schema.decodeUnknownSync(codec) as (input: unknown) => NativeChildBatchInput,
};

const pendingCodec = Schema.fromJsonString(Schema.Array(Schema.toCodecJson(NativeChildPending)));
export const nativeChildPendingWire = {
  encode: Schema.encodeSync(pendingCodec) as (input: ReadonlyArray<NativeChildPending>) => string,
  decode: Schema.decodeUnknownSync(pendingCodec) as (
    input: string,
  ) => ReadonlyArray<NativeChildPending>,
};
