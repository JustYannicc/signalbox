import type { Deploy3RuntimeEnvironment } from "../../runtime.ts";
import type { QualifierProof } from "./proof.ts";
import type {
  QualifierRunStore,
  QualifierFilesStore,
  QualifierSupervisor,
  QualifierPlacementStore,
} from "./stores.ts";
import type { QualifierShard } from "./shard.ts";
import type { HarnessProcessExecutionEnvironment } from "../../../../src/harness/HarnessProcessPlacement.ts";
import type { CapabilityEnvironment } from "./capabilities.ts";
import type { ClaudeContinuationCapability } from "./claudeContinuations.ts";

export interface QualifierEnvironment
  extends
    Deploy3RuntimeEnvironment,
    Omit<
      HarnessProcessExecutionEnvironment,
      "PLACEMENT_STORES" | "HARNESS_THREAD_SUPERVISOR" | "PROGRAM_ASSETS"
    >,
    Omit<CapabilityEnvironment, "HARNESS_FILES_STORE"> {
  QUALIFIER: DurableObjectNamespace<QualifierProof>;
  HARNESS_RUN_STORE: DurableObjectNamespace<QualifierRunStore>;
  HARNESS_FILES_STORE: DurableObjectNamespace<QualifierFilesStore>;
  HARNESS_THREAD_SUPERVISOR: DurableObjectNamespace<QualifierSupervisor>;
  PLACEMENT_STORES: DurableObjectNamespace<QualifierPlacementStore>;
  PROCESS_EXECUTION_SHARDS: DurableObjectNamespace<QualifierShard>;
  QUALIFIER_COMMANDS: Fetcher;
  QUALIFIER_TAIL: Fetcher;
  /** Installed only when the public thread command path can commit Claude continuations. */
  CLAUDE_CONTINUATION_PUBLISHER?: ClaudeContinuationCapability;
  /** These bindings preserve the actual caller's MCP access and connected tools. */
  CLAUDE_ACCESS?: Fetcher;
  /** Claude-only normal Executor MCP capability; Codex keeps the qualifier exclusion. */
  CLAUDE_EXECUTOR?: Fetcher;
  BUNDLE_SHA256: string;
  RUN_ID: string;
  WORKER_NAME: string;
  OBSERVER_GUARD_ONLY?: string;
}
export const proof = (env: Pick<QualifierEnvironment, "QUALIFIER" | "RUN_ID">) =>
  env.QUALIFIER.getByName(env.RUN_ID);
