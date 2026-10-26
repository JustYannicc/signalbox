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
import type { HarnessFilesStoreResult } from "../HarnessFilesStore.ts";
import type {
  HarnessFacetRequestContext,
  HarnessFacetRequestRuntime,
  HarnessRequestFacetPreparationEvidence,
} from "../HarnessRequestFacet.ts";
import type { HarnessRequestTurnOptions } from "../HarnessRequestTurn.ts";
import type { HarnessRunArtifact } from "../HarnessRunStore.ts";
import type { HarnessRunStoreObject } from "../HarnessRunStoreObject.ts";
import type { HarnessThreadSupervisorControlClaim } from "../HarnessThreadSupervisor.ts";
import type { HarnessFilesStoreObject } from "../HarnessFilesStoreObject.ts";
import type { HarnessThreadSupervisorObject } from "../HarnessThreadSupervisorObject.ts";
import type { HarnessCheckpoint, HarnessError, HarnessOpenInput } from "../Harness.ts";
import type { HarnessCProductCapabilities } from "./capabilities.ts";
import type { HarnessCSelectedProductRelease } from "./selectedArtifact.ts";
import type { ProductHostOptions, ProductHarnessSessionHost } from "../host/product.ts";
import type { HarnessRequestFacetError } from "../HarnessRequestFacet.ts";

export type HarnessCProductFacetEnvironment = HarnessCProductBootstrapEnvironment &
  HarnessCProductCapabilityEnvironment &
  HarnessProcessExecutionResumeFacetEnvironment & {
    readonly HARNESS_RESUME_CONTROL: HarnessThreadSupervisorControlClaim;
  };

export interface HarnessCProductResumeBindings {
  readonly runStore: Pick<HarnessRunStoreObject, "execute">;
  readonly filesStore: Pick<HarnessFilesStoreObject, "execute">;
  readonly supervisor: Pick<HarnessThreadSupervisorObject, "execute">;
}

export interface HarnessCProductTurnBindings<G> {
  readonly readTurn: (
    reference: HarnessRunArtifact,
    context: HarnessFacetRequestContext,
  ) => Effect.Effect<RunnerTurn, HarnessRequestFacetError>;
  readonly onEvent: HarnessRequestTurnOptions<G>["onEvent"];
  readonly writeResult: HarnessRequestTurnOptions<G>["writeResult"];
  readonly writeCheckpoint: HarnessRequestTurnOptions<G>["writeCheckpoint"];
  readonly verify: HarnessRequestTurnOptions<G>["verify"];
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
