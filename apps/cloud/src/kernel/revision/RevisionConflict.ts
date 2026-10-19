import type { CommitInode } from "../FilePersistencePorts.ts";
import { KernelRevisionWorkspaceError } from "./RevisionErrors.ts";
import { diffTrees } from "./RevisionTree.ts";
import type { DirtyInode, TreeEntry } from "./RevisionTypes.ts";
import {
  localContentChanged,
  mergePosixMetadata,
  remoteContentChanged,
} from "./RevisionMetadata.ts";

export function assertNoRevisionConflict(
  baseline: ReadonlyMap<string, TreeEntry>,
  current: ReadonlyMap<string, TreeEntry>,
  dirty: readonly DirtyInode[],
  remote: readonly CommitInode[],
): void {
  const dirtyInodes = new Set(dirty.map((entry) => entry.inode));
  const baselinePaths = pathsByName(baseline);
  const local = diffTrees(baseline, current, dirtyInodes);
  if (local.length === 0) return;

  const currentPaths = pathsByName(current);
  const localInodes = new Set(local.map((entry) => entry.inode.toString()));
  const localByInode = new Map(local.map((entry) => [entry.inode.toString(), entry]));

  for (const change of remote) {
    const remotePaths = [...change.paths, ...change.removedPaths];
    for (const path of remotePaths) {
      for (const entry of [baselinePaths.get(path), currentPaths.get(path)]) {
        if (!entry || !localInodes.has(entry.inode)) continue;
        const localChange = localByInode.get(entry.inode)!;
        if (
          canMergeStableInodeUpdate(
            localChange,
            change,
            path,
            baseline,
            current,
            baselinePaths,
            dirtyInodes,
          )
        ) {
          const before = baseline.get(entry.inode);
          const live = current.get(entry.inode);
          mergePosixMetadata(before?.posix ?? null, live?.posix ?? null, change.posix);
          continue;
        }
        throw revisionConflict();
      }
    }

    const remoteDirectoryPaths = remoteDirectoryTopologyPaths(change, baselinePaths);
    for (const localChange of local) {
      const localPaths = [...localChange.paths, ...localChange.removedPaths];
      const localDirectoryPaths = localDirectoryTopologyPaths(localChange, baseline, current);
      if (
        localPaths.some(
          (localPath) =>
            remotePaths.includes(localPath) &&
            !canMergeStableInodeUpdate(
              localChange,
              change,
              localPath,
              baseline,
              current,
              baselinePaths,
              dirtyInodes,
            ),
        ) ||
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

function canMergeStableInodeUpdate(
  localChange: ReturnType<typeof diffTrees>[number],
  remoteChange: CommitInode,
  path: string,
  baseline: ReadonlyMap<string, TreeEntry>,
  current: ReadonlyMap<string, TreeEntry>,
  baselinePaths: ReadonlyMap<string, TreeEntry>,
  dirtyInodes: ReadonlySet<string>,
): boolean {
  if (
    isDirectoryMetadataOverlap(localChange, remoteChange, path, baseline, current, baselinePaths)
  ) {
    return true;
  }
  const before = baselinePaths.get(path);
  if (!before || before.inode !== localChange.inode.toString()) return false;
  const local = current.get(before.inode);
  if (
    !local ||
    remoteChange.stat === null ||
    remoteChange.stat.type !== before.stat.type ||
    remoteChange.removedPaths.length > 0 ||
    !samePathSet(before.paths, local.paths) ||
    !samePathSet(before.paths, remoteChange.paths)
  ) {
    return false;
  }
  return !(
    (localContentChanged(before, local) || dirtyInodes.has(localChange.inode.toString())) &&
    remoteContentChanged(before, remoteChange)
  );
}

function isDirectoryMetadataOverlap(
  localChange: ReturnType<typeof diffTrees>[number],
  remoteChange: CommitInode,
  path: string,
  baseline: ReadonlyMap<string, TreeEntry>,
  current: ReadonlyMap<string, TreeEntry>,
  baselinePaths: ReadonlyMap<string, TreeEntry>,
): boolean {
  return (
    isRemoteDirectoryMetadataOnly(remoteChange, path, baselinePaths) &&
    isLocalDirectoryMetadataOnly(localChange, baseline, current)
  );
}

function remoteDirectoryTopologyPaths(
  change: CommitInode,
  baselinePaths: ReadonlyMap<string, TreeEntry>,
): string[] {
  const paths = new Set([...change.paths, ...change.removedPaths]);
  return [...paths].filter((path) => {
    const beforeDirectory = baselinePaths.get(path)?.stat.type === "directory";
    const afterDirectory = change.paths.includes(path) && change.stat?.type === "directory";
    return beforeDirectory !== afterDirectory;
  });
}

function localDirectoryTopologyPaths(
  change: ReturnType<typeof diffTrees>[number],
  baseline: ReadonlyMap<string, TreeEntry>,
  current: ReadonlyMap<string, TreeEntry>,
): string[] {
  const before = baseline.get(change.inode.toString());
  const after = current.get(change.inode.toString());
  const paths = new Set([...change.paths, ...change.removedPaths]);
  return [...paths].filter((path) => {
    const beforeDirectory = before?.stat.type === "directory" && before.paths.includes(path);
    const afterDirectory = after?.stat.type === "directory" && after.paths.includes(path);
    return beforeDirectory !== afterDirectory;
  });
}

function isRemoteDirectoryMetadataOnly(
  change: CommitInode,
  path: string,
  baselinePaths: ReadonlyMap<string, TreeEntry>,
): boolean {
  const before = baselinePaths.get(path);
  return (
    before?.stat.type === "directory" &&
    change.stat?.type === "directory" &&
    change.paths.includes(path) &&
    change.removedPaths.length === 0 &&
    samePaths(before.paths, change.paths)
  );
}

function isLocalDirectoryMetadataOnly(
  change: ReturnType<typeof diffTrees>[number],
  baseline: ReadonlyMap<string, TreeEntry>,
  current: ReadonlyMap<string, TreeEntry>,
): boolean {
  const before = baseline.get(change.inode.toString());
  const after = current.get(change.inode.toString());
  return (
    before?.stat.type === "directory" &&
    after?.stat.type === "directory" &&
    change.removedPaths.length === 0 &&
    samePaths(before.paths, after.paths) &&
    samePaths(change.paths, after.paths)
  );
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path) => right.includes(path));
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
