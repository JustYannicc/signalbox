import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import type {
  OrchestrationV2AppThread,
  OrchestrationV2Subagent,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

import type { ThreadOwner } from "./ThreadOwner.ts";

export type ProviderRunnerItem = Extract<RunnerItem, { readonly kind: "provider" }>;

export type NativeChildBatchInputAppThread = typeof OrchestrationV2AppThread.Type;

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

export interface NativeChildPendingItem {
  readonly kind: "provider";
  readonly runId: RunId;
  readonly event: Record<string, unknown>;
}

export interface NativeChildPending {
  readonly parentRunId: RunId;
  readonly childThreadId: ThreadId;
  readonly appThread?: typeof OrchestrationV2AppThread.Type;
  readonly createdByDriver?: string;
  readonly creationDecode?: boolean;
  readonly invalidDriver: boolean;
  readonly materialized: boolean;
  readonly items: ReadonlyArray<NativeChildPendingItem>;
}
