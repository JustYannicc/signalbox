import type { HarnessRunStoreCommand, HarnessRunStoreResult } from "../HarnessRunStore.ts";
import type { HarnessFilesStoreObject } from "../HarnessFilesStoreObject.ts";
import type {
  HarnessFilesCheckpoint,
  HarnessFilesPublication,
  HarnessFilesStoreCommand,
  HarnessFilesStoreResult,
} from "../HarnessFilesStore.ts";
import type { HarnessRunStoreObject } from "../HarnessRunStoreObject.ts";
import type { HarnessThreadSupervisorObject } from "../HarnessThreadSupervisorObject.ts";
import type {
  HarnessThreadSupervisorCommand,
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorPublisher,
  HarnessThreadSupervisorResult,
} from "../HarnessThreadSupervisor.ts";

export type HarnessRunInitialization = Extract<
  HarnessRunStoreCommand,
  { readonly type: "initialize" }
>;
export type HarnessSupervisorPrivateCommand = Exclude<
  HarnessThreadSupervisorCommand,
  {
    readonly type:
      | "initialize"
      | "beginDrain"
      | "confirmControlSync"
      | "admitStep"
      | "commitCheckpoint"
      | "publishFreshFacet"
      | "recordActivation"
      | "recordActivationFailure"
      | "recordPreparedFacetFailure"
      | "reconcile";
  }
>;
export type HarnessFilesPrivateCommand = Extract<
  HarnessFilesStoreCommand,
  { readonly type: "readCheckpoint" | "recoverCheckpoint" }
>;

export interface HarnessRunStoreClient {
  execute(command: HarnessRunStoreCommand): Promise<HarnessRunStoreResult>;
}

export interface HarnessFilesStoreClient {
  execute(command: HarnessFilesPrivateCommand): Promise<HarnessFilesStoreResult>;
}

export interface HarnessThreadSupervisorClient {
  execute(command: HarnessSupervisorPrivateCommand): Promise<HarnessThreadSupervisorResult>;
}

export interface HarnessDurableStateBindings {
  readonly HARNESS_RUN_STORE: DurableObjectNamespace<HarnessRunStoreObject>;
  readonly HARNESS_FILES_STORE: DurableObjectNamespace<HarnessFilesStoreObject>;
  readonly HARNESS_THREAD_SUPERVISOR: DurableObjectNamespace<HarnessThreadSupervisorObject>;
}

export interface HarnessDurableStateStubs {
  readonly runId: string;
  readonly runStore: HarnessRunStoreClient;
  readonly filesStore: { execute(command: unknown): Promise<HarnessFilesStoreResult> };
  readonly threadSupervisor: {
    execute(command: unknown): Promise<HarnessThreadSupervisorResult>;
  };
}

export interface HarnessDurableStateInitializationInput {
  readonly run: HarnessRunInitialization;
  readonly nativeSessionId: string;
  readonly control: HarnessThreadSupervisorControlClaim;
  readonly publisher: HarnessThreadSupervisorPublisher;
  readonly checkpoint: HarnessFilesCheckpoint;
}

export interface HarnessDurableStateInitializationResult {
  readonly journal: HarnessRunStoreResult;
  readonly files: HarnessFilesStoreResult;
  readonly supervisor: HarnessThreadSupervisorResult;
}

export interface HarnessDurableStateDrainInput {
  readonly control: HarnessThreadSupervisorControlClaim;
  readonly publisher: HarnessThreadSupervisorPublisher;
  readonly expectedGeneration: number;
  readonly operationId: string;
  readonly nextControl: HarnessThreadSupervisorControlClaim;
}

export type HarnessDurableStateDrainResult =
  | {
      readonly status: "draining";
      readonly supervisor: HarnessThreadSupervisorResult;
      readonly files: HarnessFilesStoreResult;
    }
  | {
      readonly status: "files-pending";
      readonly supervisor: HarnessThreadSupervisorResult;
      readonly failure: { readonly code: string; readonly message: string };
    };

export interface HarnessDurableStatePublicationInput {
  readonly control: HarnessThreadSupervisorControlClaim;
  readonly operationId: string;
  readonly verifiedNativeSessionId: string;
  readonly checkpoint: { readonly checkpointId: string; readonly manifestSha256: string };
}

export type HarnessDurableStatePublicationResult =
  | {
      readonly status: "published";
      readonly control: HarnessThreadSupervisorControlClaim;
      readonly supervisor: HarnessThreadSupervisorResult;
      readonly files: HarnessFilesStoreResult;
      readonly receipt: HarnessFilesPublication;
    }
  | {
      readonly status: "supervisor-pending";
      readonly files: HarnessFilesStoreResult;
      readonly receipt: HarnessFilesPublication;
      readonly failure: { readonly code: string; readonly message: string };
    }
  | {
      readonly status: "files-pending";
      readonly supervisor: HarnessThreadSupervisorResult | null;
      readonly receipt: HarnessFilesPublication | null;
      readonly failure: { readonly code: string; readonly message: string };
      readonly activationFailureRecorded: boolean;
    };

export interface HarnessDurableStateActivationInput {
  readonly control: HarnessThreadSupervisorControlClaim;
  readonly operationId: string;
}

export type HarnessDurableStateActivationResult =
  | {
      readonly status: "accepting";
      readonly files: HarnessFilesStoreResult;
      readonly supervisor: HarnessThreadSupervisorResult;
    }
  | {
      readonly status: "files-pending";
      readonly supervisor: HarnessThreadSupervisorResult;
      readonly failure: { readonly code: string; readonly message: string };
    };

export interface HarnessDurableStateStepInput {
  readonly control: HarnessThreadSupervisorControlClaim;
  readonly stepId: string;
  readonly expectedCheckpointId: string;
}

export type HarnessDurableStateStepResult =
  | {
      readonly status: "admitted";
      readonly supervisor: HarnessThreadSupervisorResult;
      readonly files: HarnessFilesStoreResult;
    }
  | {
      readonly status: "files-pending";
      readonly supervisor: HarnessThreadSupervisorResult;
      readonly failure: { readonly code: string; readonly message: string };
    };

export interface HarnessDurableStateCheckpointInput {
  readonly publisher: HarnessThreadSupervisorPublisher;
  readonly stepId: string;
  readonly expectedCheckpointId: string;
  readonly checkpoint: HarnessFilesCheckpoint;
}

export type HarnessDurableStateCheckpointResult =
  | {
      readonly status: "committed";
      readonly files: HarnessFilesStoreResult;
      readonly supervisor: HarnessThreadSupervisorResult;
    }
  | {
      readonly status: "supervisor-pending";
      readonly files: HarnessFilesStoreResult;
      readonly failure: { readonly code: string; readonly message: string };
    };

export interface HarnessDurableStateFailureInput {
  readonly control: HarnessThreadSupervisorControlClaim;
  readonly operationId: string;
  readonly phase: "prepare" | "publish";
  readonly failure: { readonly kind: string; readonly message: string };
  readonly cleanup: {
    readonly stopAcknowledged: boolean;
    readonly invocationRpcJoined: boolean;
    readonly fetchJoined: boolean;
    readonly callbackPortsJoined: boolean;
    readonly disposed: boolean;
  };
}

export interface HarnessDurableStateInvocationSettlementEvidence {
  readonly invocationRpcJoined: boolean;
  readonly fetchJoined: boolean;
  readonly callbackPortsJoined: boolean;
}

export interface HarnessDurableStateReconcileInput {
  readonly control: HarnessThreadSupervisorControlClaim;
  readonly expectedGeneration: number;
  readonly evidenceId: string;
  readonly outcome: "notApplied" | "completed" | "unknown";
  readonly checkpoint: HarnessDurableStatePublicationInput["checkpoint"] | null;
  /** Joins for the old invocation. These do not attest cleanup of a prepared facet. */
  readonly invocationSettlement: HarnessDurableStateInvocationSettlementEvidence | null;
  /** Cleanup for the prepared facet, when one is retained. */
  readonly preparedFacetCleanup: HarnessDurableStateFailureInput["cleanup"] | null;
}

export interface HarnessDurableStateReconcileResult {
  readonly supervisor: HarnessThreadSupervisorResult;
  readonly files: HarnessFilesStoreResult | null;
}

export interface HarnessDurableState {
  /** The existing journal authority. The supervisor store adds no run history. */
  readonly runStore: HarnessRunStoreClient;
  readonly filesStore: HarnessFilesStoreClient;
  readonly threadSupervisor: HarnessThreadSupervisorClient;
  initialize(
    input: HarnessDurableStateInitializationInput,
  ): Promise<HarnessDurableStateInitializationResult>;
  beginDrain(input: HarnessDurableStateDrainInput): Promise<HarnessDurableStateDrainResult>;
  admitStep(input: HarnessDurableStateStepInput): Promise<HarnessDurableStateStepResult>;
  commitCheckpoint(
    input: HarnessDurableStateCheckpointInput,
  ): Promise<HarnessDurableStateCheckpointResult>;
  publishFreshFacet(
    input: HarnessDurableStatePublicationInput,
  ): Promise<HarnessDurableStatePublicationResult>;
  recordActivation(
    input: HarnessDurableStateActivationInput,
  ): Promise<HarnessDurableStateActivationResult>;
  recordActivationFailure(input: {
    readonly control: HarnessThreadSupervisorControlClaim;
    readonly operationId: string;
    readonly failure: { readonly kind: string; readonly message: string };
  }): Promise<HarnessThreadSupervisorResult>;
  recordPreparedFacetFailure(
    input: HarnessDurableStateFailureInput,
  ): Promise<HarnessThreadSupervisorResult>;
  reconcile(input: HarnessDurableStateReconcileInput): Promise<HarnessDurableStateReconcileResult>;
  readPublication(input: {
    readonly control: HarnessThreadSupervisorControlClaim;
    readonly operationId: string;
  }): Promise<HarnessFilesStoreResult>;
}
