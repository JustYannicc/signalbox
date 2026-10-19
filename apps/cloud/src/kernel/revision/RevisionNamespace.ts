import type { KernelFileSystem } from "../KernelFileSystem.ts";
import { KernelOpenFlags } from "../KernelFileSystem.ts";
import type { CommitInode } from "../FilePersistencePorts.ts";
import type { Inode } from "../storage.ts";
import { KernelRevisionWorkspaceError, errorCode } from "./RevisionErrors.ts";
import type { ApplyPlan } from "./RevisionTypes.ts";

export function normalizeMountPath(path: string): string {
  if (!path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) {
    throw new KernelRevisionWorkspaceError(
      "EINVAL",
      "The revision mount path must be an absolute workspace path",
    );
  }
  if (path === "/") return path;
  return path.replace(/\/+$/, "");
}

export function reconcileNamespace(
  filesystem: KernelFileSystem,
  mountPath: string,
  rootRealPath: string,
  applyId: string,
  plans: readonly ApplyPlan[],
): ApplyPlan[] {
  const deletions = plans
    .filter((plan) => plan.changed.stat === null)
    .flatMap((plan) => plan.changed.removedPaths)
    .sort((left, right) => depth(right) - depth(left));
  const deletedDirectories: string[] = [];
  for (const path of deletions) {
    const entry = safeLstat(filesystem, mountPath, rootRealPath, path);
    if (entry?.type === "directory") deletedDirectories.push(path);
    else if (entry) removePath(filesystem, mountPath, rootRealPath, path);
  }

  const livePlans = plans
    .filter((plan) => plan.changed.stat !== null)
    .sort((left, right) => {
      const leftDir = left.changed.stat!.type === "directory" ? 0 : 1;
      const rightDir = right.changed.stat!.type === "directory" ? 0 : 1;
      return leftDir - rightDir || depth(left.changed.paths[0]!) - depth(right.changed.paths[0]!);
    });
  const byLocalInode = new Map(
    livePlans.flatMap((plan) =>
      plan.localInode === undefined ? [] : [[plan.localInode.toString(), plan] as const],
    ),
  );
  const parked = new Map<string, string>();
  const reconciled = new Map<string, ApplyPlan>();

  const reconcilePlan = (sourcePlan: ApplyPlan) => {
    const plan = { ...sourcePlan };
    const change = plan.changed;
    const primary = change.paths[0]!;
    ensureParents(filesystem, mountPath, rootRealPath, primary);
    const existing = safeLstat(filesystem, mountPath, rootRealPath, primary);
    let localInode = plan.localInode;
    if (localInode !== undefined && existing?.ino !== localInode) {
      const source =
        parked.get(localInode.toString()) ??
        findLivePath(
          filesystem,
          mountPath,
          rootRealPath,
          localInode,
          plan.sourcePaths,
          change.paths,
        );
      if (source) {
        if (existing && existing.ino !== localInode)
          removePath(filesystem, mountPath, rootRealPath, primary);
        assertParentInside(filesystem, mountPath, rootRealPath, primary);
        filesystem.rename(guestPath(mountPath, source), guestPath(mountPath, primary));
      } else {
        localInode = undefined;
      }
    }
    if (localInode === undefined) {
      if (existing) removePath(filesystem, mountPath, rootRealPath, primary);
      createPath(filesystem, mountPath, primary, change);
    }
    for (const alias of change.paths.slice(1)) {
      ensureParents(filesystem, mountPath, rootRealPath, alias);
      const aliasEntry = safeLstat(filesystem, mountPath, rootRealPath, alias);
      const primaryEntry = safeLstat(filesystem, mountPath, rootRealPath, primary);
      if (primaryEntry === undefined)
        throw new KernelRevisionWorkspaceError("EIO", "The applied inode lost its primary path");
      if (aliasEntry?.ino === primaryEntry.ino) continue;
      if (aliasEntry) removePath(filesystem, mountPath, rootRealPath, alias);
      if (change.stat!.type === "directory")
        throw new KernelRevisionWorkspaceError("EPERM", "Directories cannot have hard links");
      assertParentInside(filesystem, mountPath, rootRealPath, alias);
      filesystem.link(guestPath(mountPath, primary), guestPath(mountPath, alias));
    }
    if (localInode !== undefined) {
      const oldPaths = new Set(plan.sourcePaths);
      for (const path of change.removedPaths) oldPaths.add(path);
      for (const oldPath of oldPaths) {
        if (change.paths.includes(oldPath)) continue;
        const entry = safeLstat(filesystem, mountPath, rootRealPath, oldPath);
        if (entry?.ino === localInode) removePath(filesystem, mountPath, rootRealPath, oldPath);
      }
    }
    plan.localInode = filesystem.lstat(guestPath(mountPath, primary)).ino;
    reconciled.set(change.inode.toString(), plan);
  };

  // Move or create directories first so child path lookups see their final parents.
  for (const plan of livePlans) {
    if (plan.changed.stat?.type === "directory") reconcilePlan(plan);
  }

  const filePlans = livePlans.filter((plan) => plan.changed.stat?.type !== "directory");
  const toPark = new Set<string>();
  for (const plan of filePlans) {
    if (plan.localInode === undefined) continue;
    const destination = plan.changed.paths[0]!;
    const destinationEntry = safeLstat(filesystem, mountPath, rootRealPath, destination);
    if (!destinationEntry || destinationEntry.ino === plan.localInode) continue;
    const blocker = byLocalInode.get(destinationEntry.ino.toString());
    if (blocker && blocker.changed.paths[0] !== destination) {
      if (blocker.changed.stat?.type === "directory") {
        throw new KernelRevisionWorkspaceError(
          "ENOTSUP",
          "Directory rename cycles cannot be applied safely",
        );
      }
      toPark.add(destinationEntry.ino.toString());
    }
  }
  let parkIndex = 0;
  for (const inode of toPark) {
    const plan = byLocalInode.get(inode)!;
    const source = findLivePath(
      filesystem,
      mountPath,
      rootRealPath,
      plan.localInode!,
      plan.sourcePaths,
      plan.changed.paths,
    );
    if (!source) continue;
    let temp: string;
    do {
      temp = `/.signalbox-apply-${hash(applyId)}-${parkIndex++}`;
    } while (safeLstat(filesystem, mountPath, rootRealPath, temp));
    assertParentInside(filesystem, mountPath, rootRealPath, temp);
    filesystem.rename(guestPath(mountPath, source), guestPath(mountPath, temp));
    parked.set(inode, temp);
  }

  for (const plan of filePlans) reconcilePlan(plan);
  for (const path of deletedDirectories.sort((left, right) => depth(right) - depth(left))) {
    removePath(filesystem, mountPath, rootRealPath, path);
  }
  return plans.map((plan) => reconciled.get(plan.changed.inode.toString()) ?? plan);
}

function createPath(
  filesystem: KernelFileSystem,
  mountPath: string,
  path: string,
  change: CommitInode,
): void {
  const guest = guestPath(mountPath, path);
  const metadata = change.posix?.mode ?? 0o666;
  switch (change.stat!.type) {
    case "directory":
      filesystem.mkdir(guest, metadata);
      return;
    case "symlink":
      filesystem.symlink(change.symlinkTarget!, guest);
      return;
    case "file": {
      const fd = filesystem.open(
        guest,
        KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_CREAT | KernelOpenFlags.O_EXCL,
        metadata,
      );
      filesystem.close(fd);
      return;
    }
  }
}

function removePath(
  filesystem: KernelFileSystem,
  mountPath: string,
  rootRealPath: string,
  path: string,
): void {
  const entry = safeLstat(filesystem, mountPath, rootRealPath, path);
  if (!entry) return;
  const guest = guestPath(mountPath, path);
  if (entry.type === "directory") filesystem.rmdir(guest);
  else filesystem.unlink(guest);
}

function ensureParents(
  filesystem: KernelFileSystem,
  mountPath: string,
  rootRealPath: string,
  path: string,
): void {
  const segments = path.slice(1).split("/");
  let current = "";
  for (const segment of segments.slice(0, -1)) {
    current += `/${segment}`;
    if (!safeLstat(filesystem, mountPath, rootRealPath, current))
      filesystem.mkdir(guestPath(mountPath, current));
  }
  assertParentInside(filesystem, mountPath, rootRealPath, path);
}

function safeLstat(
  filesystem: KernelFileSystem,
  mountPath: string,
  rootRealPath: string,
  path: string,
) {
  try {
    assertParentInside(filesystem, mountPath, rootRealPath, path);
    return filesystem.lstat(guestPath(mountPath, path));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function assertParentInside(
  filesystem: KernelFileSystem,
  mountPath: string,
  rootRealPath: string,
  path: string,
): void {
  const slash = path.lastIndexOf("/");
  const parent = slash === 0 ? "/" : path.slice(0, slash);
  const realParent = filesystem.realpath(guestPath(mountPath, parent));
  const within =
    rootRealPath === "/"
      ? realParent.startsWith("/")
      : realParent === rootRealPath || realParent.startsWith(`${rootRealPath}/`);
  if (!within)
    throw new KernelRevisionWorkspaceError(
      "EACCES",
      "A workspace path resolves outside the revision root",
    );
}

function findLivePath(
  filesystem: KernelFileSystem,
  mountPath: string,
  rootRealPath: string,
  inode: Inode,
  candidates: readonly string[],
  desired: readonly string[],
): string | undefined {
  for (const path of [...desired, ...candidates]) {
    const entry = safeLstat(filesystem, mountPath, rootRealPath, path);
    if (entry?.ino === inode) return path;
  }
  return undefined;
}

function guestPath(mountPath: string, workspacePath: string): string {
  return mountPath === "/" ? workspacePath : `${mountPath}${workspacePath}`;
}

function depth(path: string): number {
  return path.split("/").length;
}

function hash(value: string): string {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return (result >>> 0).toString(36);
}
