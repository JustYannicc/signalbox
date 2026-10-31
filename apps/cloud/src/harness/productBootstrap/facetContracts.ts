import type { HarnessProcessCreationFacetEnvironment } from "../processPlacement/executionEnvironment.ts";
import type { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { HarnessReleaseArtifact } from "../../harnessReleases/HarnessReleaseLedger.ts";
import type { HarnessCProductBootstrapEnvironment } from "./contracts.ts";
import type {
  HarnessCProductCapabilityEnvironment,
  HarnessProcessExecutionResumeFacetEnvironment,
} from "../HarnessProcessPlacement.ts";
import type {
  HarnessCProductBootstrapDescriptor,
  HarnessCProductProvider,
  HarnessCProductRestoreMode,
  HarnessProcessResumePreparedRelease,
} from "../HarnessProcessResume.ts";
import type { HarnessFilesCheckpoint, HarnessFilesStoreResult } from "../HarnessFilesStore.ts";
import type {
  HarnessFacetRequestContext,
  HarnessFacetRequestRuntime,
  HarnessRequestFacetCreationEvidence,
  HarnessRequestFacetPreparationEvidence,
} from "../HarnessRequestFacet.ts";
import type { HarnessRequestTurnOptions } from "../HarnessRequestTurn.ts";
import type { HarnessRequestCheckpoint, HarnessRunArtifact } from "../HarnessRunStore.ts";
import type { HarnessRunStoreObject } from "../HarnessRunStoreObject.ts";
import type {
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorPublisher,
} from "../HarnessThreadSupervisor.ts";
import type { HarnessFilesStoreObject } from "../HarnessFilesStoreObject.ts";
import type { HarnessThreadSupervisorObject } from "../HarnessThreadSupervisorObject.ts";
import type { HarnessCheckpoint, HarnessError, HarnessOpenInput } from "../Harness.ts";
import type { HarnessCProductCapabilities } from "./capabilities.ts";
import type { HarnessCSelectedProductRelease } from "./selectedArtifact.ts";
import type { ProductHostOptions, ProductHarnessSessionHost } from "../host/product.ts";
import type { HarnessRequestFacetError } from "../HarnessRequestFacet.ts";

export type HarnessCProductFacetEnvironment = HarnessCProductBootstrapEnvironment &
  HarnessCProductCapabilityEnvironment &
  (HarnessProcessExecutionResumeFacetEnvironment | HarnessProcessCreationFacetEnvironment) & {
    readonly HARNESS_RESUME_CONTROL: HarnessThreadSupervisorControlClaim;
  };

export interface HarnessCProductResumeBindings {
  readonly runStore: Pick<HarnessRunStoreObject, "execute">;
  readonly filesStore: Pick<HarnessFilesStoreObject, "execute">;
  readonly supervisor: Pick<HarnessThreadSupervisorObject, "execute">;
}

export interface HarnessCProductTurnBindings<G> {
  readonly deadline?: HarnessRequestTurnOptions<G>["deadline"];
  readonly readTurn: (
    reference: HarnessRunArtifact,
    context: HarnessFacetRequestContext,
  ) => Effect.Effect<RunnerTurn, HarnessRequestFacetError>;
  readonly onEvent: HarnessRequestTurnOptions<G>["onEvent"];
  readonly writeResult: HarnessRequestTurnOptions<G>["writeResult"];
  readonly writeCheckpoint: HarnessRequestTurnOptions<G>["writeCheckpoint"];
  readonly verify: HarnessRequestTurnOptions<G>["verify"];
  /** Writes the first immutable artifacts for a new native thread before C is initialized. */
  readonly writeInitialCheckpoint?: (
    checkpoint: HarnessCheckpoint,
    context: HarnessCProductInitialCheckpointContext,
  ) => Effect.Effect<HarnessCProductInitialCheckpointResult, HarnessRequestFacetError>;
}

export interface HarnessCProductInitialCheckpointContext {
  readonly operationId: string;
  readonly publisher: HarnessThreadSupervisorPublisher;
  readonly signal: AbortSignal;
}

export interface HarnessCProductInitialCheckpointResult {
  readonly checkpoint: HarnessRequestCheckpoint;
  readonly filesCheckpoint: HarnessFilesCheckpoint;
}

export interface HarnessCProductFacetFactory<
  Env extends HarnessCProductFacetEnvironment,
  G,
  Native,
  Options extends ProductHostOptions<G, Native> & {
    readonly processResumeArtifact?: HarnessReleaseArtifact;
  },
  Host extends ProductHarnessSessionHost<G> & {
    readonly loadedPreparedRelease: () => HarnessProcessResumePreparedRelease;
  },
> {
  readonly provider: HarnessCProductProvider;
  readonly createHost: (options: Options) => Effect.Effect<Host, HarnessError, Scope.Scope>;
  /** Build local Computer, native, model and executor options from authorized bindings. */
  readonly buildHostOptions: (input: {
    readonly env: Env;
    readonly ctx: DurableObjectState;
    readonly facetNonce: string;
    readonly capabilities: HarnessCProductCapabilities<G>;
    readonly selectedRelease: HarnessCSelectedProductRelease;
    readonly checkpoint: HarnessCheckpoint;
    readonly filesCheckpoint: HarnessFilesStoreResult;
  }) => Effect.Effect<
    Omit<
      Options,
      | "release"
      | "processResumeArtifact"
      | "programs"
      | "machineInventory"
      | "modelTransport"
      | "executor"
    >,
    HarnessRequestFacetError
  >;
  /** Provider session identity stays in this entry and is never sent through C or B. */
  readonly buildOpenInput: (input: {
    readonly env: Env;
    readonly checkpoint: HarnessCheckpoint;
    readonly nativeSessionId: string;
    readonly restoreMode: HarnessCProductRestoreMode;
  }) => Effect.Effect<
    Pick<HarnessOpenInput, "session"> & { readonly bootAttemptId: string },
    HarnessRequestFacetError
  >;
  readonly fresh?: {
    /** Build a cold host without a prior native or filesystem checkpoint. */
    readonly buildHostOptions: (input: {
      readonly env: Env;
      readonly ctx: DurableObjectState;
      readonly facetNonce: string;
      readonly capabilities: HarnessCProductCapabilities<G>;
      readonly selectedRelease: HarnessCSelectedProductRelease;
    }) => Effect.Effect<
      Omit<
        Options,
        | "release"
        | "processResumeArtifact"
        | "programs"
        | "machineInventory"
        | "modelTransport"
        | "executor"
      >,
      HarnessRequestFacetError
    >;
    /** Creates an unbound provider thread; no native identity exists until host.open returns. */
    readonly buildOpenInput: (input: {
      readonly env: Env;
      readonly operationId: string;
    }) => Effect.Effect<
      Pick<HarnessOpenInput, "session" | "creation"> & { readonly bootAttemptId: string },
      HarnessRequestFacetError
    >;
  };
  /** These callbacks are assembled in this Worker from local service bindings. */
  readonly buildTurnBindings: (input: {
    readonly env: Env;
    readonly ctx: DurableObjectState;
    readonly capabilities: HarnessCProductCapabilities<G>;
  }) => Effect.Effect<HarnessCProductTurnBindings<G>, HarnessRequestFacetError>;
}

export interface PreparedHarnessCProductHost<Host> {
  readonly host: Host;
  readonly evidence: HarnessRequestFacetPreparationEvidence;
  readonly runtime: HarnessFacetRequestRuntime;
}

export interface PreparedFreshHarnessCProductHost<Host> {
  readonly host: Host;
  readonly evidence: HarnessRequestFacetCreationEvidence;
  readonly runtime: HarnessFacetRequestRuntime;
}

export interface HarnessCProductHostPreparationInput<
  Env extends HarnessCProductFacetEnvironment,
  G,
  Native,
  Options extends ProductHostOptions<G, Native> & {
    readonly processResumeArtifact?: HarnessReleaseArtifact;
  },
  Host extends ProductHarnessSessionHost<G> & {
    readonly loadedPreparedRelease: () => HarnessProcessResumePreparedRelease;
  },
> {
  readonly env: Env;
  readonly ctx: DurableObjectState;
  readonly facetNonce: string;
  readonly runId: string;
  readonly descriptor: HarnessCProductBootstrapDescriptor;
  readonly expected: HarnessProcessResumePreparedRelease;
  readonly capabilities: HarnessCProductCapabilities<G>;
  readonly resume: HarnessCProductResumeBindings;
  readonly turnBindings: HarnessCProductTurnBindings<G>;
  readonly factory: HarnessCProductFacetFactory<Env, G, Native, Options, Host>;
}

export interface HarnessCProductFreshHostPreparationInput<
  Env extends HarnessCProductFacetEnvironment,
  G,
  Native,
  Options extends ProductHostOptions<G, Native> & {
    readonly processResumeArtifact?: HarnessReleaseArtifact;
  },
  Host extends ProductHarnessSessionHost<G> & {
    readonly loadedPreparedRelease: () => HarnessProcessResumePreparedRelease;
  },
> {
  readonly env: Env;
  readonly ctx: DurableObjectState;
  readonly targetFacetNonce: string;
  readonly operationId: string;
  readonly publisherKey: string;
  readonly signal: AbortSignal;
  readonly runId: string;
  readonly descriptor: HarnessCProductBootstrapDescriptor;
  readonly expected: HarnessProcessResumePreparedRelease;
  readonly capabilities: HarnessCProductCapabilities<G>;
  readonly turnBindings: HarnessCProductTurnBindings<G>;
  readonly factory: HarnessCProductFacetFactory<Env, G, Native, Options, Host>;
}
