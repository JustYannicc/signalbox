import { readClaudeFacetConfiguration } from "./claudeFacetConfiguration.ts";
import {
  assertQualifierClaudeFacetConfiguration as assertQualifierClaudeNativeFacetConfiguration,
  type QualifierClaudeFacetConfiguration,
} from "../facetEnvironmentContract.ts";
import type { ClaudeAuthorityBindings } from "./claudeAuthorities.ts";
import type { HarnessCProductFacetEnvironment } from "../../../../src/harness/HarnessCProductFacet.ts";
import { HARNESS_C_PRODUCT_CAPABILITY_KEYS } from "../../../../src/harness/HarnessCProductCapabilities.ts";
import type { QualifierCapabilities } from "./capabilities.ts";
import { assert } from "./common.ts";
export type ClaudeFacetEnvironment = typeof QualifierClaudeFacetConfiguration.Type &
  ClaudeAuthorityBindings &
  HarnessCProductFacetEnvironment & {
    readonly HARNESS_PROCESS_LOADER_ID: string;
    readonly QUALIFIER_CLAUDE_VARIANT?: unknown;
    readonly CLAUDE_CLI: import("../../../../src/harness/ClaudeCliKernelPort.ts").ClaudeCliHost;
    readonly CLAUDE_KERNEL: import("./claudeKernelProtocol.ts").QualifierClaudeKernelPort;
    readonly COMPUTER_EXECUTION: import("../../../../src/kernel/KernelComputerAdmissionPort.ts").ComputerProgramOwnerPort & {
      configure(
        input: import("../../../../src/computer/ComputerExecutionObject.ts").ComputerExecutionConfiguration,
      ): Promise<void>;
    };
    readonly CLAUDE_SDK_HOST: import("../../../../src/harness/ClaudeSdkHostProtocol.ts").ClaudeSdkHostService;
  };

type Capability = QualifierCapabilities;
export function claudeCapability(
  env: Pick<ClaudeFacetEnvironment, "HARNESS_C_PRODUCT_CAPABILITIES">,
): Capability {
  const supplied = env.HARNESS_C_PRODUCT_CAPABILITIES?.[HARNESS_C_PRODUCT_CAPABILITY_KEYS.release];
  assert(
    supplied &&
      typeof Reflect.get(supplied, "hostConfiguration") === "function" &&
      typeof Reflect.get(supplied, "append") === "function" &&
      typeof Reflect.get(supplied, "prepareClaudeIncarnation") === "function",
    "Claude qualification capability methods are missing",
  );
  return supplied as unknown as Capability;
}

export async function claudeConfiguration(env: ClaudeFacetEnvironment) {
  const checked = assertQualifierClaudeNativeFacetConfiguration(env);
  return readClaudeFacetConfiguration(checked, claudeCapability(env));
}
