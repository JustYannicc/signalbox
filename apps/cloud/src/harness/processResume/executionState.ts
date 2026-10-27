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

interface OwnedRequestState {
  readonly runId: string;
  readonly placement: HarnessProcessResumePlacementPin;
  durable: HarnessDurableState;
  readonly publisher: HarnessThreadSupervisorPublisher;
  readonly request: HarnessRequestOffer;
  readonly runStorePublisher: HarnessRequestPublisher;
  readonly parentCheckpoint: HarnessRequestCheckpoint;
  readonly completion: PromiseWithResolvers<HarnessDurableStateCheckpointResult | undefined>;
  readonly settled: PromiseWithResolvers<void>;
  control: HarnessThreadSupervisorControlClaim;
  retained: boolean;
}

export type OwnedProcessRequest = OwnedRequestState &
  (
    | {
        readonly kind: "created";
        readonly process: Pick<
          HarnessProcessExecutionProcessInput,
          "processId" | "operationId" | "nativeSessionId"
        >;
        readonly handle: Pick<
          HarnessProcessHandle<HarnessProcessFacetInvokeInput>,
          "identity" | "stop" | "join" | "cleanup"
        >;
        readonly journal: Pick<HarnessProcessResumeRunStoreBinding, "controlKey" | "supervisor">;
      }
    | {
        readonly kind: "published";
        readonly process: HarnessProcessExecutionProcessInput;
        readonly handle: HarnessProcessHandle<HarnessProcessFacetInvokeInput>;
        readonly publication: Published;
        readonly journal: HarnessProcessResumeRunStoreBinding;
      }
  );
