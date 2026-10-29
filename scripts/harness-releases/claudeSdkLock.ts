import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { OfficialReleaseIdentity } from "./releaseIdentity.ts";

const SDK_NAME = "@anthropic-ai/claude-agent-sdk";

export interface ClaudeSdkDependencyPin {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly resolved: string;
  readonly optional: boolean;
  readonly installed: boolean;
  readonly tarballSha256?: string;
  readonly tarballBytes?: number;
}

export interface InstalledPackage {
  readonly lockPath: string;
  readonly root: string;
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly resolved: string;
  readonly optional: boolean;
}

export interface ClaudeSdkLock {
  readonly sha256: string;
  readonly installed: ReadonlyArray<InstalledPackage>;
  readonly omitted: ReadonlyArray<ClaudeSdkDependencyPin>;
}

interface LockPackage {
  readonly version?: unknown;
  readonly resolved?: unknown;
  readonly integrity?: unknown;
  readonly optional?: unknown;
  readonly link?: unknown;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function string(value: unknown, code: string) {
  if (typeof value !== "string" || !value) throw new Error(code);
  return value;
}

function npmIntegrity(value: unknown) {
  const integrity = string(value, "CLAUDE_SDK_DEPENDENCY_INTEGRITY_REQUIRED");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity))
    throw new Error("CLAUDE_SDK_DEPENDENCY_INTEGRITY_INVALID");
  if (Buffer.from(integrity.slice(7), "base64").byteLength !== 64)
    throw new Error("CLAUDE_SDK_DEPENDENCY_INTEGRITY_INVALID");
  return integrity;
}

function npmTarball(value: unknown) {
  let url: URL;
  try {
    url = new URL(string(value, "CLAUDE_SDK_DEPENDENCY_TARBALL_REQUIRED"));
  } catch {
    throw new Error("CLAUDE_SDK_DEPENDENCY_TARBALL_INVALID");
  }
  if (
    url.origin !== "https://registry.npmjs.org" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("CLAUDE_SDK_DEPENDENCY_REGISTRY_REQUIRED");
  return url.toString();
}

function packageNameFromLockPath(lockPath: string) {
  const marker = lockPath.lastIndexOf("node_modules/");
  if (marker < 0) throw new Error("CLAUDE_SDK_DEPENDENCY_LOCK_PATH_INVALID");
  const parts = lockPath.slice(marker + "node_modules/".length).split("/");
  if (parts[0]?.startsWith("@")) {
    if (!parts[1]) throw new Error("CLAUDE_SDK_DEPENDENCY_LOCK_PATH_INVALID");
    return `${parts[0]}/${parts[1]}`;
  }
  if (!parts[0]) throw new Error("CLAUDE_SDK_DEPENDENCY_LOCK_PATH_INVALID");
  return parts[0];
}

function isWithin(root: string, candidate: string) {
  const relative = NodePath.relative(root, candidate);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
}

/** Bind installed package roots to the exact lockfile produced by npm. */
export async function readClaudeSdkLock(
  identity: OfficialReleaseIdentity,
  workspace: string,
): Promise<ClaudeSdkLock> {
  const npm = identity.npm;
  if (identity.provider !== "claude-agent-sdk" || !npm || npm.packageName !== SDK_NAME)
    throw new Error("CLAUDE_SDK_RELEASE_IDENTITY_INVALID");
  const lockBytes = await NodeFSP.readFile(NodePath.join(workspace, "package-lock.json"));
  const lock = record(JSON.parse(lockBytes.toString("utf8")), "CLAUDE_SDK_DEPENDENCY_LOCK_INVALID");
  if (typeof lock.lockfileVersion !== "number" || lock.lockfileVersion < 2)
    throw new Error("CLAUDE_SDK_DEPENDENCY_LOCK_INVALID");
  const lockPackages = record(lock.packages, "CLAUDE_SDK_DEPENDENCY_LOCK_INVALID");
  const sdkLockPath = `node_modules/${SDK_NAME}`;
  const sdkLock = record(
    lockPackages[sdkLockPath],
    "CLAUDE_SDK_DEPENDENCY_LOCK_INVALID",
  ) as LockPackage;
  if (
    sdkLock.version !== identity.version ||
    npmIntegrity(sdkLock.integrity) !== npm.integrity ||
    npmTarball(sdkLock.resolved) !== npmTarball(npm.tarball)
  )
    throw new Error("CLAUDE_SDK_DEPENDENCY_RELEASE_MISMATCH");

  const nodeModules = NodePath.join(workspace, "node_modules");
  const realNodeModules = await NodeFSP.realpath(nodeModules);
  const installed: InstalledPackage[] = [];
  const omitted: ClaudeSdkDependencyPin[] = [];
  for (const [lockPath, raw] of Object.entries(lockPackages).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (lockPath === "") continue;
    if (
      !lockPath.startsWith("node_modules/") ||
      lockPath.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("CLAUDE_SDK_DEPENDENCY_LOCK_PATH_INVALID");
    const item = record(raw, "CLAUDE_SDK_DEPENDENCY_LOCK_INVALID") as LockPackage;
    if (item.link === true) throw new Error("CLAUDE_SDK_DEPENDENCY_LINK_FORBIDDEN");
    const name = packageNameFromLockPath(lockPath);
    const version = string(item.version, "CLAUDE_SDK_DEPENDENCY_VERSION_REQUIRED");
    const integrity = npmIntegrity(item.integrity);
    const resolved = npmTarball(item.resolved);
    const root = NodePath.resolve(workspace, lockPath);
    if (!isWithin(nodeModules, root)) throw new Error("CLAUDE_SDK_DEPENDENCY_LOCK_PATH_INVALID");
    let stat;
    try {
      stat = await NodeFSP.lstat(root);
    } catch (error) {
      if (
        item.optional === true &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        omitted.push({ name, version, integrity, resolved, optional: true, installed: false });
        continue;
      }
      throw new Error("CLAUDE_SDK_DEPENDENCY_INSTALL_INCOMPLETE", { cause: error });
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("CLAUDE_SDK_DEPENDENCY_INSTALL_INCOMPLETE");
    const realRoot = await NodeFSP.realpath(root);
    if (!isWithin(realNodeModules, realRoot))
      throw new Error("CLAUDE_SDK_DEPENDENCY_INSTALL_INCOMPLETE");
    const packagePath = NodePath.join(realRoot, "package.json");
    const packageStat = await NodeFSP.lstat(packagePath);
    if (packageStat.isSymbolicLink() || !packageStat.isFile())
      throw new Error("CLAUDE_SDK_DEPENDENCY_PACKAGE_INVALID");
    const manifest = record(
      JSON.parse((await NodeFSP.readFile(packagePath)).toString("utf8")),
      "CLAUDE_SDK_DEPENDENCY_PACKAGE_INVALID",
    );
    if (manifest.name !== name || manifest.version !== version)
      throw new Error("CLAUDE_SDK_DEPENDENCY_PACKAGE_LOCK_MISMATCH");
    installed.push({
      lockPath,
      root: realRoot,
      name,
      version,
      integrity,
      resolved,
      optional: item.optional === true,
    });
  }
  if (!installed.some((item) => item.lockPath === sdkLockPath))
    throw new Error("CLAUDE_SDK_DEPENDENCY_INSTALL_INCOMPLETE");
  return {
    sha256: NodeCrypto.createHash("sha256").update(lockBytes).digest("hex"),
    installed,
    omitted,
  };
}
