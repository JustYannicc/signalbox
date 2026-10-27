import type { HarnessProcessExecutionEnvironment } from "../../../HarnessProcessPlacement.ts";
import type { HarnessProcessExecutionShardObject } from "../../../HarnessProcessExecutionShardObject.ts";
import type { HarnessProcessPlacementStoreObject } from "../../../HarnessProcessPlacementStoreObject.ts";
import type { ProductFixtureFilesStore } from "./productStores.workerd.fixture.ts";
import type { HarnessThreadSupervisorObject } from "../../../HarnessThreadSupervisorObject.ts";
import type { ProductFixtureRunStore } from "./productStores.workerd.fixture.ts";
import type { ProductFixtureCapability } from "./productCapability.workerd.fixture.ts";
import type { ProductFixtureExecutor } from "./productExecutor.workerd.fixture.ts";

export type ProductFixtureShard = HarnessProcessExecutionShardObject & {
  holdHeapProbe(bytes: number): Promise<{ readonly heldBytes: number }>;
  releaseHeapProbe(): Promise<{ readonly releasedBytes: number }>;
  startLegacyMemoryProof(
    input: import("../../../HarnessProcessPlacement.ts").HarnessProcessExecutionShardInput,
    requestContextId: string,
  ): Promise<{ readonly started: true }>;
  evidence(): Promise<{
    terminal: {
      stopped: boolean;
      joined: { invocationRpc: boolean; fetch: boolean; ports: boolean };
      requestId: string | undefined;
    }[];
    resumes: { phase: string; prepared: boolean; failure: unknown }[];
  }>;
};
export type ProductFixturePlacementStore = HarnessProcessPlacementStoreObject & {
  writerStatus(owner: string): Promise<{ writer: boolean }>;
};
export interface ProductWorkerEnv extends HarnessProcessExecutionEnvironment {
  readonly PRODUCT_FIXTURE: DurableObjectNamespace<ProductFixtureCapability>;
  readonly PRODUCT_EXECUTOR: DurableObjectNamespace<ProductFixtureExecutor>;
  readonly PRODUCT_FACET_SOURCE: string;
  readonly PRODUCT_MEMORY_NATIVE_WASM?: string;
  readonly HARNESS_FILES_STORE: DurableObjectNamespace<ProductFixtureFilesStore>;
  readonly HARNESS_RUN_STORE: DurableObjectNamespace<ProductFixtureRunStore>;
  readonly HARNESS_THREAD_SUPERVISOR: DurableObjectNamespace<HarnessThreadSupervisorObject>;
  readonly PROCESS_EXECUTION_SHARDS: DurableObjectNamespace<ProductFixtureShard>;
  readonly PLACEMENT_STORES: DurableObjectNamespace<ProductFixturePlacementStore>;
}
