import type {
  HarnessDurableState,
  HarnessDurableStateCheckpointResult,
} from "../HarnessDurableState.ts";
import type { HarnessProcessHandle } from "../processPlacement/contracts.ts";
import type { HarnessProcessFacetInvokeInput } from "../HarnessProcessFacet.ts";
import type { HarnessProcessExecutionProcessInput } from "../processPlacement/execution.ts";
import type {
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorPublisher,
} from "../HarnessThreadSupervisor.ts";
import type {
  HarnessRequestCheckpoint,
  HarnessRequestOffer,
  HarnessRequestPublisher,
} from "../HarnessRunStore.ts";
import type { HarnessProcessResumePlacementPin } from "./durableState.ts";
import type { HarnessProcessResumeRunStoreBinding } from "./contracts.ts";
import type { Published } from "./authority.ts";

export interface OwnedProcessRequest {
  readonly runId: string;
  readonly placement: HarnessProcessResumePlacementPin;
  readonly process: HarnessProcessExecutionProcessInput;
  durable: HarnessDurableState;
  readonly handle: HarnessProcessHandle<HarnessProcessFacetInvokeInput>;
  readonly publication: Published;
  readonly publisher: HarnessThreadSupervisorPublisher;
  readonly request: HarnessRequestOffer;
  readonly runStorePublisher: HarnessRequestPublisher;
  readonly journal: HarnessProcessResumeRunStoreBinding;
  readonly parentCheckpoint: HarnessRequestCheckpoint;
  readonly completion: PromiseWithResolvers<HarnessDurableStateCheckpointResult | undefined>;
  readonly settled: PromiseWithResolvers<void>;
  control: HarnessThreadSupervisorControlClaim;
  retained: boolean;
}
