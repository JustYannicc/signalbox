import type { CommitInode } from "../FilePersistencePorts.ts";
import type { Stat } from "../storage.ts";
import { KernelRevisionWorkspaceError } from "./RevisionErrors.ts";
import type { TreeEntry } from "./RevisionTypes.ts";

type Posix = NonNullable<TreeEntry["posix"]>;

export function mergePosixMetadata(
  baseline: TreeEntry["posix"],
  local: TreeEntry["posix"],
  remote: CommitInode["posix"],
): Posix | null {
  if (remote === undefined) return local;
  const fields = ["mode", "uid", "gid"] as const;
  const result: { mode?: number; uid?: number; gid?: number } = {};
  for (const field of fields) {
    const before = baseline?.[field];
    const live = local?.[field];
    const next = remote?.[field];
    const localChanged = live !== before;
    const remoteChanged = next !== before;
    if (localChanged && remoteChanged && live !== next) conflict();
    const value = localChanged ? live : next;
    if (value !== undefined) result[field] = value;
  }
  if (fields.every((field) => result[field] === undefined)) return null;
  if (result.mode === undefined || result.uid === undefined || result.gid === undefined) conflict();
  return result as Posix;
}

export function mergeRevisionStat(
  remote: CommitInode,
  baseline: TreeEntry | undefined,
  local: TreeEntry | undefined,
  live: Stat,
): Stat {
  const next = remote.stat;
  if (next === null)
    throw new KernelRevisionWorkspaceError("EIO", "A removed inode has no applied metadata");
  if (next.type === "directory") {
    const merged = { ...next, nlink: live.nlink };
    if (baseline?.stat.type !== "directory" || local?.stat.type !== "directory") return merged;
    for (const field of ["size", "atimeNs", "mtimeNs", "ctimeNs"] as const) {
      if (local.stat[field] !== baseline.stat[field]) merged[field] = local.stat[field];
    }
    return merged;
  }

  if (!baseline || !local || baseline.stat.type !== next.type || local.stat.type !== next.type)
    return next;
  const merged = { ...next };
  for (const field of ["atimeNs", "ctimeNs"] as const) {
    if (local.stat[field] !== baseline.stat[field]) merged[field] = local.stat[field];
  }
  if (!remoteContentChanged(baseline, remote)) {
    for (const field of ["size", "mtimeNs"] as const) {
      if (local.stat[field] !== baseline.stat[field]) merged[field] = local.stat[field];
    }
  }
  return merged;
}

export function localContentChanged(
  baseline: TreeEntry | undefined,
  current: TreeEntry | undefined,
): boolean {
  if (!baseline || !current) return baseline !== current;
  return (
    baseline.stat.type !== current.stat.type ||
    baseline.stat.size !== current.stat.size ||
    baseline.stat.mtimeNs !== current.stat.mtimeNs ||
    baseline.symlinkTarget !== current.symlinkTarget
  );
}

export function remoteContentChanged(
  baseline: TreeEntry | undefined,
  remote: CommitInode,
): boolean {
  if (remote.stat === null || !baseline) return true;
  return (
    baseline.stat.type !== remote.stat.type ||
    baseline.stat.size !== remote.stat.size ||
    baseline.stat.mtimeNs !== remote.stat.mtimeNs ||
    baseline.symlinkTarget !== remote.symlinkTarget
  );
}

function conflict(): never {
  throw new KernelRevisionWorkspaceError(
    "LIVE_FILESYSTEM_DIVERGED",
    "Local and VM POSIX metadata changed the same field",
  );
}
