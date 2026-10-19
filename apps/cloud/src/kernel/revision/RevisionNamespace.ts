import type { KernelFileSystem } from "../KernelFileSystem.ts";
import { KernelOpenFlags } from "../KernelFileSystem.ts";
import type { CommitInode } from "../FilePersistencePorts.ts";
import type { Inode } from "../storage.ts";
import { KernelRevisionWorkspaceError, errorCode } from "./RevisionErrors.ts";
import type { ApplyPlan, Persistence } from "./RevisionTypes.ts";
import { assertOwnedResolvedPath, guestPath } from "./RevisionNamespaceOwnership.ts";

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
  storage: Persistence["storage"],
  applyId: string,
  plans: readonly ApplyPlan[],
): ApplyPlan[] {
  const deletions = plans
    .filter((plan) => plan.changed.stat === null)
    .flatMap((plan) => plan.changed.removedPaths)
    .sort((left, right) => depth(right) - depth(left));
  const deletedDirectories: { readonly path: string; readonly inode: Inode }[] = [];
  for (const path of deletions) {
    const entry = safeLstat(filesystem, mountPath, rootRealPath, storage, path);
    if (entry?.type === "directory") deletedDirectories.push({ path, inode: entry.ino });
    else if (entry) removePath(filesystem, mountPath, rootRealPath, storage, path);
  }

  const livePlans = plans
    .filter((plan) => plan.changed.stat !== null)
    .sort((left, right) => {
      const leftDir = left.changed.stat!.type === "directory" ? 0 : 1;
      const rightDir = right.changed.stat!.type === "directory" ? 0 : 1;
      const depthOrder = depth(left.changed.paths[0]!) - depth(right.changed.paths[0]!);
      const identityOrder =
        Number(left.localInode === undefined) - Number(right.localInode === undefined);
      return leftDir - rightDir || depthOrder || identityOrder;
    });
  const parked = new Map<string, string>();
  const reconciled = new Map<string, ApplyPlan>();

  const reconcilePlan = (sourcePlan: ApplyPlan) => {
    const plan = { ...sourcePlan };
    const change = plan.changed;
    const primary = change.paths[0]!;
    ensureParents(filesystem, mountPath, rootRealPath, storage, primary);
    const existing = safeLstat(filesystem, mountPath, rootRealPath, storage, primary);
    let localInode = plan.localInode;
    if (localInode !== undefined && existing?.ino !== localInode) {
      const source =
        parked.get(localInode.toString()) ??
        findLivePath(
          filesystem,
          mountPath,
          rootRealPath,
          storage,
          localInode,
          plan.sourcePaths,
          change.paths,
        );
      if (source) {
        if (existing && existing.ino !== localInode)
          removePath(filesystem, mountPath, rootRealPath, storage, primary);
        assertParentInside(filesystem, mountPath, rootRealPath, storage, primary);
        filesystem.rename(guestPath(mountPath, source), guestPath(mountPath, primary));
      } else {
        localInode = undefined;
      }
    }
    if (localInode === undefined) {
      if (existing) removePath(filesystem, mountPath, rootRealPath, storage, primary);
      createPath(filesystem, mountPath, primary, change);
    }
    for (const alias of change.paths.slice(1)) {
      ensureParents(filesystem, mountPath, rootRealPath, storage, alias);
      const aliasEntry = safeLstat(filesystem, mountPath, rootRealPath, storage, alias);
      const primaryEntry = safeLstat(filesystem, mountPath, rootRealPath, storage, primary);
      if (primaryEntry === undefined)
        throw new KernelRevisionWorkspaceError("EIO", "The applied inode lost its primary path");
      if (aliasEntry?.ino === primaryEntry.ino) continue;
      if (aliasEntry) removePath(filesystem, mountPath, rootRealPath, storage, alias);
      if (change.stat!.type === "directory")
        throw new KernelRevisionWorkspaceError("EPERM", "Directories cannot have hard links");
      assertParentInside(filesystem, mountPath, rootRealPath, storage, alias);
      filesystem.link(guestPath(mountPath, primary), guestPath(mountPath, alias));
    }
    if (localInode !== undefined) {
      const oldPaths = new Set(plan.sourcePaths);
      for (const path of change.removedPaths) oldPaths.add(path);
      for (const oldPath of oldPaths) {
        if (change.paths.includes(oldPath)) continue;
        const entry = safeLstat(filesystem, mountPath, rootRealPath, storage, oldPath);
        if (entry?.ino === localInode)
          removePath(filesystem, mountPath, rootRealPath, storage, oldPath);
      }
    }
    const finalEntry = safeLstat(filesystem, mountPath, rootRealPath, storage, primary);
    if (finalEntry === undefined)
      throw new KernelRevisionWorkspaceError("EIO", "The applied inode lost its primary path");
    plan.localInode = finalEntry.ino;
    reconciled.set(change.inode.toString(), plan);
  };

  parkMovingInodes(filesystem, mountPath, rootRealPath, storage, applyId, livePlans, parked);

  for (const deletion of deletedDirectories.sort(
    (left, right) => depth(right.path) - depth(left.path),
  )) {
    const current = safeLstat(filesystem, mountPath, rootRealPath, storage, deletion.path);
    if (current?.ino === deletion.inode)
      removePath(filesystem, mountPath, rootRealPath, storage, deletion.path);
  }

  // Parent directories must settle first so descendants resolve in the final namespace.
  for (const plan of livePlans) {
    if (plan.changed.stat?.type === "directory") reconcilePlan(plan);
  }

  const filePlans = livePlans.filter((plan) => plan.changed.stat?.type !== "directory");
  for (const plan of filePlans) reconcilePlan(plan);
  // A parent move can restore a desired hardlink before its parked alias is consumed.
  for (const [inode, path] of parked) {
    const entry = safeLstat(filesystem, mountPath, rootRealPath, storage, path);
    if (!entry) continue;
    if (entry.ino.toString() !== inode)
      throw new KernelRevisionWorkspaceError("ESTALE", "A parked inode changed during apply");
    removePath(filesystem, mountPath, rootRealPath, storage, path);
  }
  return plans.map((plan) => reconciled.get(plan.changed.inode.toString()) ?? plan);
}

function parkMovingInodes(
  filesystem: KernelFileSystem,
  mountPath: string,
  rootRealPath: string,
  storage: Persistence["storage"],
  applyId: string,
  plans: readonly ApplyPlan[],
  parked: Map<string, string>,
): void {
  const moving = plans
    .filter(
      (plan) =>
        plan.localInode !== undefined &&
        plan.sourcePaths.some((path) => !plan.changed.paths.includes(path)),
    )
    .sort((left, right) => {
      const deepestSource = (plan: ApplyPlan) => Math.max(...plan.sourcePaths.map(depth));
      return (
        deepestSource(right) - deepestSource(left) ||
        left.localInode!.toString().localeCompare(right.localInode!.toString())
      );
    });

  const finalPaths = plans.flatMap((plan) => plan.changed.paths);
  let parkIndex = 0;
  for (const plan of moving) {
    const inode = plan.localInode!;
    const source = findLivePath(
      filesystem,
      mountPath,
      rootRealPath,
      storage,
      inode,
      plan.sourcePaths,
      plan.changed.paths,
    );
    if (!source) continue;
    let temp: string;
    do {
      temp = `/.signalbox-apply-${hash(applyId)}-${parkIndex++}`;
    } while (
      finalPaths.some((path) => path === temp || path.startsWith(`${temp}/`)) ||
      safeLstat(filesystem, mountPath, rootRealPath, storage, temp)
    );
    assertParentInside(filesystem, mountPath, rootRealPath, storage, temp);
    filesystem.rename(guestPath(mountPath, source), guestPath(mountPath, temp));
    parked.set(inode.toString(), temp);
  }
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
  storage: Persistence["storage"],
  path: string,
): void {
  const entry = safeLstat(filesystem, mountPath, rootRealPath, storage, path);
  if (!entry) return;
  const guest = guestPath(mountPath, path);
  if (entry.type === "directory") filesystem.rmdir(guest);
  else filesystem.unlink(guest);
}

function ensureParents(
  filesystem: KernelFileSystem,
  mountPath: string,
  rootRealPath: string,
  storage: Persistence["storage"],
  path: string,
): void {
  const segments = path.slice(1).split("/");
  let current = "";
  for (const segment of segments.slice(0, -1)) {
    current += `/${segment}`;
    if (!safeLstat(filesystem, mountPath, rootRealPath, storage, current))
      filesystem.mkdir(guestPath(mountPath, current));
  }
  assertParentInside(filesystem, mountPath, rootRealPath, storage, path);
}

function safeLstat(
  filesystem: KernelFileSystem,
  mountPath: string,
  rootRealPath: string,
  storage: Persistence["storage"],
  path: string,
) {
  try {
    assertParentInside(filesystem, mountPath, rootRealPath, storage, path);
    const guest = guestPath(mountPath, path);
    const resolved = filesystem.resolve(guest, { followFinal: false });
    assertOwnedResolvedPath(resolved, storage);
    const entry = filesystem.lstat(guest);
    if (entry.ino !== resolved.inode)
      throw new KernelRevisionWorkspaceError("ESTALE", "A workspace path changed during apply");
    return entry;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function assertParentInside(
  filesystem: KernelFileSystem,
  mountPath: string,
  rootRealPath: string,
  storage: Persistence["storage"],
  path: string,
): void {
  const slash = path.lastIndexOf("/");
  const parent = slash === 0 ? "/" : path.slice(0, slash);
  const parentPath = guestPath(mountPath, parent);
  const resolvedParent = filesystem.resolve(parentPath);
  assertOwnedResolvedPath(resolvedParent, storage);
  const realParent = filesystem.realpath(parentPath);
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
  storage: Persistence["storage"],
  inode: Inode,
  candidates: readonly string[],
  desired: readonly string[],
): string | undefined {
  for (const path of [...desired, ...candidates]) {
    const entry = safeLstat(filesystem, mountPath, rootRealPath, storage, path);
    if (entry?.ino === inode) return path;
  }
  return undefined;
}

function depth(path: string): number {
  return path.split("/").length;
}

function hash(value: string): string {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return (result >>> 0).toString(36);
}
