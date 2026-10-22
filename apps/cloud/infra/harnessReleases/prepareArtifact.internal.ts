import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { verifyArtifactNodeBuiltins } from "./verifyNodeBuiltins.ts";
import { OwnedArtifactOutput, type ArtifactFileSystem } from "./prepareArtifact.output.ts";
import {
  harnessReleaseOmissionIdentityFromProviderManifest,
  openHarnessReleaseArtifact,
  serializeHarnessReleaseArtifactManifest,
  type HarnessReleaseOmissionIdentity,
  type HarnessReleaseArtifactIdentity,
} from "../../src/harnessReleases/HarnessReleaseArtifact.ts";

export interface PrepareHarnessArtifactInput {
  readonly harness: "codex" | "claude-code";
  readonly sourceIdentity: string;
  readonly computer: { readonly sourceIdentity: string; readonly manifestSha256: string };
  readonly components: {
    readonly codex?: string;
    readonly cli?: string;
    readonly sdk?: string;
  };
  readonly output: string;
}

export type { ArtifactFileSystem } from "./prepareArtifact.output.ts";

type FileStat = Awaited<ReturnType<typeof NodeFSP.lstat>>;

const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const sameIdentity = (left: FileStat, right: FileStat) =>
  left.dev === right.dev && left.ino === right.ino;
const sameFileState = (left: FileStat, right: FileStat) =>
  sameIdentity(left, right) &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const containsPath = (root: string, candidate: string) => {
  if (root === candidate) return true;
  const relative = NodePath.relative(root, candidate);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
};

const assertSourcePath = async (filesystem: ArtifactFileSystem, root: string, absolute: string) => {
  const resolved = await filesystem.realpath(absolute);
  if (!containsPath(root, resolved)) throw new Error("HARNESS_ARTIFACT_PATH_ESCAPE");
  return resolved;
};

const assertDirectoryPath = async (
  filesystem: ArtifactFileSystem,
  root: string,
  absolute: string,
  expected: FileStat,
) => {
  const before = await filesystem.lstat(absolute);
  if (before.isSymbolicLink() || !before.isDirectory() || !sameIdentity(expected, before)) {
    throw new Error("HARNESS_ARTIFACT_DIRECTORY_CHANGED");
  }
  await assertSourcePath(filesystem, root, absolute);
  const after = await filesystem.lstat(absolute);
  if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(expected, after)) {
    throw new Error("HARNESS_ARTIFACT_DIRECTORY_CHANGED");
  }
};

const readSourceFile = async (
  filesystem: ArtifactFileSystem,
  root: string,
  absolute: string,
  expected: FileStat,
) => {
  const before = await filesystem.lstat(absolute);
  if (before.isSymbolicLink() || !before.isFile() || !sameFileState(expected, before)) {
    throw new Error("HARNESS_ARTIFACT_FILE_CHANGED");
  }
  await assertSourcePath(filesystem, root, absolute);

  const handle = await filesystem.open(absolute, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileState(expected, opened)) {
      throw new Error("HARNESS_ARTIFACT_FILE_CHANGED");
    }
    const current = await filesystem.lstat(absolute);
    if (current.isSymbolicLink() || !current.isFile() || !sameIdentity(opened, current)) {
      throw new Error("HARNESS_ARTIFACT_FILE_CHANGED");
    }
    await assertSourcePath(filesystem, root, absolute);

    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    const afterPath = await filesystem.lstat(absolute);
    if (
      !sameFileState(opened, afterRead) ||
      afterRead.size !== bytes.byteLength ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !sameIdentity(afterRead, afterPath)
    ) {
      throw new Error("HARNESS_ARTIFACT_FILE_CHANGED");
    }
    await assertSourcePath(filesystem, root, absolute);
    return Uint8Array.from(bytes);
  } finally {
    await handle.close();
  }
};

export const artifactDirectorySource = (directory: string) => ({
  read: async (_reference: string, path: string) => {
    const root = await NodeFSP.realpath(directory);
    const absolute = await NodeFSP.realpath(NodePath.resolve(root, path));
    const relative = NodePath.relative(root, absolute);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
    )
      throw new Error("HARNESS_ARTIFACT_PATH_ESCAPE");
    return NodeFSP.readFile(absolute);
  },
});

export const prepareHarnessArtifactWithFileSystem = async (
  input: PrepareHarnessArtifactInput,
  filesystem: ArtifactFileSystem = NodeFSP,
): Promise<HarnessReleaseArtifactIdentity> => {
  const componentNames =
    input.harness === "codex" ? (["codex"] as const) : (["cli", "sdk"] as const);
  const supplied = Object.keys(input.components).filter(
    (name) => input.components[name as keyof typeof input.components] !== undefined,
  );
  if (
    supplied.length !== componentNames.length ||
    supplied.some((name) => !componentNames.some((expected) => expected === name))
  ) {
    throw new Error("HARNESS_ARTIFACT_COMPONENTS_INVALID");
  }

  const requestedOutput = NodePath.resolve(input.output);
  await filesystem.mkdir(NodePath.dirname(requestedOutput), { recursive: true });
  const output = NodePath.join(
    await filesystem.realpath(NodePath.dirname(requestedOutput)),
    NodePath.basename(requestedOutput),
  );
  const roots = new Map<(typeof componentNames)[number], { path: string; stat: FileStat }>();
  for (const component of componentNames) {
    const root = await filesystem.realpath(input.components[component]!);
    const stat = await filesystem.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("HARNESS_ARTIFACT_COMPONENT_ROOT_INVALID");
    }
    const relativeOutput = NodePath.relative(root, output);
    if (relativeOutput === "" || containsPath(root, output)) {
      throw new Error("HARNESS_ARTIFACT_OUTPUT_INSIDE_INPUT");
    }
    roots.set(component, { path: root, stat });
  }

  const files: Record<string, { bytes: number; sha256: string }> = {};
  const components: Partial<Record<"codex" | "cli" | "sdk", { manifest: string }>> = {};
  let omission: HarnessReleaseOmissionIdentity | undefined;
  const copyTree = async (
    root: string,
    component: (typeof componentNames)[number],
    relative: string,
    expectedDirectory: FileStat,
  ): Promise<void> => {
    const absolute = relative ? NodePath.join(root, relative) : root;
    const before = await filesystem.lstat(absolute);
    if (
      before.isSymbolicLink() ||
      !before.isDirectory() ||
      !sameIdentity(expectedDirectory, before)
    ) {
      throw new Error("HARNESS_ARTIFACT_DIRECTORY_CHANGED");
    }
    await assertSourcePath(filesystem, root, absolute);

    const handle = await filesystem.open(absolute, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory() || !sameIdentity(before, opened)) {
        throw new Error("HARNESS_ARTIFACT_DIRECTORY_CHANGED");
      }
      await assertDirectoryPath(filesystem, root, absolute, opened);
      const entries = await filesystem.readdir(absolute, { withFileTypes: true });
      await assertDirectoryPath(filesystem, root, absolute, opened);

      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const childAbsolute = NodePath.join(root, childRelative);
        const childStat = await filesystem.lstat(childAbsolute);
        if (childStat.isSymbolicLink()) throw new Error("HARNESS_ARTIFACT_SYMLINK");
        if (
          (entry.isDirectory() && !childStat.isDirectory()) ||
          (entry.isFile() && !childStat.isFile())
        ) {
          throw new Error("HARNESS_ARTIFACT_ENTRY_CHANGED");
        }
        await assertSourcePath(filesystem, root, childAbsolute);

        if (childStat.isDirectory()) {
          await copyTree(root, component, childRelative, childStat);
          continue;
        }
        if (!childStat.isFile()) throw new Error("HARNESS_ARTIFACT_SPECIAL_FILE");

        const bytes = await readSourceFile(filesystem, root, childAbsolute, childStat);
        if (component === "cli" && childRelative === "manifest.json") {
          // Keep the full artifact reader as the validation boundary so malformed source
          // manifests still fail only after the private artifact has been assembled.
          try {
            const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            omission = harnessReleaseOmissionIdentityFromProviderManifest(manifest);
          } catch {
            omission = undefined;
          }
        }
        const key = `${component}/${childRelative}`;
        files[key] = { bytes: bytes.byteLength, sha256: digest(bytes) };
        const destination = NodePath.join(
          artifactOutput.path,
          component,
          ...childRelative.split("/"),
        );
        await artifactOutput.writeFile(destination, bytes);
      }

      await assertDirectoryPath(filesystem, root, absolute, opened);
    } finally {
      await handle.close();
    }
  };

  const artifactOutput = await OwnedArtifactOutput.claim(output, filesystem);
  try {
    for (const component of componentNames) {
      const root = roots.get(component)!;
      await copyTree(root.path, component, "", root.stat);
      components[component] = { manifest: `${component}/manifest.json` };
    }

    await verifyArtifactNodeBuiltins(artifactOutput.path);

    const manifestBytes = serializeHarnessReleaseArtifactManifest({
      schemaVersion: 1,
      harness: input.harness,
      sourceIdentity: input.sourceIdentity,
      computer: input.computer,
      components,
      files,
      ...(omission === undefined ? {} : { omission }),
    });
    const artifactHash = digest(manifestBytes);
    const identity = {
      artifactRef: `sha256:${artifactHash}`,
      artifactHash,
      sourceIdentity: input.sourceIdentity,
    };
    await artifactOutput.writeFile(
      NodePath.join(artifactOutput.path, "manifest.json"),
      manifestBytes,
    );
    await openHarnessReleaseArtifact(identity, artifactDirectorySource(artifactOutput.path));
    await artifactOutput.publish();
    return identity;
  } catch (cause) {
    await artifactOutput.cleanup();
    throw cause;
  }
};
