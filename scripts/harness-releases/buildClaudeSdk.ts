import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { assertPublishedBuiltinCoverage } from "./nodeBuiltinGate.ts";
import {
  parseNpmPackageMetadata,
  selectNpmReleases,
  type ReleaseDiscoveryHttp,
} from "./discovery.ts";
import {
  freezeArtifact,
  resolveOfficialRelease,
  type OfficialReleaseIdentity,
} from "./releaseIdentity.ts";
import { assertSourcesUnchanged, freezeSources } from "./sourceFreeze.ts";
import { installClaudeSdkGraph, type InstalledClaudeSdkGraph } from "./claudeSdkDependencies.ts";
import { buildClaudeSdkBundle } from "./claudeSdkBundleCli.ts";
import { pathExists, preserveRejectedClaudeSdkCandidate } from "./claudeSdkCandidate.ts";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const SDK_PROVIDER = "claude-agent-sdk";
const defaultHttp: ReleaseDiscoveryHttp = (url) =>
  fetch(url, { signal: AbortSignal.timeout(60_000) });
const digest = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export interface BuildClaudeSdkOptions {
  readonly output: string;
  readonly version?: string;
  readonly repository?: string;
  readonly http?: ReleaseDiscoveryHttp;
}

export interface BuildClaudeSdkResult {
  readonly status: "prepared";
  readonly provider: typeof SDK_PROVIDER;
  readonly version: string;
  readonly output: string;
  readonly manifestSha256: string;
  readonly provenanceSha256: string;
  readonly componentSha256: string;
  readonly builtinGuard: "passed";
}

/** Use npm's current stable SDK tag, then freeze its exact official npm identity. */
export async function resolveClaudeSdkReleaseIdentity(
  version?: string,
  http: ReleaseDiscoveryHttp = defaultHttp,
): Promise<OfficialReleaseIdentity> {
  let selectedVersion = version;
  if (!selectedVersion) {
    const response = await http(`https://registry.npmjs.org/${SDK_PACKAGE}`);
    if (!response.ok) throw new Error(`CLAUDE_SDK_DISCOVERY_HTTP_${response.status}`);
    const metadata = parseNpmPackageMetadata(SDK_PACKAGE, await response.json());
    selectedVersion = selectNpmReleases(metadata).find(
      (release) => release.selection === "current",
    )?.version;
    if (!selectedVersion) throw new Error("CLAUDE_SDK_CURRENT_STABLE_RELEASE_MISSING");
  }
  const identity = await resolveOfficialRelease(SDK_PROVIDER, selectedVersion, http);
  if (
    identity.provider !== SDK_PROVIDER ||
    identity.version !== selectedVersion ||
    identity.npm?.packageName !== SDK_PACKAGE
  )
    throw new Error("CLAUDE_SDK_RELEASE_IDENTITY_MISMATCH");
  return identity;
}

/** Produce a current official SDK component; qualification and publication remain separate. */
export async function buildClaudeSdk(
  options: BuildClaudeSdkOptions,
): Promise<BuildClaudeSdkResult> {
  const repository = await NodeFSP.realpath(
    options.repository ?? NodePath.resolve(import.meta.dirname, "../.."),
  );
  const output = NodePath.resolve(options.output);
  if (await pathExists(output)) throw new Error("CLAUDE_SDK_OUTPUT_EXISTS");
  const candidate = `${output}.candidate-${NodeCrypto.randomUUID()}`;
  let workspace: string | undefined;
  let preserveWorkspace = false;
  let resolvedVersion = options.version;
  let identity: OfficialReleaseIdentity | undefined;
  let graph: InstalledClaudeSdkGraph | undefined;
  let sourceFreezeBefore: unknown;
  let stage = "source-freeze";
  try {
    const sourceBefore = await freezeSources(repository);
    sourceFreezeBefore = sourceBefore;
    stage = "release-identity";
    identity = await resolveClaudeSdkReleaseIdentity(options.version, options.http);
    resolvedVersion = identity.version;
    stage = "dependency-install";
    workspace = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "signalbox-claude-sdk-"));
    graph = await installClaudeSdkGraph(identity, workspace);
    stage = "bundle";
    const built = await buildClaudeSdkBundle({
      repository,
      candidate,
      workspace,
      identity,
      graph,
    });
    stage = "builtin-guard";
    const firstCoverage = await assertPublishedBuiltinCoverage(candidate);
    stage = "source-freeze-recheck";
    const sourceAfterBuild = await freezeSources(repository);
    assertSourcesUnchanged(sourceBefore, sourceAfterBuild);
    stage = "provenance";
    const provenance = {
      schemaVersion: 1,
      status: "prepared",
      release: {
        provider: identity.provider,
        version: identity.version,
        upstreamIdentity: identity.upstreamIdentity,
        identitySha256: identity.sha256,
        packageName: identity.npm?.packageName,
        integrity: identity.npm?.integrity,
        tarball: identity.npm?.tarball,
        tarballSha256: built.manifest.release.tarballSha256,
      },
      dependencyGraph: {
        lockfileSha256: graph.lockfileSha256,
        npmVersion: graph.npmVersion,
        packages: graph.dependencyPins,
      },
      sourcePayloads: built.sourceFiles,
      npmSources: built.npmSources,
      sourceFreeze: sourceAfterBuild,
      build: {
        nodeVersion: process.versions.node,
        esbuildVersion: built.esbuildVersion,
        bundledInputCount: built.inputCount,
        createRequireRewrites: built.createRequireRewrites,
      },
      builtinGuard: {
        status: "passed",
        artifactSha256: firstCoverage.artifact.sha256,
        requiredHostModules: built.manifest.requiredHostModules,
      },
      scope: "SDK component preparation only; runtime and release qualification remain separate.",
    };
    const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`);
    await NodeFSP.writeFile(NodePath.join(candidate, "provenance.json"), provenanceBytes, {
      flag: "wx",
    });

    stage = "final-acceptance";
    const finalCoverage = await assertPublishedBuiltinCoverage(candidate);
    const sourceAtAcceptance = await freezeSources(repository);
    assertSourcesUnchanged(sourceBefore, sourceAtAcceptance);
    const artifact = await freezeArtifact(candidate);
    const savedProvenance = await NodeFSP.readFile(NodePath.join(candidate, "provenance.json"));
    if (
      digest(savedProvenance) !== digest(provenanceBytes) ||
      finalCoverage.artifact.sha256 !== artifact.sha256 ||
      !finalCoverage.artifact.files.some((file) => file.path === "sdk.mjs") ||
      !finalCoverage.artifact.files.some((file) => file.path === "module-map.json")
    )
      throw new Error("CLAUDE_SDK_FINAL_ARTIFACT_INCOMPLETE");
    await NodeFSP.rename(candidate, output);
    return {
      status: "prepared",
      provider: SDK_PROVIDER,
      version: identity.version,
      output,
      manifestSha256: built.manifestSha256,
      provenanceSha256: digest(provenanceBytes),
      componentSha256: artifact.sha256,
      builtinGuard: "passed",
    };
  } catch (error) {
    try {
      await preserveRejectedClaudeSdkCandidate(candidate, output, resolvedVersion, error, {
        stage,
        ...(workspace ? { workspace } : {}),
        ...(identity
          ? {
              releaseIdentity: {
                provider: identity.provider,
                version: identity.version,
                upstreamIdentity: identity.upstreamIdentity,
                sha256: identity.sha256,
                npm: identity.npm
                  ? {
                      packageName: identity.npm.packageName,
                      integrity: identity.npm.integrity,
                      tarball: identity.npm.tarball,
                    }
                  : null,
              },
            }
          : {}),
        ...(graph
          ? {
              dependencyGraph: {
                npmVersion: graph.npmVersion,
                lockfileSha256: graph.lockfileSha256,
                packages: graph.dependencyPins,
              },
            }
          : {}),
        ...(sourceFreezeBefore ? { sourceFreeze: sourceFreezeBefore } : {}),
      });
    } catch (preservationError) {
      preserveWorkspace = workspace !== undefined;
      throw new AggregateError(
        [error, preservationError],
        "CLAUDE_SDK_REJECTION_PRESERVATION_FAILED",
        { cause: preservationError },
      );
    }
    throw error;
  } finally {
    if (workspace && !preserveWorkspace)
      await NodeFSP.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      version: { type: "string" },
      output: { type: "string" },
      repository: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  if (!values.output)
    throw new Error(
      "Usage: node scripts/harness-releases/buildClaudeSdk.ts --output <new-directory> " +
        "[--version <exact-stable-version>] [--repository <repo-root>]",
    );
  const result = await buildClaudeSdk({
    output: values.output,
    ...(values.version ? { version: values.version } : {}),
    ...(values.repository ? { repository: values.repository } : {}),
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: result.status,
        provider: result.provider,
        version: result.version,
        manifestSha256: result.manifestSha256,
        provenanceSha256: result.provenanceSha256,
        componentSha256: result.componentSha256,
        builtinGuard: result.builtinGuard,
      },
      null,
      2,
    )}\n`,
  );
}

const entryPath = process.argv[1]
  ? await NodeFSP.realpath(process.argv[1]).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        return undefined;
      throw error;
    })
  : undefined;
if (entryPath && entryPath === import.meta.filename) await main();
