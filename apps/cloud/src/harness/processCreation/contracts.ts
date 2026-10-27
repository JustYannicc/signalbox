import type {
  HarnessRunInitialization,
  HarnessDurableStateBindings,
} from "../HarnessDurableState.ts";
import type {
  HarnessProcessControllerClaim,
  HarnessProcessPlacementIdentity,
} from "../processPlacement/contracts.ts";
import type {
  HarnessProcessExecutionEnvironment,
  HarnessProcessExecutionFacetCodeInput,
} from "../processPlacement/executionEnvironment.ts";
import type { HarnessProcessPlacementWriter } from "../processPlacement/storeSchema.ts";
import type { ProcessSlotLease } from "../../computer/ProcessSlots.ts";
import type { HarnessRequestOffer, HarnessRequestCheckpoint } from "../HarnessRunStore.ts";
import type { HarnessProcessCreationBinding } from "./journal.ts";

export type HarnessProcessCreationEnvironment = HarnessProcessExecutionEnvironment &
  HarnessDurableStateBindings;
export interface HarnessProcessCreationInput {
  readonly runId: string;
  readonly operationId: string;
  readonly run: HarnessRunInitialization;
  readonly controllerClaim: HarnessProcessControllerClaim;
  readonly publisherKey: string;
  readonly requestPublisherKey: string;
  readonly requestModeId: string;
  readonly facet: HarnessProcessExecutionFacetCodeInput & {
    readonly productBootstrap: NonNullable<
      HarnessProcessExecutionFacetCodeInput["productBootstrap"]
    >;
    readonly targetPreparedRelease: NonNullable<
      HarnessProcessExecutionFacetCodeInput["targetPreparedRelease"]
    >;
  };
}
export interface HarnessProcessCreationPlacement {
  readonly version: 1;
  readonly operationId: string;
  readonly owner: string;
  readonly writer: HarnessProcessPlacementWriter;
  readonly lease: ProcessSlotLease;
  readonly input: HarnessProcessCreationInput;
  readonly identity?: HarnessProcessPlacementIdentity;
  readonly disposed?: true;
  readonly released?: true;
}
export interface HarnessProcessCreationRunInput {
  readonly runId: string;
  readonly operationId: string;
  readonly request: HarnessRequestOffer;
}
export interface HarnessProcessCreationReady {
  readonly status: "created" | "bound";
  readonly operationId: string;
  readonly identity: HarnessProcessPlacementIdentity;
  readonly nativeSessionId: string;
  readonly checkpoint: HarnessRequestCheckpoint;
}
export const creationPlacementKey = (runId: string) =>
  `harness-process-creation-placement/v1/${encodeURIComponent(runId)}`;
export const readyCreation = (
  operationId: string,
  binding: HarnessProcessCreationBinding,
  status: HarnessProcessCreationReady["status"],
): HarnessProcessCreationReady => ({
  status,
  operationId,
  identity: structuredClone(binding.identity),
  nativeSessionId: binding.nativeSessionId,
  checkpoint: structuredClone(binding.checkpoint),
});
