import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  buildNodeSdk as buildVerifiedNodeSdk,
  type NodeSdkBuildOptions,
  type NpmSdkSource,
  type VerifiedNpmSdkSource,
} from "../../src/isolate/NodeSdkBuild.ts";
import { verifyClaudeSdkNpmSource } from "./claudeSdkNpmSource.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
export const claudeAgentSdkPackage = "@anthropic-ai/claude-agent-sdk";

async function packageArchive(
  directory: string,
  name: string,
  version: string,
  files: Readonly<Record<string, string>>,
) {
  const stage = NodePath.join(directory, `${name.replaceAll("/", "-")}-archive`);
  const root = NodePath.join(stage, "package");
  await NodeFSP.mkdir(root, { recursive: true });
  const main = Object.keys(files).find((path) => path.endsWith(".mjs") || path.endsWith(".js"));
  if (!main) throw new Error("Fixture package needs a JavaScript entry.");
  await NodeFSP.writeFile(
    NodePath.join(root, "package.json"),
    JSON.stringify({ name, version, main, type: "module" }),
  );
  for (const [path, source] of Object.entries(files)) {
    const absolute = NodePath.join(root, path);
    await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
    await NodeFSP.writeFile(absolute, source);
  }
  const tarball = NodePath.join(directory, `${name.replaceAll("/", "-")}-${version}.tgz`);
  await execute("tar", ["-czf", tarball, "-C", stage, "package"]);
  const integrity = `sha512-${NodeCrypto.createHash("sha512")
    .update(await NodeFSP.readFile(tarball))
    .digest("base64")}`;
  return { root, tarball, integrity, name, version } satisfies NpmSdkSource;
}

export async function sdkFixture(source: string, temporary: string[]) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-sdk-bundle-"));
  temporary.push(directory);
  const sdk = await packageArchive(directory, claudeAgentSdkPackage, "0.0.1", {
    "sdk.mjs": source,
  });
  const dependency = await packageArchive(directory, "test-dependency", "1.0.0", {
    "index.js": "export const answer = () => 42;",
  });
  const installedDependency = NodePath.join(directory, "node_modules", dependency.name);
  await NodeFSP.mkdir(NodePath.dirname(installedDependency), { recursive: true });
  await NodeFSP.cp(dependency.root, installedDependency, { recursive: true });
  return {
    directory,
    sdk,
    dependency: { ...dependency, root: installedDependency },
  };
}

type RawBuildOptions = Omit<NodeSdkBuildOptions, "source" | "dependencies"> & {
  readonly source: NpmSdkSource;
  readonly dependencies?: ReadonlyArray<NpmSdkSource>;
};

export async function buildNodeSdk(input: RawBuildOptions) {
  const verified: ReadonlyArray<VerifiedNpmSdkSource> = await Promise.all(
    [input.source, ...(input.dependencies ?? [])].map(verifyClaudeSdkNpmSource),
  );
  return buildVerifiedNodeSdk({
    ...input,
    source: verified[0]!,
    dependencies: verified.slice(1),
  });
}
