import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { isNodeErrorCode } from "./guards.ts";
import { assertPublishedBuiltinCoverage } from "./nodeBuiltinGate.ts";
import { rebundleClaudeRelease } from "../claude-bunfs/rebundle.ts";
import type { ReleaseOmissionOptions } from "../claude-bunfs/release-omission.ts";
import { readClaudeOmission } from "./claudeOmission.ts";
import type { BuiltinCapabilityManifest } from "../claude-bunfs/builtin-gap.ts";
import {
  freezeArtifact,
  parseOfficialReleaseIdentity,
  type OfficialReleaseIdentity,
} from "./releaseIdentity.ts";
import { object, sha256 } from "./fixture.ts";
import { assertClaudeBuildInputs, createClaudeBuildInputs } from "./claudeInputs.ts";
import { assertSourcesUnchanged, freezeSources } from "./sourceFreeze.ts";
import {
  pathExists,
  publishClaudeBuildOutput,
  type BuildClaudeReleaseResult,
  type ClaudeArtifactEnvelope,
} from "./claudeBuildOutput.ts";
import { validateClaudeReleaseIdentity, verifyClaudeExtraction } from "./claudeReleaseIdentity.ts";

export type { BuildClaudeReleaseResult, ClaudeArtifactEnvelope } from "./claudeBuildOutput.ts";

export interface BuildClaudeReleaseOptions {
  readonly identity: OfficialReleaseIdentity;
  readonly extracted: string;
  readonly output: string;
  readonly result?: string;
  readonly repository?: string;
  readonly capabilities?: BuiltinCapabilityManifest;
  readonly omission?: ReleaseOmissionOptions;
}

function stringList(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item))
    throw new Error(code);
  return [...value];
}

/** Decode an optional runtime snapshot before passing it to the release scanner. */
export function parseBuiltinCapabilityManifest(value: unknown): BuiltinCapabilityManifest {
  const input = object(value);
  const rawBunApis = object(input.bunApis);
  const statuses = new Set(["implemented", "host", "headless", "unsupported"]);
  const bunApis = Object.fromEntries(
    Object.entries(rawBunApis).map(([name, status]) => {
      if (!name || typeof status !== "string" || !statuses.has(status))
        throw new Error("CLAUDE_CAPABILITY_BUN_API_INVALID");
      return [name, status];
    }),
  ) as BuiltinCapabilityManifest["bunApis"];
  const rawBuiltins = object(input.nodeBuiltins);
  const nodeBuiltins = Object.fromEntries(
    Object.entries(rawBuiltins).map(([name, value]) => {
      const capability = object(value);
      const booleans = [
        capability.available,
        capability.defaultImport,
        capability.namespaceImport,
        capability.commonJs,
      ];
      if (!name || booleans.some((item) => typeof item !== "boolean"))
        throw new Error("CLAUDE_CAPABILITY_NODE_BUILTIN_INVALID");
      return [
        name,
        {
          available: capability.available as boolean,
          defaultImport: capability.defaultImport as boolean,
          defaultMembers: stringList(
            capability.defaultMembers,
            "CLAUDE_CAPABILITY_NODE_BUILTIN_INVALID",
          ),
          namespaceImport: capability.namespaceImport as boolean,
          namedExports: stringList(
            capability.namedExports,
            "CLAUDE_CAPABILITY_NODE_BUILTIN_INVALID",
          ),
          commonJs: capability.commonJs as boolean,
          commonJsMembers: stringList(
            capability.commonJsMembers,
            "CLAUDE_CAPABILITY_NODE_BUILTIN_INVALID",
          ),
        },
      ];
    }),
  ) as BuiltinCapabilityManifest["nodeBuiltins"];
  const optionalPaths = (name: string) =>
    input[name] === undefined
      ? undefined
      : stringList(input[name], "CLAUDE_CAPABILITY_PATHS_INVALID");
  const providedHostPaths = optionalPaths("providedHostPaths");
  const featureOffPaths = optionalPaths("featureOffPaths");
  const escalationPaths = optionalPaths("escalationPaths");
  return {
    bunApis,
    nodeBuiltins,
    ...(input.nodeBuiltinModules === undefined
      ? {}
      : {
          nodeBuiltinModules: stringList(
            input.nodeBuiltinModules,
            "CLAUDE_CAPABILITY_BUILTIN_MODULES_INVALID",
          ),
        }),
    ...(providedHostPaths === undefined ? {} : { providedHostPaths }),
    ...(featureOffPaths === undefined ? {} : { featureOffPaths }),
    ...(escalationPaths === undefined ? {} : { escalationPaths }),
  };
}

function emptyCapabilities(inputs: Awaited<ReturnType<typeof createClaudeBuildInputs>>) {
  return {
    bunApis: inputs.bunApis as BuiltinCapabilityManifest["bunApis"],
    nodeBuiltinModules: inputs.nodeBuiltinModules,
    nodeBuiltins: {},
  } satisfies BuiltinCapabilityManifest;
}

async function loadReleaseScanner(repository: string) {
  const source = NodePath.join(repository, "scripts/claude-bunfs/scan-release.ts");
  const bytes = await NodeFSP.readFile(source);
  const scanner = (await import(NodeURL.pathToFileURL(source).href)) as {
    scanExtractedRelease: typeof import("../claude-bunfs/scan-release.ts").scanExtractedRelease;
  };
  return {
    scanExtractedRelease: scanner.scanExtractedRelease,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

export async function buildClaudeRelease(
  options: BuildClaudeReleaseOptions,
): Promise<BuildClaudeReleaseResult> {
  const version = options.identity.version;
  const platform = options.identity.binary?.platform ?? "";
  const repository = await NodeFSP.realpath(
    options.repository ?? NodePath.resolve(import.meta.dirname, "../.."),
  );
  const extracted = await NodeFSP.realpath(options.extracted);
  const output = NodePath.resolve(options.output);
  const provenancePath = `${output}.provenance.json`;
  const resultPath = options.result ? NodePath.resolve(options.result) : undefined;
  if (!version || !platform) throw new Error("CLAUDE_RELEASE_IDENTITY_REQUIRED");
  const binary = validateClaudeReleaseIdentity(options.identity, platform);
  if (
    resultPath &&
    (resultPath === output ||
      resultPath === provenancePath ||
      resultPath.startsWith(`${output}${NodePath.sep}`))
  )
    throw new Error("CLAUDE_BUILD_RESULT_PATH_INVALID");
  if (await pathExists(output)) throw new Error("CLAUDE_BUILD_OUTPUT_EXISTS");
  if (await pathExists(provenancePath)) throw new Error("CLAUDE_BUILD_PROVENANCE_EXISTS");
  if (resultPath && (await pathExists(resultPath))) throw new Error("CLAUDE_BUILD_RESULT_EXISTS");

  const sourceBefore = await freezeSources(repository);
  const inputs = await createClaudeBuildInputs(repository);
  assertClaudeBuildInputs(inputs);
  const releaseEvidence = await verifyClaudeExtraction(extracted, options.identity, platform);
  await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
  const stage = await NodeFSP.mkdtemp(`${output}.build-`);
  try {
    const bundlePath = NodePath.join(stage, "bundle");
    const built = await rebundleClaudeRelease({
      extracted,
      output: bundlePath,
      version,
      platform,
      layerModules: inputs.layerModules,
      environmentPackageModules: inputs.environmentPackageModules,
      requireBootstrap: inputs.requireBootstrap,
      deferInitialization: true,
      partitionHooksWorker: true,
      ...(options.omission ? { omission: options.omission } : {}),
    });
    if (
      built.manifest.mainExport !== "launch" ||
      built.manifest.embeddedEntrypointExport !== "launch"
    )
      throw new Error("CLAUDE_RELEASE_DEFERRED_ENTRY_REQUIRED");
    if (built.manifest.requiredHostModules.length)
      throw new Error(
        `CLAUDE_RELEASE_HOST_MODULES_UNBOUND: ${built.manifest.requiredHostModules.join(",")}`,
      );
    if (
      built.manifest.release.version !== version ||
      built.manifest.release.platform !== platform ||
      built.manifest.release.binarySha256 !== binary.sha256
    )
      throw new Error("CLAUDE_REBUNDLE_RELEASE_MISMATCH");

    const frozenArtifact = await freezeArtifact(bundlePath);
    if (frozenArtifact.sha256 !== built.artifactSha256)
      throw new Error("CLAUDE_REBUNDLE_MANIFEST_HASH_MISMATCH");
    const artifact: ClaudeArtifactEnvelope = {
      manifest: "manifest.json",
      moduleMap: "module-map.json",
      sha256: frozenArtifact.sha256,
      bytes: built.manifest.bytes,
    };
    const scanner = await loadReleaseScanner(repository);
    const scan = await scanner.scanExtractedRelease({
      extracted,
      version,
      platform,
      bunVersion: null,
      capabilities: options.capabilities ?? emptyCapabilities(inputs),
    });
    const builtinCoverage = await assertPublishedBuiltinCoverage(bundlePath);
    const sourceAfter = await freezeSources(repository);
    assertSourcesUnchanged(sourceBefore, sourceAfter);
    const provenance = {
      schemaVersion: 1,
      release: {
        provider: options.identity.provider,
        version,
        platform,
        upstreamIdentity: options.identity.upstreamIdentity,
        identitySha256: options.identity.sha256,
        binarySha256: binary.sha256,
        binaryBytes: binary.bytes,
        officialManifestSha256: releaseEvidence.officialManifestSha256,
      },
      artifact,
      artifactFiles: frozenArtifact.files,
      extraction: {
        manifestSha256: releaseEvidence.extractionManifestSha256,
        officialReleaseRecordSha256: releaseEvidence.officialReleaseRecordSha256,
      },
      source: sourceAfter,
      releaseScanner: {
        bytes: scanner.bytes,
        sha256: scanner.sha256,
        execution: "native-node",
      },
      buildInputs: inputs.provenance,
      builtinCoverage,
      capabilities: options.capabilities
        ? { status: "supplied", sha256: sha256(JSON.stringify(options.capabilities)) }
        : { status: "missing" },
      build: {
        node: process.versions.node,
        esbuild: inputs.provenance.packageMapRebinding.bundlerVersion,
        ajv: built.ajv,
      },
      scope:
        "Build and source scan only. Local, deployed, update and selected-runtime capability proofs remain separate.",
    } satisfies Record<string, unknown>;
    return await publishClaudeBuildOutput({
      report: scan.report,
      bunCapabilityGaps: scan.inventory.bunCapabilityGaps,
      hasCapabilitySnapshot: Boolean(options.capabilities),
      artifact,
      provenance,
      stage,
      bundlePath,
      output,
      provenancePath,
      ...(resultPath ? { resultPath } : {}),
    });
  } catch (error) {
    const rejected = `${output}.rejected-${NodeCrypto.randomUUID()}`;
    await NodeFSP.rename(stage, rejected).catch(async () => {
      await NodeFSP.rm(stage, { recursive: true, force: true });
    });
    throw error;
  }
}

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      identity: { type: "string" },
      extracted: { type: "string" },
      output: { type: "string" },
      result: { type: "string" },
      capabilities: { type: "string" },
      "omit-unreachable": { type: "boolean" },
      "coverage-corpus": { type: "string" },
      "host-configuration": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  const identityPath = values.identity;
  const extracted = values.extracted;
  const output = values.output;
  const result = values.result;
  if (!identityPath || !extracted || !output || !result)
    throw new Error(
      "Usage: buildClaude.ts --identity <identity.json> --extracted <directory> --output <new-directory> --result <new-result.json> [--capabilities <runtime-capabilities.json>] [--omit-unreachable] [--coverage-corpus <corpus.json>] [--host-configuration product|qualification]",
    );
  const identity = parseOfficialReleaseIdentity(
    JSON.parse(await NodeFSP.readFile(identityPath, "utf8")),
  );
  const capabilities = values.capabilities
    ? parseBuiltinCapabilityManifest(
        JSON.parse(await NodeFSP.readFile(values.capabilities, "utf8")),
      )
    : undefined;
  const omission = await readClaudeOmission({
    enabled: Boolean(values["omit-unreachable"]),
    ...(values["coverage-corpus"] ? { corpusPath: values["coverage-corpus"] } : {}),
    ...(values["host-configuration"] ? { configurationName: values["host-configuration"] } : {}),
  });
  await buildClaudeRelease({
    identity,
    extracted,
    output,
    result,
    ...(capabilities ? { capabilities } : {}),
    ...(omission ? { omission } : {}),
  });
}

const entryPath = process.argv[1]
  ? await NodeFSP.realpath(process.argv[1]).catch((error: unknown) => {
      if (isNodeErrorCode(error, "ENOENT") || isNodeErrorCode(error, "ENOTDIR")) return undefined;
      throw error;
    })
  : undefined;
const modulePath = await NodeFSP.realpath(NodeURL.fileURLToPath(import.meta.url));
if (entryPath && entryPath === modulePath) await main();
