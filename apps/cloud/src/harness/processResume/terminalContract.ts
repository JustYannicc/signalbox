import type { HarnessDurableStateCheckpointResult } from "../HarnessDurableState.ts";
import type { HarnessProcessPlacementIdentity } from "../processPlacement/contracts.ts";
import type { HarnessRequestFinish, HarnessRequestOffer } from "../HarnessRunStore.ts";
import type {
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorPublisher,
} from "../HarnessThreadSupervisor.ts";
import type { HarnessProcessResumePlacementPin } from "./durableState.ts";

export interface HarnessProcessResumePreDrainSnapshot {
  readonly lifecycle: string;
  readonly admittedStepId: string | null;
  readonly checkpoint: { readonly checkpointId: string; readonly manifestSha256: string };
  readonly nativeSessionId: string;
  readonly generation: number;
  readonly facetNonce: string;
  readonly controlEpoch: number;
  readonly controlIncarnationId: string;
}
export interface ProcessTerminalEvidence {
  readonly version: 1;
  readonly runId: string;
  readonly processId: string;
  readonly processOperationId: string;
  readonly request: HarnessRequestOffer;
  readonly nativeSessionId: string;
  readonly control: HarnessThreadSupervisorControlClaim;
  readonly publisher: HarnessThreadSupervisorPublisher;
  readonly placement: HarnessProcessResumePlacementPin;
  readonly identity: HarnessProcessPlacementIdentity;
  readonly finish: HarnessRequestFinish;
  readonly completion: Extract<HarnessDurableStateCheckpointResult, { status: "committed" }>;
  readonly acknowledgementId: string;
  readonly stopped: true;
  readonly joined: { readonly invocationRpc: true; readonly fetch: true; readonly ports: true };
}
export const terminalKey = (runId: string, processOperationId: string, requestId: string) =>
  `harness-process-terminal/v1/${encodeURIComponent(runId)}/${encodeURIComponent(processOperationId)}/${encodeURIComponent(requestId)}`;
