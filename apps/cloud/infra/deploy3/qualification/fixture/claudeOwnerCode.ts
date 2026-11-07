import type { AssetFetcher } from "../../../../src/assets/ChunkedAsset.ts";
import type {
  ClaudeOwnerCodeFactory,
  ClaudeProductOwnerRuntime,
} from "../../../../src/harness/ClaudeProductOwners.ts";
import type { HarnessProcessResumePreparedRelease } from "../../../../src/harness/HarnessProcessResume.ts";
import { materializeHarnessProcessModules } from "../../../../src/harness/HarnessProcessPlacement.ts";
import { loadHarnessRelease } from "../../../../src/harness/HarnessReleaseLoader.ts";
import { readClaudeQualificationAssets } from "../runtimeAssets.ts";
import { claudePreparedWorkerModules } from "./claudePreparedModules.ts";
import { readAsset, type Configuration } from "./configuration.ts";

type Source = () => string | Promise<string>;
type Compatibility = Pick<WorkerLoaderWorkerCode, "compatibilityDate" | "compatibilityFlags">;

/** What product placement gives a harness facet (src/harness/processPlacement/facetLoader.ts). */
export const CLAUDE_OWNER_COMPATIBILITY: Compatibility = {
  compatibilityDate: "2026-10-19",
  compatibilityFlags: ["nodejs_compat", "new_module_registry"],
};

/** Opens the selected release; its module source is built only when an owner's loader asks. */
export async function openClaudeOwnerRelease(
  selected: HarnessProcessResumePreparedRelease,
  claude: Pick<Configuration["claude"], "runtime" | "environmentPackages">,
  assets: AssetFetcher,
) {
  const opened = await readClaudeQualificationAssets(claude.runtime.assets, assets);
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
  for (const [name, pin] of Object.entries(claude.environmentPackages))
    packages[name] = new TextDecoder("utf-8", { fatal: true }).decode(await readAsset(assets, pin));
  const readRange = opened.source.readRange;
  if (!readRange) throw new Error("DEPLOY3_CLAUDE_RANGE_READER_MISSING");
  return {
    plan,
    modules: async (partition: "cli" | "sdk" | undefined) =>
      materializeHarnessProcessModules(
        await claudePreparedWorkerModules(
          { artifact: selected.artifact, plan },
          packages,
          partition,
        ),
        selected,
        readRange,
      ),
  };
}

/**
 * Each owner's Worker code, built only inside its loader's callback. The CLI's ~49 MB of release
 * source exists only while that callback runs, never in the isolate that opens the owners.
 */
export function claudeOwnerCode(input: {
  readonly compatibility: Compatibility;
  readonly release: Awaited<ReturnType<typeof openClaudeOwnerRelease>>;
  readonly sources: {
    readonly kernel: Source;
    readonly cli: Source;
    readonly computer: Source;
    readonly sdk: Source;
  };
  readonly kernelEnv: Readonly<Record<string, unknown>>;
  readonly commands: unknown;
}): Record<"kernel" | "cli" | "computer" | "sdk", ClaudeOwnerCodeFactory> {
  const { compatibility, release, sources } = input;
  return {
    kernel: async () => ({
      ...compatibility,
      mainModule: "claude-kernel-entry.mjs",
      modules: {
        "claude-kernel-entry.mjs": {
          js: 'export { ClaudeKernelFacet } from "./qualifier-claude-kernel.mjs";',
        },
        "qualifier-claude-kernel.mjs": { js: await sources.kernel() },
      },
      env: input.kernelEnv,
      globalOutbound: null,
    }),
    cli: async () => ({
      ...compatibility,
      mainModule: "claude-cli-entry.mjs",
      modules: {
        ...(await release.modules("cli")),
        "claude-cli-entry.mjs": {
          js: 'export { ClaudeCliFacet } from "./qualifier-claude-cli.mjs";',
        },
        "qualifier-claude-cli.mjs": { js: await sources.cli() },
      },
      globalOutbound: null,
    }),
    computer: async () => ({
      ...compatibility,
      mainModule: "computer-execution-entry.mjs",
      modules: {
        "computer-execution-entry.mjs": {
          js: 'export { ComputerExecutionObject } from "./computer-execution.mjs";',
        },
        "computer-execution.mjs": { js: await sources.computer() },
      },
      env: { CHILD_WORKERS: input.commands, RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024) },
      globalOutbound: null,
    }),
    sdk: async () => ({
      ...compatibility,
      mainModule: "claude-sdk-host-entry.mjs",
      modules: {
        ...(await release.modules("sdk")),
        "claude-sdk-host-entry.mjs": {
          js: 'export { ClaudeSdkHost as default } from "./qualifier-claude-sdk-host.mjs";',
        },
        "qualifier-claude-sdk-host.mjs": { js: await sources.sdk() },
      },
      env: { CLAUDE_SDK_PLAN: release.plan, CLAUDE_SDK_RELEASE: release.plan.release },
      globalOutbound: null,
    }),
  };
}

/**
 * The Claude host's own loader and facets open every owner, so no owner stub is ever placed in
 * another Worker's environment. Each owner is its own isolate and carries the qualifier's tail,
 * or a memory reset there would be unattributable.
 */
export function claudeOwnerRuntime(input: {
  readonly loader: WorkerLoader;
  readonly facets: DurableObjectState["facets"];
  readonly code: ClaudeProductOwnerRuntime["code"];
  readonly versions: ClaudeProductOwnerRuntime["versions"];
  readonly tail: Fetcher;
}): ClaudeProductOwnerRuntime {
  const tailed = (factory: ClaudeOwnerCodeFactory) => async () => {
    const owner = await factory();
    return { ...owner, tails: [...(owner.tails ?? []), input.tail] };
  };
  return {
    loader: input.loader,
    facets: input.facets,
    code: {
      kernel: tailed(input.code.kernel),
      cli: tailed(input.code.cli),
      computer: tailed(input.code.computer),
      sdk: tailed(input.code.sdk),
    },
    versions: input.versions,
  };
}
