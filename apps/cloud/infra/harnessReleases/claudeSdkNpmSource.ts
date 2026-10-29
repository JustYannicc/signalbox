import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import type { NpmSdkSource, VerifiedNpmSdkSource } from "../../src/isolate/NodeSdkBuild.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);

function containsPath(root: string, candidate: string) {
  const relative = NodePath.relative(root, candidate);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
}

async function archiveFile(source: NpmSdkSource, relative: string) {
  if (
    !relative ||
    relative.split(/[\\/]/u).some((part) => part === "..") ||
    NodePath.isAbsolute(relative)
  )
    throw new Error("CLAUDE_SDK_SOURCE_PATH_ESCAPE");
  const result = await execute("tar", ["-xOf", source.tarball, `package/${relative}`], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

/** Verify both the npm archive and every file that esbuild consumes from it. */
export async function verifyClaudeSdkNpmSource(
  source: NpmSdkSource,
): Promise<VerifiedNpmSdkSource> {
  if (!source.name || !source.version || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(source.integrity))
    throw new Error("CLAUDE_SDK_NPM_IDENTITY_INVALID");
  if (Buffer.from(source.integrity.slice(7), "base64").byteLength !== 64)
    throw new Error("CLAUDE_SDK_NPM_INTEGRITY_INVALID");
  const archive = await NodeFSP.readFile(source.tarball);
  const integrity = `sha512-${NodeCrypto.createHash("sha512").update(archive).digest("base64")}`;
  if (integrity !== source.integrity) throw new Error("CLAUDE_SDK_NPM_INTEGRITY_MISMATCH");

  const rootStat = await NodeFSP.lstat(source.root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error("CLAUDE_SDK_SOURCE_ROOT_INVALID");
  const root = await NodeFSP.realpath(source.root);
  const packagePath = NodePath.join(root, "package.json");
  const packageStat = await NodeFSP.lstat(packagePath);
  if (packageStat.isSymbolicLink() || !packageStat.isFile())
    throw new Error("CLAUDE_SDK_PACKAGE_MANIFEST_INVALID");
  const packageBytes = await NodeFSP.readFile(packagePath);
  const manifest: unknown = JSON.parse(packageBytes.toString("utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Reflect.get(manifest, "name") !== source.name ||
    Reflect.get(manifest, "version") !== source.version
  )
    throw new Error("CLAUDE_SDK_PACKAGE_IDENTITY_MISMATCH");
  if (!(await archiveFile(source, "package.json")).equals(packageBytes))
    throw new Error("CLAUDE_SDK_PACKAGE_METADATA_DRIFT");

  return {
    root,
    source,
    tarballSha256: NodeCrypto.createHash("sha256").update(archive).digest("hex"),
    tarballBytes: archive.byteLength,
    async verifyFile(file) {
      const stat = await NodeFSP.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error("CLAUDE_SDK_SOURCE_FILE_INVALID");
      const absolute = await NodeFSP.realpath(file);
      if (!containsPath(root, absolute)) throw new Error("CLAUDE_SDK_SOURCE_PATH_ESCAPE");
      const path = NodePath.relative(root, absolute).split(NodePath.sep).join("/");
      const bytes = await NodeFSP.readFile(absolute);
      if (!(await archiveFile(source, path)).equals(bytes))
        throw new Error("CLAUDE_SDK_SOURCE_ARCHIVE_MISMATCH");
      return {
        packageName: source.name,
        packageVersion: source.version,
        path,
        bytes: bytes.byteLength,
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      };
    },
  };
}
