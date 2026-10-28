import type { HarnessRunStoreResult } from "../HarnessRunStore.ts";
import type { HarnessFilesStoreResult } from "../HarnessFilesStore.ts";
import type { HarnessThreadSupervisorResult } from "../HarnessThreadSupervisor.ts";
import type { HarnessThreadSupervisorReconciliationReservation } from "../durableState/supervisor/service.ts";

interface ProcessStoreClient<Result> {
  execute(command: unknown): Promise<Result>;
}

export interface ProcessStoreBindings {
  forFacet(runId: string): Promise<{
    readonly runStore: Fetcher;
    readonly filesStore: Fetcher;
    readonly threadSupervisor: Fetcher;
  }>;
  forRun(runId: string): {
    readonly runStore: ProcessStoreClient<HarnessRunStoreResult>;
    readonly filesStore: ProcessStoreClient<HarnessFilesStoreResult>;
    readonly threadSupervisor: ProcessStoreClient<HarnessThreadSupervisorResult> & {
      reserveReconciliation(
        input: unknown,
      ): Promise<HarnessThreadSupervisorReconciliationReservation>;
    };
  };
}
