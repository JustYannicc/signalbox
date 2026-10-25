// @effect-diagnostics nodeBuiltinImport:off - reads pinned Git template assets for seed bundles.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  GIT_TEMPLATE_ASSET_ROOT,
  readPinnedGitTemplateManifest,
  stripGitTemplateAssetPath,
  type GitTemplateManifestFile,
} from "./gitTemplateManifest.ts";

export interface ChildProgramDataFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly mode: number;
}

export interface ChildProgramDataCatalogEntry {
  readonly bytes: number;
  readonly sha256: string;
  readonly mode: number;
}

export type ChildProgramDataCatalog = Readonly<Record<string, ChildProgramDataCatalogEntry>>;

export interface PinnedGitTemplates {
  readonly dataFiles: readonly ChildProgramDataFile[];
  readonly dataCatalog: ChildProgramDataCatalog;
}

/** Reads and verifies stock Git 2.53.0 templates below the supplied programs directory. */
export async function readPinnedGitTemplates(programDir: string): Promise<PinnedGitTemplates> {
  const manifest = await readPinnedGitTemplateManifest();
  const programRoot = await NodeFSP.realpath(programDir);
  const templatesRoot = NodePath.join(programRoot, GIT_TEMPLATE_ASSET_ROOT);
  try {
    await requireDirectory(templatesRoot, 0o755);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`Pinned Git template assets are missing under ${templatesRoot}`, {
        cause: error,
      });
    }
    throw new Error(`Could not inspect pinned Git template assets under ${templatesRoot}`, {
      cause: error,
    });
  }

  const expectedFiles = new Set<string>();
  const expectedDirectories = new Set<string>();
  for (const file of manifest.files) {
    const relativeAssetPath = stripGitTemplateAssetPath(file.assetPath);
    expectedFiles.add(relativeAssetPath);
    const parts = relativeAssetPath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      expectedDirectories.add(parts.slice(0, index).join("/"));
    }
  }
  await validateAssetTree(templatesRoot, expectedFiles, expectedDirectories);

  const dataFiles = await Promise.all(
    manifest.files.map(async (file) => {
      const sourcePath = NodePath.join(
        templatesRoot,
        ...stripGitTemplateAssetPath(file.assetPath).split("/"),
      );
      const metadata = await NodeFSP.lstat(sourcePath);
      const bytes = new Uint8Array(await NodeFSP.readFile(sourcePath));
      return verifyGitTemplateDataFile(file, bytes, {
        isFile: metadata.isFile(),
        mode: metadata.mode & 0o777,
      });
    }),
  );
  const frozenFiles = Object.freeze(dataFiles);
  return Object.freeze({
    dataFiles: frozenFiles,
    dataCatalog: createGitTemplateDataCatalog(frozenFiles),
  });
}

export function verifyGitTemplateDataFile(
  file: Pick<GitTemplateManifestFile, "path" | "bytes" | "sha256" | "mode">,
  bytes: Uint8Array,
  metadata: { readonly isFile: boolean; readonly mode: number },
): ChildProgramDataFile {
  if (
    !metadata.isFile ||
    metadata.mode !== file.mode ||
    bytes.byteLength !== file.bytes ||
    sha256(bytes) !== file.sha256
  ) {
    throw new Error(`Pinned Git template changed at ${file.path}`);
  }
  return Object.freeze({
    path: file.path,
    bytes,
    sha256: file.sha256,
    mode: file.mode,
  });
}

export function createGitTemplateDataCatalog(
  dataFiles: readonly ChildProgramDataFile[],
): ChildProgramDataCatalog {
  return Object.freeze(
    Object.fromEntries(
      dataFiles.map((file) => [
        file.path,
        Object.freeze({ bytes: file.bytes.byteLength, sha256: file.sha256, mode: file.mode }),
      ]),
    ),
  );
}

async function validateAssetTree(
  root: string,
  expectedFiles: ReadonlySet<string>,
  expectedDirectories: ReadonlySet<string>,
): Promise<void> {
  const files = new Set<string>();
  const directories = new Set<string>();
  const visit = async (relativePath: string) => {
    const directoryPath = NodePath.join(root, ...relativePath.split("/").filter(Boolean));
    for (const entry of await NodeFSP.readdir(directoryPath, { withFileTypes: true })) {
      const childPath = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
      const childAbsolutePath = NodePath.join(root, ...childPath.split("/"));
      const metadata = await NodeFSP.lstat(childAbsolutePath);
      if (metadata.isDirectory()) {
        if ((metadata.mode & 0o777) !== 0o755) {
          throw new Error(`Unexpected Git template directory mode at ${childPath}`);
        }
        directories.add(childPath);
        await visit(childPath);
      } else if (metadata.isFile()) {
        files.add(childPath);
      } else {
        throw new Error(`Unexpected Git template asset type at ${childPath}`);
      }
    }
  };
  await visit("");
  if (!samePaths(files, expectedFiles) || !samePaths(directories, expectedDirectories)) {
    throw new Error("Git template asset paths changed");
  }
}

async function requireDirectory(path: string, mode: number): Promise<void> {
  const metadata = await NodeFSP.lstat(path);
  if (!metadata.isDirectory() || (metadata.mode & 0o777) !== mode) {
    throw new Error(`Invalid Git template asset directory ${path}`);
  }
}

function samePaths(actual: ReadonlySet<string>, expected: ReadonlySet<string>): boolean {
  return actual.size === expected.size && [...actual].every((path) => expected.has(path));
}

function sha256(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}
