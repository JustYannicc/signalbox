import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface ClaudeReleaseCandidateFilePin {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export const candidateSha256 = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export const candidateFilePin = (
  path: string,
  bytes: Uint8Array,
): ClaudeReleaseCandidateFilePin => ({
  path,
  bytes: bytes.byteLength,
  sha256: candidateSha256(bytes),
});

const pathExists = async (path: string) => {
  try {
    await NodeFSP.lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
};

export const requireMissingCandidateOutput = async (path: string) => {
  if (await pathExists(path)) throw new Error("HARNESS_CANDIDATE_OUTPUT_EXISTS");
};

export const resolveCandidateOutputDirectory = async (requested: string) => {
  const resolved = NodePath.resolve(requested);
  const parent = NodePath.dirname(resolved);
  await NodeFSP.mkdir(parent, { recursive: true });
  const outputParent = await NodeFSP.realpath(parent);
  const outputDirectory = NodePath.join(outputParent, NodePath.basename(resolved));
  await requireMissingCandidateOutput(outputDirectory);
  return { outputParent, outputDirectory };
};

export const writeCandidateFile = async (path: string, bytes: Uint8Array) => {
  const handle = await NodeFSP.open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
};

export const verifyCandidateFilePin = async (
  directory: string,
  pin: ClaudeReleaseCandidateFilePin,
) => {
  if (NodePath.isAbsolute(pin.path) || pin.path.split(/[\\/]/u).includes(".."))
    throw new Error("HARNESS_CANDIDATE_FILE_PIN_INVALID");
  const bytes = await NodeFSP.readFile(NodePath.join(directory, pin.path));
  if (bytes.byteLength !== pin.bytes || candidateSha256(bytes) !== pin.sha256)
    throw new Error("HARNESS_CANDIDATE_FILE_PIN_MISMATCH");
};

export const assertStandaloneCandidateSqlite = async (path: string) => {
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (await pathExists(`${path}${suffix}`))
      throw new Error("HARNESS_CANDIDATE_SQLITE_NOT_STANDALONE");
};

const removePublishedFiles = async (
  directory: string,
  ownedFiles: ReadonlyMap<string, { readonly dev: number; readonly ino: number }>,
) => {
  for (const [name, identity] of ownedFiles) {
    const path = NodePath.join(directory, name);
    try {
      const stat = await NodeFSP.lstat(path);
      if (stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino)
        await NodeFSP.unlink(path);
    } catch {
      // A missing or replaced file is not ours to remove.
    }
  }
  try {
    await NodeFSP.rmdir(directory);
  } catch {
    // Keep concurrently added files intact.
  }
};

/** Links a complete staged package into a newly claimed directory, then verifies it there. */
export const publishCandidateDirectory = async (
  stagedDirectory: string,
  outputDirectory: string,
  verify: () => Promise<void>,
) => {
  await requireMissingCandidateOutput(outputDirectory);
  try {
    await NodeFSP.mkdir(outputDirectory, { mode: 0o700 });
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "EEXIST")
      throw new Error("HARNESS_CANDIDATE_OUTPUT_EXISTS", { cause });
    throw cause;
  }

  const linkedFiles = new Map<string, { readonly dev: number; readonly ino: number }>();
  try {
    const filenames = (await NodeFSP.readdir(stagedDirectory)).sort();
    for (const filename of filenames) {
      const stagedPath = NodePath.join(stagedDirectory, filename);
      const outputPath = NodePath.join(outputDirectory, filename);
      await NodeFSP.link(stagedPath, outputPath);
      const stat = await NodeFSP.lstat(outputPath);
      if (!stat.isFile()) throw new Error("HARNESS_CANDIDATE_OUTPUT_CHANGED");
      linkedFiles.set(filename, { dev: stat.dev, ino: stat.ino });
    }
    await verify();
  } catch (cause) {
    await removePublishedFiles(outputDirectory, linkedFiles);
    throw cause;
  }
};
