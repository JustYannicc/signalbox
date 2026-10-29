import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import type { InstalledClaudeSdkGraph } from "./claudeSdkDependencies.ts";
import type { OfficialReleaseIdentity } from "./releaseIdentity.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const SDK_NAME = "@anthropic-ai/claude-agent-sdk";

export interface ClaudeSdkSourcePayload {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ClaudeSdkNpmSource {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly tarballSha256: string;
  readonly tarballBytes: number;
}

export interface ClaudeSdkBundle {
  readonly manifest: {
    readonly release: { readonly tarballSha256: string };
    readonly requiredHostModules: ReadonlyArray<string>;
  };
  readonly manifestSha256: string;
  readonly sourceFiles: ReadonlyArray<ClaudeSdkSourcePayload>;
  readonly npmSources: ReadonlyArray<ClaudeSdkNpmSource>;
  readonly esbuildVersion: string;
  readonly inputCount: number;
  readonly createRequireRewrites: number;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function text(value: unknown, code: string) {
  if (typeof value !== "string" || !value) throw new Error(code);
  return value;
}

function sha256(value: unknown, code: string) {
  const result = text(value, code);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error(code);
  return result;
}

function count(value: unknown, code: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function strings(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item))
    throw new Error(code);
  return value;
}

function packagePath(value: unknown) {
  const path = text(value, "CLAUDE_SDK_BUNDLE_RESULT_INVALID");
  if (
    NodePath.isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("CLAUDE_SDK_BUNDLE_RESULT_PATH_INVALID");
  return path;
}

function decodeSourcePayload(value: unknown): ClaudeSdkSourcePayload {
  const input = record(value, "CLAUDE_SDK_BUNDLE_RESULT_INVALID");
  return {
    packageName: text(input.packageName, "CLAUDE_SDK_BUNDLE_RESULT_INVALID"),
    packageVersion: text(input.packageVersion, "CLAUDE_SDK_BUNDLE_RESULT_INVALID"),
    path: packagePath(input.path),
    bytes: count(input.bytes, "CLAUDE_SDK_BUNDLE_RESULT_INVALID"),
    sha256: sha256(input.sha256, "CLAUDE_SDK_BUNDLE_RESULT_INVALID"),
  };
}

function decodeNpmSource(value: unknown): ClaudeSdkNpmSource {
  const input = record(value, "CLAUDE_SDK_BUNDLE_RESULT_INVALID");
  const integrity = text(input.integrity, "CLAUDE_SDK_BUNDLE_RESULT_INVALID");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity))
    throw new Error("CLAUDE_SDK_BUNDLE_RESULT_INVALID");
  return {
    name: text(input.name, "CLAUDE_SDK_BUNDLE_RESULT_INVALID"),
    version: text(input.version, "CLAUDE_SDK_BUNDLE_RESULT_INVALID"),
    integrity,
    tarballSha256: sha256(input.tarballSha256, "CLAUDE_SDK_BUNDLE_RESULT_INVALID"),
    tarballBytes: count(input.tarballBytes, "CLAUDE_SDK_BUNDLE_RESULT_INVALID"),
  };
}

function decodeBundleResult(
  value: unknown,
  manifestBytes: Uint8Array,
  identity: OfficialReleaseIdentity,
): ClaudeSdkBundle {
  const result = record(value, "CLAUDE_SDK_BUNDLE_RESULT_INVALID");
  const manifest = record(
    JSON.parse(Buffer.from(manifestBytes).toString("utf8")),
    "CLAUDE_SDK_MANIFEST_INVALID",
  );
  const release = record(manifest.release, "CLAUDE_SDK_MANIFEST_INVALID");
  if (
    manifest.schemaVersion !== 1 ||
    release.provider !== "agent-sdk" ||
    release.name !== SDK_NAME ||
    release.version !== identity.version ||
    release.integrity !== identity.npm?.integrity ||
    manifest.mainModule !== "sdk.mjs" ||
    manifest.initializeExport !== "initialize"
  )
    throw new Error("CLAUDE_SDK_MANIFEST_RELEASE_MISMATCH");
  const modules = record(manifest.modules, "CLAUDE_SDK_MANIFEST_INVALID");
  const main = record(modules["sdk.mjs"], "CLAUDE_SDK_MANIFEST_INVALID");
  const moduleMap = record(manifest.moduleMap, "CLAUDE_SDK_MANIFEST_INVALID");
  if (
    main.path !== "sdk.mjs" ||
    main.type !== "js" ||
    moduleMap.path !== "module-map.json" ||
    !/^[a-f0-9]{64}$/u.test(String(moduleMap.sha256))
  )
    throw new Error("CLAUDE_SDK_MANIFEST_MODULES_INVALID");

  if (!Array.isArray(result.sourceFiles) || !Array.isArray(result.npmSources))
    throw new Error("CLAUDE_SDK_BUNDLE_RESULT_INVALID");
  const summaryHash = sha256(result.manifestSha256, "CLAUDE_SDK_BUNDLE_RESULT_INVALID");
  const actualHash = NodeCrypto.createHash("sha256").update(manifestBytes).digest("hex");
  if (summaryHash !== actualHash) throw new Error("CLAUDE_SDK_BUNDLE_RESULT_MISMATCH");
  return {
    manifest: {
      release: {
        tarballSha256: sha256(release.tarballSha256, "CLAUDE_SDK_MANIFEST_INVALID"),
      },
      requiredHostModules: strings(manifest.requiredHostModules, "CLAUDE_SDK_MANIFEST_INVALID"),
    },
    manifestSha256: summaryHash,
    sourceFiles: result.sourceFiles.map(decodeSourcePayload),
    npmSources: result.npmSources.map(decodeNpmSource),
    esbuildVersion: text(result.esbuildVersion, "CLAUDE_SDK_BUNDLE_RESULT_INVALID"),
    inputCount: count(result.inputCount, "CLAUDE_SDK_BUNDLE_RESULT_INVALID"),
    createRequireRewrites: count(result.createRequireRewrites, "CLAUDE_SDK_BUNDLE_RESULT_INVALID"),
  };
}

/** Run the cloud-owned bundler through its CLI so scripts never import app internals. */
export async function buildClaudeSdkBundle(input: {
  readonly repository: string;
  readonly candidate: string;
  readonly workspace: string;
  readonly identity: OfficialReleaseIdentity;
  readonly graph: InstalledClaudeSdkGraph;
}): Promise<ClaudeSdkBundle> {
  const requestPath = NodePath.join(input.workspace, "sdk-build-request.json");
  const request = {
    source: input.graph.sdk,
    dependencies: input.graph.dependencies,
    nodeModulesRoot: NodePath.join(input.workspace, "node_modules"),
    output: input.candidate,
  };
  await NodeFSP.writeFile(requestPath, `${JSON.stringify(request)}\n`, { flag: "wx" });
  const cli = NodePath.join(
    input.repository,
    "apps/cloud/infra/harnessReleases/buildClaudeSdkBundle.ts",
  );
  let stdout: string;
  try {
    const result = await execute(process.execPath, [cli, "--input", requestPath], {
      cwd: input.repository,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });
    stdout = result.stdout;
  } catch (cause) {
    throw new Error("CLAUDE_SDK_BUNDLE_BUILD_FAILED", { cause });
  }
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("CLAUDE_SDK_BUNDLE_RESULT_INVALID");
  }
  const manifestBytes = await NodeFSP.readFile(NodePath.join(input.candidate, "manifest.json"));
  return decodeBundleResult(result, manifestBytes, input.identity);
}
