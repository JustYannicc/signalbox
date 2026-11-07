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
  const plan = loaded.plan;
  const packages: Record<string, string> = {};
  for (const [name, pin] of Object.entries(configuration.claude.environmentPackages))
    packages[name] = new TextDecoder("utf-8", { fatal: true }).decode(await readAsset(assets, pin));
  const readRange = opened.source.readRange;
  if (!readRange) throw new Error("DEPLOY3_CLAUDE_RANGE_READER_MISSING");
  // Owner factories close over these fields, never over the facet's own code object.
  const compatibility = {
    compatibilityDate: code.compatibilityDate,
    ...(code.compatibilityFlags === undefined
      ? {}
      : { compatibilityFlags: code.compatibilityFlags }),
  };
  const releaseModules = async (partition: "cli" | "sdk" | undefined) =>
    materializeHarnessProcessModules(
      await claudePreparedWorkerModules({ artifact: selected.artifact, plan }, packages, partition),
      selected,
      readRange,
    );
  // The CLI's ~49 MB of release source is built only inside its own loader's callback.
  const modules = calibration ? await releaseModules(undefined) : {};
  const environment = createQualifierClaudeFacetEnvironment(
    code.env ?? {},
    { ...inputs, runtime: configuration.claude.runtime },
    variant,
    inputs.authorities,
  );
  // The SDK host loader binding carries its code in props, so it cannot take a factory.
  const sdkModules = calibration ? {} : await releaseModules("sdk");
  if (!calibration && inputs.sdkHost === undefined)
    throw new Error("CLAUDE_SDK_HOST_LOADER_MISSING");
  const sdkHost = calibration
    ? undefined
    : inputs.sdkHost!({
        ...compatibility,
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
  const { kernelSource, cliSource, computerSource } = configuration.claude;
  const kernel = calibration
    ? undefined
    : inputs.kernel!(() => ({
        ...compatibility,
        mainModule: "claude-kernel-entry.mjs",
        modules: {
          "claude-kernel-entry.mjs": {
            js: 'export { ClaudeKernelFacet } from "./qualifier-claude-kernel.mjs";',
          },
          "qualifier-claude-kernel.mjs": { js: kernelSource },
        },
        env: environment,
        globalOutbound: null,
      }));
  const cli = calibration
    ? undefined
    : inputs.cli!(async () => ({
        ...compatibility,
        mainModule: "claude-cli-entry.mjs",
        modules: {
          ...(await releaseModules("cli")),
          "claude-cli-entry.mjs": {
            js: 'export { ClaudeCliFacet } from "./qualifier-claude-cli.mjs";',
          },
          "qualifier-claude-cli.mjs": { js: cliSource },
        },
        globalOutbound: null,
      }));
  const computer = calibration
    ? undefined
    : inputs.computer!(() => ({
        ...compatibility,
        mainModule: "computer-execution-entry.mjs",
        modules: {
          "computer-execution-entry.mjs": {
            js: 'export { ComputerExecutionObject } from "./computer-execution.mjs";',
          },
          "computer-execution.mjs": { js: computerSource },
        },
        env: {
          CHILD_WORKERS: environment.HARNESS_C_PRODUCT_CAPABILITIES?.qualifierCommands,
          RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
        },
        globalOutbound: null,
      }));
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
