import type { AssetFetcher } from "../../../src/assets/ChunkedAsset.ts";
import { loadHarnessRelease } from "../../../src/harness/HarnessReleaseLoader.ts";
import { materializeHarnessProcessModules } from "../../../src/harness/HarnessProcessPlacement.ts";
import { samePreparedRelease } from "../../../src/harness/ProductHarnessProcessRelease.ts";
import { claudePreparedWorkerModules } from "./fixture/claudePreparedModules.ts";
import { readAsset, type Configuration } from "./fixture/configuration.ts";
import { decodePreparedRelease } from "./preparedRelease.schema.ts";
import { readClaudeQualificationAssets } from "./runtimeAssets.ts";
import { createQualifierClaudeFacetEnvironment } from "./claudeFacetEnvironment.ts";
import type { ClaudeSdkHostService } from "../../../src/harness/ClaudeSdkHostProtocol.ts";

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
      code: WorkerLoaderWorkerCode,
    ) => import("../../../src/harness/ClaudeCliKernelPort.ts").ClaudeCliHost;
    readonly kernel?: (
      code: WorkerLoaderWorkerCode,
    ) => import("./fixture/claudeKernelProtocol.ts").QualifierClaudeKernelPort;
    readonly computer?: (
      code: WorkerLoaderWorkerCode,
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
  const opened = await readClaudeQualificationAssets(configuration.claude.runtime.assets, assets);
  const loaded = await loadHarnessRelease({
    identity: {
      artifactRef: selected.artifact.artifactRef,
      artifactHash: selected.artifact.artifactHash,
      sourceIdentity: selected.artifact.sourceIdentity,
    },
    source: opened.source,
    ...opened.loaderConfig,
  });
  if (loaded.plan.harness !== "claude-code") throw new Error("DEPLOY3_CLAUDE_PLAN_MISMATCH");
  const packages: Record<string, string> = {};
  for (const [name, pin] of Object.entries(configuration.claude.environmentPackages))
    packages[name] = new TextDecoder("utf-8", { fatal: true }).decode(await readAsset(assets, pin));
  const prepared = await claudePreparedWorkerModules(
    { artifact: selected.artifact, plan: loaded.plan },
    packages,
    calibration ? undefined : "cli",
  );
  const readRange = opened.source.readRange;
  if (!readRange) throw new Error("DEPLOY3_CLAUDE_RANGE_READER_MISSING");
  const modules = await materializeHarnessProcessModules(prepared, selected, readRange);
  const environment = createQualifierClaudeFacetEnvironment(
    code.env ?? {},
    inputs,
    variant,
    inputs.authorities,
  );
  const sdkModules = calibration
    ? {}
    : await materializeHarnessProcessModules(
        await claudePreparedWorkerModules(
          { artifact: selected.artifact, plan: loaded.plan },
          packages,
          "sdk",
        ),
        selected,
        readRange,
      );
  if (!calibration && inputs.sdkHost === undefined)
    throw new Error("CLAUDE_SDK_HOST_LOADER_MISSING");
  const sdkHost = calibration
    ? undefined
    : inputs.sdkHost!({
        compatibilityDate: code.compatibilityDate,
        ...(code.compatibilityFlags === undefined
          ? {}
          : { compatibilityFlags: code.compatibilityFlags }),
        mainModule: "claude-sdk-host-entry.mjs",
        modules: {
          ...sdkModules,
          "claude-sdk-host-entry.mjs": {
            js: 'export { ClaudeSdkHost as default } from "./qualifier-claude-sdk-host.mjs";',
          },
          "qualifier-claude-sdk-host.mjs": { js: configuration.claude.sdkHostSource },
        },
        env: { CLAUDE_SDK_PLAN: loaded.plan, CLAUDE_SDK_RELEASE: loaded.plan.release },
        globalOutbound: null,
      });
  if (
    !calibration &&
    (inputs.kernel === undefined || inputs.computer === undefined || inputs.cli === undefined)
  )
    throw new Error("CLAUDE_PRODUCT_OWNER_LOADER_MISSING");
  const kernel = calibration
    ? undefined
    : inputs.kernel!({
        compatibilityDate: code.compatibilityDate,
        ...(code.compatibilityFlags === undefined
          ? {}
          : { compatibilityFlags: code.compatibilityFlags }),
        mainModule: "claude-kernel-entry.mjs",
        modules: {
          "claude-kernel-entry.mjs": {
            js: 'export { ClaudeKernelFacet } from "./qualifier-claude-kernel.mjs";',
          },
          "qualifier-claude-kernel.mjs": { js: configuration.claude.kernelSource },
        },
        env: environment,
        globalOutbound: null,
      });
  const cli = calibration
    ? undefined
    : inputs.cli!({
        compatibilityDate: code.compatibilityDate,
        ...(code.compatibilityFlags === undefined
          ? {}
          : { compatibilityFlags: code.compatibilityFlags }),
        mainModule: "claude-cli-entry.mjs",
        modules: {
          ...modules,
          "claude-cli-entry.mjs": {
            js: 'export { ClaudeCliFacet } from "./qualifier-claude-cli.mjs";',
          },
          "qualifier-claude-cli.mjs": { js: configuration.claude.cliSource },
        },
        globalOutbound: null,
      });
  const computer = calibration
    ? undefined
    : inputs.computer!({
        compatibilityDate: code.compatibilityDate,
        ...(code.compatibilityFlags === undefined
          ? {}
          : { compatibilityFlags: code.compatibilityFlags }),
        mainModule: "computer-execution-entry.mjs",
        modules: {
          "computer-execution-entry.mjs": {
            js: 'export { ComputerExecutionObject } from "./computer-execution.mjs";',
          },
          "computer-execution.mjs": { js: configuration.claude.computerSource },
        },
        env: {
          CHILD_WORKERS: environment.HARNESS_C_PRODUCT_CAPABILITIES?.qualifierCommands,
          RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
        },
        globalOutbound: null,
      });
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
