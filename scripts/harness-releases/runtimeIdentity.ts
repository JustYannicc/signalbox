import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { object, sha256 } from "./fixture.ts";

interface NativeWorkerdIdentity {
  readonly compatibilityDate: string;
  readonly default: string;
  readonly version: string;
}

export interface LocalWorkerdIdentity {
  readonly schemaVersion: 1;
  readonly wrangler: { readonly packagePath: string; readonly version: string };
  readonly workerd: {
    readonly native: NativeWorkerdIdentity;
    readonly binary: { readonly path: string; readonly bytes: number; readonly sha256: string };
  };
  readonly config: { readonly path: string; readonly bytes: number; readonly sha256: string };
  readonly hostInventory: {
    readonly platform: string;
    readonly architecture: string;
    readonly osRelease: string;
    readonly nodeVersion: string;
    readonly nodeAbi: string;
    readonly logicalCpuCount: number;
    readonly cpuModels: ReadonlyArray<string>;
    readonly totalMemoryBytes: number;
  };
}

function packageVersion(value: unknown, code: string) {
  const version = object(value).version;
  if (typeof version !== "string" || !version) throw new Error(code);
  return version;
}

function nativeWorkerdIdentity(value: unknown): NativeWorkerdIdentity {
  const native = object(value);
  if (
    typeof native.compatibilityDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(native.compatibilityDate) ||
    typeof native.default !== "string" ||
    !NodePath.isAbsolute(native.default) ||
    typeof native.version !== "string" ||
    !native.version
  )
    throw new Error("RELEASE_WORKERD_IDENTITY_INVALID");
  return {
    compatibilityDate: native.compatibilityDate,
    default: native.default,
    version: native.version,
  };
}

/** Resolve and freeze the exact native binary Wrangler's installed Miniflare will use. */
export async function captureLocalWorkerdIdentity(
  repository: string,
): Promise<LocalWorkerdIdentity> {
  const cloudPackage = NodePath.join(repository, "apps/cloud/package.json");
  const cloudRequire = NodeModule.createRequire(cloudPackage);
  const wranglerPackagePath = await NodeFSP.realpath(cloudRequire.resolve("wrangler/package.json"));
  const wranglerRequire = NodeModule.createRequire(wranglerPackagePath);
  const wranglerPackage = object(JSON.parse(await NodeFSP.readFile(wranglerPackagePath, "utf8")));
  const native = nativeWorkerdIdentity(wranglerRequire("workerd"));
  const binaryPath = await NodeFSP.realpath(native.default);
  const binaryStat = await NodeFSP.stat(binaryPath);
  if (!binaryStat.isFile() || !(binaryStat.mode & 0o111))
    throw new Error("RELEASE_WORKERD_BINARY_INVALID");
  const binary = await NodeFSP.readFile(binaryPath);
  const configPath = NodePath.join(repository, "apps/cloud/infra/isolateProbe/wrangler.jsonc");
  const config = await NodeFSP.readFile(configPath);
  const cpus = NodeOS.cpus();

  return {
    schemaVersion: 1,
    wrangler: {
      packagePath: wranglerPackagePath,
      version: packageVersion(wranglerPackage, "RELEASE_WRANGLER_VERSION_MISSING"),
    },
    workerd: {
      native,
      binary: { path: binaryPath, bytes: binary.byteLength, sha256: sha256(binary) },
    },
    config: {
      path: NodePath.relative(repository, configPath),
      bytes: config.byteLength,
      sha256: sha256(config),
    },
    hostInventory: {
      platform: NodeProcess.platform,
      architecture: NodeProcess.arch,
      osRelease: NodeOS.release(),
      nodeVersion: NodeProcess.version,
      nodeAbi: NodeProcess.versions.modules ?? "unknown",
      logicalCpuCount: cpus.length,
      cpuModels: [...new Set(cpus.map((cpu) => cpu.model))].sort(),
      totalMemoryBytes: NodeOS.totalmem(),
    },
  };
}
