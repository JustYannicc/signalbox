import type { Deploy3RuntimeEnvironment } from "../../runtime.ts";
import type { HarnessFilesStoreObject } from "../../../../src/harness/HarnessFilesStoreObject.ts";
import type { HarnessThreadSupervisorObject } from "../../../../src/harness/HarnessThreadSupervisorObject.ts";
import type {
  QualifierProofPort,
  QualifierRunStorePort,
  QualifierPlacementStorePort,
  QualifierShardPort,
  QualifierClaudeFixturesPort,
} from "./namespacePorts.ts";
import type { HarnessProcessExecutionEnvironment } from "../../../../src/harness/HarnessProcessPlacement.ts";
import type { CapabilityEnvironment } from "./capabilities.ts";

export interface QualifierEnvironment
  extends
    Deploy3RuntimeEnvironment,
    Omit<
      HarnessProcessExecutionEnvironment,
      "PLACEMENT_STORES" | "HARNESS_THREAD_SUPERVISOR" | "PROGRAM_ASSETS"
    >,
    Omit<CapabilityEnvironment, "HARNESS_FILES_STORE"> {
  CLAUDE_FIXTURES: DurableObjectNamespace<QualifierClaudeFixturesPort>;
  QUALIFIER: DurableObjectNamespace<QualifierProofPort>;
  HARNESS_RUN_STORE: DurableObjectNamespace<QualifierRunStorePort>;
  HARNESS_FILES_STORE: DurableObjectNamespace<HarnessFilesStoreObject>;
  HARNESS_THREAD_SUPERVISOR: DurableObjectNamespace<HarnessThreadSupervisorObject>;
  PLACEMENT_STORES: DurableObjectNamespace<QualifierPlacementStorePort>;
  PROCESS_EXECUTION_SHARDS: DurableObjectNamespace<QualifierShardPort>;
  QUALIFIER_COMMANDS: Fetcher;
  QUALIFIER_TAIL: Fetcher;
  BUNDLE_SHA256: string;
  RUN_ID: string;
  WORKER_NAME: string;
  OBSERVER_GUARD_ONLY?: string;
}
export const proof = (env: Pick<QualifierEnvironment, "QUALIFIER" | "RUN_ID">) =>
  env.QUALIFIER.getByName(env.RUN_ID);
