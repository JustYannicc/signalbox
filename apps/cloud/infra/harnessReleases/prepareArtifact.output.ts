import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export type ArtifactFileSystem = Pick<
  typeof NodeFSP,
  "mkdir" | "mkdtemp" | "realpath" | "readdir" | "lstat" | "open" | "symlink" | "unlink" | "rmdir"
>;

type FileStat = Awaited<ReturnType<typeof NodeFSP.lstat>>;
type OwnedPath = { readonly path: string; readonly dev: number; readonly ino: number };

const sameIdentity = (left: FileStat, right: FileStat) =>
  left.dev === right.dev && left.ino === right.ino;

const containsPath = (root: string, candidate: string) => {
  if (root === candidate) return true;
  const relative = NodePath.relative(root, candidate);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
};

const hasErrorCode = (cause: unknown, code: string) =>
  cause instanceof Error && "code" in cause && cause.code === code;

const assertOutputPathIsMissing = async (path: string, filesystem: ArtifactFileSystem) => {
  try {
    await filesystem.lstat(path);
  } catch (cause) {
    if (hasErrorCode(cause, "ENOENT")) return;
    throw cause;
  }
  throw new Error("HARNESS_ARTIFACT_OUTPUT_EXISTS");
};

export class OwnedArtifactOutput {
  private readonly ownedFiles: OwnedPath[] = [];
  private readonly ownedDirectories: OwnedPath[] = [];
  private readonly ownedDirectoryByPath = new Map<string, OwnedPath>();
  readonly path: string;
  private readonly publicPath: string;
  private readonly filesystem: ArtifactFileSystem;

  private constructor(path: string, publicPath: string, filesystem: ArtifactFileSystem) {
    this.path = path;
    this.publicPath = publicPath;
    this.filesystem = filesystem;
  }

  static async claim(path: string, filesystem: ArtifactFileSystem) {
    await assertOutputPathIsMissing(path, filesystem);
    // Keep partial artifacts private until a single link publishes the validated tree.
    const stagingPath = await filesystem.mkdtemp(
      NodePath.join(NodePath.dirname(path), ".harness-artifact-stage-"),
    );
    const output = new OwnedArtifactOutput(stagingPath, path, filesystem);
    await output.recordOwnedDirectory(stagingPath);
    return output;
  }

  async publish() {
    const type = NodePath.sep === "\\" ? "junction" : "dir";
    const target =
      type === "junction"
        ? this.path
        : NodePath.relative(NodePath.dirname(this.publicPath), this.path);
    try {
      await this.filesystem.symlink(target, this.publicPath, type);
    } catch (cause) {
      if (hasErrorCode(cause, "EEXIST")) {
        throw new Error("HARNESS_ARTIFACT_OUTPUT_EXISTS", { cause });
      }
      throw cause;
    }
  }

  private async recordOwnedDirectory(path: string) {
    const stat = await this.filesystem.lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("HARNESS_ARTIFACT_OUTPUT_CHANGED");
    }
    const owned = { path, dev: stat.dev, ino: stat.ino };
    this.ownedDirectories.push(owned);
    this.ownedDirectoryByPath.set(path, owned);
    return stat;
  }

  private async assertOwnedDirectory(path: string, owned: OwnedPath) {
    const current = await this.filesystem.lstat(path);
    const resolved = await this.filesystem.realpath(path);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== owned.dev ||
      current.ino !== owned.ino ||
      !containsPath(this.path, resolved)
    ) {
      throw new Error("HARNESS_ARTIFACT_OUTPUT_CHANGED");
    }
  }

  private async ensureOutputDirectory(path: string) {
    const existing = this.ownedDirectoryByPath.get(path);
    if (existing) {
      await this.assertOwnedDirectory(path, existing);
      return;
    }
    await this.filesystem.mkdir(path);
    await this.recordOwnedDirectory(path);
  }

  private async ensureOutputParent(path: string) {
    const parent = NodePath.dirname(path);
    if (!containsPath(this.path, parent)) {
      throw new Error("HARNESS_ARTIFACT_OUTPUT_CHANGED");
    }
    const relative = NodePath.relative(this.path, parent);
    let current = this.path;
    const root = this.ownedDirectoryByPath.get(this.path);
    if (!root) throw new Error("HARNESS_ARTIFACT_OUTPUT_CHANGED");
    await this.assertOwnedDirectory(this.path, root);
    if (!relative) return;
    for (const part of relative.split(NodePath.sep)) {
      current = NodePath.join(current, part);
      await this.ensureOutputDirectory(current);
    }
  }

  async writeFile(path: string, bytes: Uint8Array) {
    if (!containsPath(this.path, path) || path === this.path) {
      throw new Error("HARNESS_ARTIFACT_OUTPUT_CHANGED");
    }
    await this.ensureOutputParent(path);
    const handle = await this.filesystem.open(path, "wx");
    try {
      const created = await handle.stat();
      if (!created.isFile()) throw new Error("HARNESS_ARTIFACT_OUTPUT_CHANGED");
      this.ownedFiles.push({ path, dev: created.dev, ino: created.ino });
      const createdPath = await this.filesystem.lstat(path);
      const resolved = await this.filesystem.realpath(path);
      if (
        createdPath.isSymbolicLink() ||
        !createdPath.isFile() ||
        !sameIdentity(created, createdPath) ||
        !containsPath(this.path, resolved)
      ) {
        throw new Error("HARNESS_ARTIFACT_OUTPUT_CHANGED");
      }
      await handle.writeFile(bytes);
      const written = await handle.stat();
      const writtenPath = await this.filesystem.lstat(path);
      if (
        !written.isFile() ||
        written.size !== bytes.byteLength ||
        !sameIdentity(created, written) ||
        writtenPath.isSymbolicLink() ||
        !writtenPath.isFile() ||
        !sameIdentity(written, writtenPath)
      ) {
        throw new Error("HARNESS_ARTIFACT_OUTPUT_CHANGED");
      }
      const parent = this.ownedDirectoryByPath.get(NodePath.dirname(path));
      if (!parent) throw new Error("HARNESS_ARTIFACT_OUTPUT_CHANGED");
      await this.assertOwnedDirectory(parent.path, parent);
    } finally {
      await handle.close();
    }
  }

  async cleanup() {
    for (const owned of this.ownedFiles.toReversed()) {
      try {
        const current = await this.filesystem.lstat(owned.path);
        if (
          !current.isSymbolicLink() &&
          current.isFile() &&
          current.dev === owned.dev &&
          current.ino === owned.ino
        ) {
          await this.filesystem.unlink(owned.path);
        }
      } catch {
        // A changed or concurrently removed path is not ours to clean up.
      }
    }
    for (const owned of this.ownedDirectories.toReversed()) {
      try {
        const current = await this.filesystem.lstat(owned.path);
        if (
          !current.isSymbolicLink() &&
          current.isDirectory() &&
          current.dev === owned.dev &&
          current.ino === owned.ino
        ) {
          await this.filesystem.rmdir(owned.path);
        }
      } catch {
        // rmdir leaves concurrent contents intact; replaced paths are not ours.
      }
    }
  }
}
