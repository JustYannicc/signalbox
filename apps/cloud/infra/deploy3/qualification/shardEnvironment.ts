import { HARNESS_C_PRODUCT_CAPABILITY_KEYS as Keys } from "../../../src/harness/HarnessCProductCapabilities.ts";
import type {
  QualifierShardPlannedConfiguration,
  QualifierShardRuntimeConfiguration,
} from "./environmentContract.ts";

type RuntimeInputs = typeof QualifierShardRuntimeConfiguration.Type;
type PlannedInputs = typeof QualifierShardPlannedConfiguration.Type;

export function qualifierShardInputs<Environment extends RuntimeInputs | PlannedInputs>(
  env: Environment,
): Pick<Environment, keyof RuntimeInputs> {
  return {
    RUN_ID: env.RUN_ID,
    WORKER_NAME: env.WORKER_NAME,
    CONFIG_SHA256: env.CONFIG_SHA256,
    RESIDENT_BYTE_LIMIT: env.RESIDENT_BYTE_LIMIT,
    ...(env.OBSERVER_GUARD_ONLY === undefined
      ? {}
      : { OBSERVER_GUARD_ONLY: env.OBSERVER_GUARD_ONLY }),
    QUALIFIER: env.QUALIFIER,
    CLAUDE_FIXTURES: env.CLAUDE_FIXTURES,
    HARNESS_RUN_STORE: env.HARNESS_RUN_STORE,
    HARNESS_FILES_STORE: env.HARNESS_FILES_STORE,
    HARNESS_THREAD_SUPERVISOR: env.HARNESS_THREAD_SUPERVISOR,
    PLACEMENT_STORES: env.PLACEMENT_STORES,
    PROCESS_EXECUTION_SHARDS: env.PROCESS_EXECUTION_SHARDS,
    LOADER: env.LOADER,
    PROGRAM_ASSETS: env.PROGRAM_ASSETS,
    QUALIFIER_COMMANDS: env.QUALIFIER_COMMANDS,
    QUALIFIER_TAIL: env.QUALIFIER_TAIL,
  };
}

export function createQualifierShardEnvironment<
  Environment extends RuntimeInputs | PlannedInputs,
  Loader,
  Capability,
>(env: Environment, loader: Loader, capability: Capability) {
  const inputs = qualifierShardInputs(env);
  return {
    ...inputs,
    LOADER: loader,
    HARNESS_C_PRODUCT_CAPABILITIES: {
      [Keys.release]: capability,
      [Keys.nativeCheckpoint]: capability,
      [Keys.access]: capability,
      [Keys.programs]: capability,
      [Keys.machine]: capability,
      [Keys.model]: capability,
      [Keys.executor]: capability,
      qualifierCommands: inputs.QUALIFIER_COMMANDS,
    },
  };
}
