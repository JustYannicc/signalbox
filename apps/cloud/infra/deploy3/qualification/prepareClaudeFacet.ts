import type { AssetFetcher } from "../../../src/assets/ChunkedAsset.ts";
import { samePreparedRelease } from "../../../src/harness/ProductHarnessProcessRelease.ts";
import { claudeOwnerCode, openClaudeOwnerRelease } from "./fixture/claudeOwnerCode.ts";
import type { Configuration } from "./fixture/configuration.ts";
import { decodePreparedRelease } from "./preparedRelease.schema.ts";
import { createQualifierClaudeFacetEnvironment } from "./claudeFacetEnvironment.ts";
import type { ClaudeSdkHostService } from "../../../src/harness/ClaudeSdkHostProtocol.ts";
import type { ClaudeOwnerCodeFactory } from "../../../src/harness/ClaudeProductOwners.ts";

/** Materializes verified modules inside the real loader's lazy code callback. */
export async function prepareClaudeFacetCode(
  code: WorkerLoaderWorkerCode,
  configuration: Pick<Configuration, "claude">,
  assets: AssetFetcher,
  inputs: {
    readonly RUN_ID: string;
    readonly CONFIG_SHA256: string;
    readonly authorities: Parameters<typeof createQualifierClaudeFacetEnvironment>[3];
    readonly sdkHost?: (code: WorkerLoaderWorkerCode) => ClaudeSdkHostService;
    readonly cli?: (
      code: ClaudeOwnerCodeFactory,
    ) => import("../../../src/harness/ClaudeCliKernelPort.ts").ClaudeCliHost;
    readonly kernel?: (
      code: ClaudeOwnerCodeFactory,
    ) => import("./fixture/claudeKernelProtocol.ts").QualifierClaudeKernelPort;
    readonly computer?: (
      code: ClaudeOwnerCodeFactory,
    ) => import("../../../src/kernel/KernelComputerAdmissionPort.ts").ComputerProgramOwnerPort & {
      configure(
        input: import("../../../src/computer/ComputerExecutionObject.ts").ComputerExecutionConfiguration,
      ): Promise<void>;
    };
  },
) {
  const calibration = code.mainModule === "qualifier-claude-calibration-facet.mjs";
  if (calibration !== (code.env?.QUALIFIER_CLAUDE_FACET_MODE === "inert-import-calibration"))
    throw new Error("DEPLOY3_CLAUDE_FACET_MODE_MISMATCH");
  const selected = decodePreparedRelease(code.env?.HARNESS_C_TARGET_PREPARED_RELEASE);
  const matches = (["baseline", "hooks"] as const).filter((variant) =>
    samePreparedRelease(selected, configuration.claude.expected[variant]),
  );
  const variant = matches.length === 1 ? matches[0] : undefined;
  if (!variant) throw new Error("DEPLOY3_CLAUDE_SELECTED_RELEASE_MISMATCH");
  const supplied: unknown = code.env?.QUALIFIER_CLAUDE_VARIANT;
  if (supplied !== undefined && supplied !== variant)
    throw new Error("DEPLOY3_CLAUDE_SELECTED_VARIANT_MISMATCH");
  const release = await openClaudeOwnerRelease(selected, configuration.claude, assets);
  // The CLI's ~49 MB of release source is built only inside its own loader's callback.
  const modules = calibration ? await release.modules(undefined) : {};
  const environment = createQualifierClaudeFacetEnvironment(
    code.env ?? {},
    { ...inputs, runtime: configuration.claude.runtime },
    variant,
    inputs.authorities,
  );
  if (!calibration && inputs.sdkHost === undefined)
    throw new Error("CLAUDE_SDK_HOST_LOADER_MISSING");
  if (
    !calibration &&
    (inputs.kernel === undefined || inputs.computer === undefined || inputs.cli === undefined)
  )
    throw new Error("CLAUDE_PRODUCT_OWNER_LOADER_MISSING");
  const { kernelSource, cliSource, computerSource, sdkHostSource } = configuration.claude;
  // Owner factories close over these fields, never over the facet's own code object.
  const owners = claudeOwnerCode({
    compatibility: {
      compatibilityDate: code.compatibilityDate,
      ...(code.compatibilityFlags === undefined
        ? {}
        : { compatibilityFlags: code.compatibilityFlags }),
    },
    release,
    sources: {
      kernel: () => kernelSource,
      cli: () => cliSource,
      computer: () => computerSource,
      sdk: () => sdkHostSource,
    },
    kernelEnv: environment,
    commands: environment.HARNESS_C_PRODUCT_CAPABILITIES?.qualifierCommands,
  });
  // The SDK host loader binding carries its code in props, so it cannot take a factory.
  const sdkHost = calibration ? undefined : inputs.sdkHost!(await owners.sdk());
  const kernel = calibration ? undefined : inputs.kernel!(owners.kernel);
  const cli = calibration ? undefined : inputs.cli!(owners.cli);
  const computer = calibration ? undefined : inputs.computer!(owners.computer);
  return {
    variant,
    code: {
      ...code,
      env: {
        ...environment,
        ...(sdkHost === undefined ? {} : { CLAUDE_SDK_HOST: sdkHost }),
        ...(kernel === undefined ? {} : { CLAUDE_KERNEL: kernel }),
        ...(cli === undefined ? {} : { CLAUDE_CLI: cli }),
        ...(computer === undefined ? {} : { COMPUTER_EXECUTION: computer }),
      },
      modules: {
        ...code.modules,
        ...(calibration ? modules : {}),
        "qualifier-claude-implementation.mjs": { js: configuration.claude.facetSource },
      },
    },
  };
}
