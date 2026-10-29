import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { object } from "./fixture.ts";
import type { ReleaseContext } from "./runner.ts";

export interface ClaudePairBuildInputs {
  readonly programs: string;
  readonly machineInventory: string;
  readonly maxPreparedModuleBytes: number;
  readonly sdkVersion?: string;
  readonly capabilities?: string;
  readonly coverageCorpus?: string;
}

/** Both variants use one extraction, one SDK build and one source-bound Computer identity. */
export async function buildClaudePairComponents(
  context: ReleaseContext,
  extracted: string,
  input: ClaudePairBuildInputs,
  node: (context: ReleaseContext, args: string[]) => Promise<void>,
) {
  const sdk = NodePath.join(context.output, "claude-sdk");
  await node(context, [
    "scripts/harness-releases/buildClaudeSdk.ts",
    "--output",
    sdk,
    ...(input.sdkVersion ? ["--version", input.sdkVersion] : []),
  ]);
  const sdkManifest = object(
    JSON.parse(await NodeFSP.readFile(NodePath.join(sdk, "manifest.json"), "utf8")),
  );
  const sdkRelease = object(sdkManifest.release);
  if (
    sdkRelease.provider !== "agent-sdk" ||
    (input.sdkVersion && sdkRelease.version !== input.sdkVersion)
  )
    throw new Error("CLAUDE_PAIR_SDK_RELEASE_MISMATCH");

  for (const variant of ["baseline", "hooks"] as const) {
    await node(context, [
      "scripts/harness-releases/buildClaude.ts",
      "--variant",
      variant,
      "--identity",
      NodePath.join(context.output, "identity.json"),
      "--extracted",
      extracted,
      "--output",
      NodePath.join(context.output, `claude-${variant}`),
      "--result",
      NodePath.join(
        context.output,
        variant === "hooks" ? "claude-build.json" : "claude-build-baseline.json",
      ),
      ...(input.capabilities ? ["--capabilities", input.capabilities] : []),
      ...(input.coverageCorpus
        ? [
            "--omit-unreachable",
            "--coverage-corpus",
            input.coverageCorpus,
            "--host-configuration",
            "product",
          ]
        : []),
    ]);
  }
  const output = NodePath.join(context.output, "claude-pair");
  await node(context, [
    "apps/cloud/infra/harnessReleases/prepareClaudePairCandidateCli.ts",
    "--baseline-cli",
    NodePath.join(context.output, "claude-baseline"),
    "--hooks-cli",
    NodePath.join(context.output, "claude-hooks"),
    "--sdk",
    sdk,
    "--programs",
    input.programs,
    "--machine-inventory",
    input.machineInventory,
    "--max-prepared-module-bytes",
    String(input.maxPreparedModuleBytes),
    "--output",
    output,
  ]);
  return { artifact: NodePath.join(output, "hooks"), extracted };
}
