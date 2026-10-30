import * as NodeFSP from "node:fs/promises";
import * as Schema from "effect/Schema";
import { readBuildLedger } from "./readBuildLedger.ts";
import { artifactDirectorySource } from "./prepareArtifact.ts";
import { writeClaudeReleaseVariantCatalog } from "./claudeReleaseVariants.ts";
import { openHarnessReleaseArtifact } from "../../src/harnessReleases/HarnessReleaseArtifact.ts";
import { snapshotDeploymentLedger } from "../../src/harnessReleases/HarnessReleaseDeployment.ts";
import { directoryHarnessArtifactStore, publishHarnessArtifact } from "./publishArtifact.ts";
import { writeReleaseDeploymentAssets } from "./deploymentAssets.ts";

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const decodeBaselinePin = Schema.decodeUnknownSync(
  Schema.Struct({
    identity: Schema.Struct({
      artifactRef: Schema.String,
      artifactHash: Sha256,
      sourceIdentity: Sha256,
    }),
    preparedModules: Schema.Record(
      Schema.String,
      Schema.Struct({
        component: Schema.Literals(["codex", "cli", "sdk"]),
        name: Schema.String,
        path: Schema.String,
        type: Schema.Literals(["js", "cjs", "text", "wasm"]),
        bytes: Schema.Int.check(
          Schema.isGreaterThanOrEqualTo(0),
          Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
        ),
        sha256: Sha256,
      }),
    ),
  }),
  { onExcessProperty: "error", reportInput: false },
);

/** Publication consumes existing qualified ledger records; it never registers or promotes a pair. */
export interface PublishClaudeVariantsInput {
  readonly assetsDirectory: string;
  readonly ledger: string;
  readonly projectId?: string;
  readonly baselineReleaseId: string;
  readonly hooksReleaseId: string;
  readonly baselineDirectory: string;
  readonly hooksDirectory: string;
  readonly baselinePin: string;
  readonly trustedComputer: { readonly sourceIdentity: string; readonly manifestSha256: string };
  readonly maxPreparedModuleBytes: number;
  readonly output: string;
  readonly expectedCliManifestSha256?: string;
}

export async function publishClaudeVariants(input: PublishClaudeVariantsInput) {
  const baselinePin = decodeBaselinePin(
    JSON.parse(await NodeFSP.readFile(input.baselinePin, "utf8")),
  );
  return readBuildLedger(input.ledger, input.projectId, async (ledger) => {
    const baseline = ledger.getArtifact("claude-code", input.baselineReleaseId);
    const hooks = ledger.getArtifact("claude-code", input.hooksReleaseId);
    if (!baseline || !hooks) throw new Error("CLAUDE_VARIANTS_LEDGER_RECORD_MISSING");
    const baselineSource = artifactDirectorySource(input.baselineDirectory);
    const hooksSource = artifactDirectorySource(input.hooksDirectory);
    if (input.expectedCliManifestSha256 !== undefined) {
      const prepared = await openHarnessReleaseArtifact(
        {
          artifactRef: hooks.artifactRef,
          artifactHash: hooks.artifactHash,
          sourceIdentity: hooks.sourceIdentity,
        },
        hooksSource,
      );
      const cliManifest = prepared.manifest.components.cli?.manifest;
      if (
        !cliManifest ||
        prepared.manifest.files[cliManifest]?.sha256 !== input.expectedCliManifestSha256
      )
        throw new Error("CLAUDE_VARIANTS_BUILD_MISMATCH");
    }
    const catalog = await writeClaudeReleaseVariantCatalog({
      catalog: {
        baseline: { variant: "baseline", fullArtifact: baseline },
        hooks: { variant: "hooks", fullArtifact: hooks },
      },
      ledger,
      source: {
        read(ref, path) {
          const source =
            ref === baseline.artifactRef
              ? baselineSource
              : ref === hooks.artifactRef
                ? hooksSource
                : undefined;
          if (!source) throw new Error("CLAUDE_VARIANTS_ARTIFACT_REF_MISMATCH");
          return source.read(ref, path);
        },
      },
      baselinePin,
      trustedComputer: input.trustedComputer,
      maxPreparedModuleBytes: input.maxPreparedModuleBytes,
      output: input.output,
    });
    const projectId = input.projectId ?? "signalbox";
    const store = directoryHarnessArtifactStore(input.assetsDirectory);
    const assets = [];
    for (const [artifact, directory] of [
      [baseline, input.baselineDirectory],
      [hooks, input.hooksDirectory],
    ] as const) {
      const published = await publishHarnessArtifact(artifact, directory, { projectId, store });
      assets.push(published.assetIndex);
    }
    // Publication does I/O. Capture current proofs again before embedding a selectable catalog.
    const embeddedLedger = snapshotDeploymentLedger(ledger, [baseline, hooks]);
    const deployment = await writeReleaseDeploymentAssets({
      directory: input.assetsDirectory,
      deployment: {
        schemaVersion: 1,
        purpose: "release",
        projectId,
        claudeVariants: catalog,
        ledger: embeddedLedger,
        assets,
      },
    });
    await NodeFSP.writeFile(
      `${input.output}.deployment.json`,
      `${JSON.stringify(deployment, null, 2)}\n`,
      { flag: "wx" },
    );
    return catalog;
  });
}
