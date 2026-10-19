import type { CommitInode } from "../FilePersistencePorts.ts";
import type { Inode } from "../storage.ts";
import { KernelRevisionWorkspaceError } from "./RevisionErrors.ts";
import { diffTrees } from "./RevisionTree.ts";
import type { DirtyInode, TreeEntry } from "./RevisionTypes.ts";

export function assertNoRevisionConflict(
  baseline: ReadonlyMap<string, TreeEntry>,
  current: ReadonlyMap<string, TreeEntry>,
  dirty: readonly DirtyInode[],
  remote: readonly CommitInode[],
  rootInode: Inode,
): void {
  const baselinePaths = pathsByName(baseline);
  const rootIsDirty = dirty.some((entry) => entry.inode === rootInode.toString());
  if (
    rootIsDirty &&
    remote.some((change) =>
      [...change.removedPaths, ...change.paths].some(
        (path) =>
          !path.slice(1).includes("/") &&
          (change.removedPaths.includes(path) ||
            !baselinePaths.has(path) ||
            baselinePaths.get(path)?.stat.type !== change.stat?.type),
      ),
    )
  ) {
    throw revisionConflict();
  }

  const local = diffTrees(baseline, current, new Set(dirty.map((entry) => entry.inode)));
  if (local.length === 0) return;

  const currentPaths = pathsByName(current);
  const localInodes = new Set(local.map((entry) => entry.inode.toString()));

  for (const change of remote) {
    const remotePaths = [...change.paths, ...change.removedPaths];
    for (const path of remotePaths) {
      for (const entry of [baselinePaths.get(path), currentPaths.get(path)]) {
        if (entry && localInodes.has(entry.inode)) throw revisionConflict();
      }
    }

    const remoteDirectoryPaths = remotePaths.filter(
      (path) =>
        change.stat?.type === "directory" ||
        baselinePaths.get(path)?.stat.type === "directory" ||
        currentPaths.get(path)?.stat.type === "directory",
    );
    for (const localChange of local) {
      const localPaths = [...localChange.paths, ...localChange.removedPaths];
      const localDirectoryPaths = localPaths.filter(
        (path) =>
          baselinePaths.get(path)?.stat.type === "directory" ||
          currentPaths.get(path)?.stat.type === "directory",
      );
      if (
        localPaths.some((localPath) => remotePaths.includes(localPath)) ||
        localDirectoryPaths.some((directory) =>
          remotePaths.some((path) => isDescendant(path, directory)),
        ) ||
        remoteDirectoryPaths.some((directory) =>
          localPaths.some((path) => isDescendant(path, directory)),
        )
      ) {
        throw revisionConflict();
      }
    }
  }
}

function pathsByName(tree: ReadonlyMap<string, TreeEntry>): Map<string, TreeEntry> {
  return new Map(
    [...tree.values()].flatMap((entry) => entry.paths.map((path) => [path, entry] as const)),
  );
}

function isDescendant(path: string, directory: string): boolean {
  return path.startsWith(`${directory}/`);
}

function revisionConflict(): KernelRevisionWorkspaceError {
  return new KernelRevisionWorkspaceError(
    "LIVE_FILESYSTEM_DIVERGED",
    "Local filesystem changes overlap the VM revision; VM output was kept unapplied",
  );
}
