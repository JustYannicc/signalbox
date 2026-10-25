import type { CommitInode } from "../FilePersistencePorts.ts";
import { isPosixMetadata } from "../PosixStorage.ts";
import type { Inode } from "../storage.ts";
import { KernelRevisionWorkspaceError } from "./RevisionErrors.ts";
import type { ApplyPlan, Persistence, TreeEntry } from "./RevisionTypes.ts";

export function validatePlans(changed: readonly CommitInode[]): ApplyPlan[] {
  const seenInodes = new Set<string>();
  const desiredPaths = new Set<string>();
  return changed.map((entry) => {
    const remoteInode = entry.inode.toString();
    if (seenInodes.has(remoteInode))
      throw new KernelRevisionWorkspaceError("EINVAL", "The VM returned a duplicate changed inode");
    seenInodes.add(remoteInode);
    for (const path of [...entry.paths, ...entry.removedPaths]) validateWorkspacePath(path);
    if (entry.stat) {
      if (entry.stat.size < 0n || entry.stat.nlink < 0n)
        throw new KernelRevisionWorkspaceError("EINVAL", "The VM returned invalid inode metadata");
      if (entry.paths.length === 0)
        throw new KernelRevisionWorkspaceError("EINVAL", "A live inode needs at least one path");
      if (entry.stat.type === "symlink" && entry.symlinkTarget === null)
        throw new KernelRevisionWorkspaceError("EINVAL", "A symlink needs a target");
      if (entry.stat.nlink > BigInt(Number.MAX_SAFE_INTEGER))
        throw new KernelRevisionWorkspaceError(
          "EOVERFLOW",
          "The VM returned an unsupported link count",
        );
      if (entry.stat.type === "directory" && entry.paths.length !== 1)
        throw new KernelRevisionWorkspaceError("EPERM", "Directories cannot have hard links");
      if (entry.stat.type === "symlink" && entry.symlinkTarget !== null) {
        if (
          entry.symlinkTarget.includes("\0") ||
          BigInt(new TextEncoder().encode(entry.symlinkTarget).byteLength) !== entry.stat.size
        ) {
          throw new KernelRevisionWorkspaceError(
            "EINVAL",
            "The VM returned invalid symlink metadata",
          );
        }
      }
      if (entry.posix != null && !isPosixMetadata(entry.posix))
        throw new KernelRevisionWorkspaceError("EINVAL", "The VM returned invalid POSIX metadata");
    }
    for (const path of entry.paths) {
      if (desiredPaths.has(path))
        throw new KernelRevisionWorkspaceError(
          "EINVAL",
          "The VM returned more than one inode for a path",
        );
      desiredPaths.add(path);
    }
    return { changed: entry, sourcePaths: [] };
  });
}

export function findRetiredInodes(
  before: ReadonlyMap<string, TreeEntry>,
  current: ReadonlyMap<string, TreeEntry>,
  plans: readonly ApplyPlan[],
): Set<string> {
  const retired = new Set<string>();
  const paths = new Set(
    plans.filter((plan) => plan.changed.stat === null).flatMap((plan) => plan.changed.removedPaths),
  );
  for (const [inode, entry] of before)
    if (entry.paths.some((path) => paths.has(path))) retired.add(inode);
  for (const [inode, entry] of current)
    if (entry.paths.some((path) => paths.has(path))) retired.add(inode);
  return retired;
}

export function resolveLocalInodes(
  before: ReadonlyMap<string, TreeEntry>,
  current: ReadonlyMap<string, TreeEntry>,
  plans: readonly ApplyPlan[],
  retired: ReadonlySet<string>,
  storage: Persistence["storage"],
): ApplyPlan[] {
  const used = new Set<string>();
  const byPath = (tree: ReadonlyMap<string, TreeEntry>) =>
    new Map(
      [...tree.values()].flatMap((entry) => entry.paths.map((path) => [path, entry] as const)),
    );
  const oldPaths = byPath(before);
  const livePaths = byPath(current);
  const moving = new Set<string>();
  for (const plan of plans) {
    if (!plan.changed.stat) continue;
    for (const path of plan.changed.removedPaths) {
      const entry = oldPaths.get(path) ?? livePaths.get(path);
      if (entry && !retired.has(entry.inode)) moving.add(entry.inode);
    }
  }
  const assigned = new Map<ApplyPlan, ApplyPlan>();
  const ordered = [...plans].sort(
    (left, right) =>
      Number(left.changed.removedPaths.length === 0) -
      Number(right.changed.removedPaths.length === 0),
  );
  for (const plan of ordered) {
    if (!plan.changed.stat) {
      assigned.set(plan, plan);
      continue;
    }
    const candidates = [
      ...plan.changed.removedPaths.map((path) => oldPaths.get(path) ?? livePaths.get(path)),
      ...plan.changed.paths.map((path) => livePaths.get(path) ?? oldPaths.get(path)),
    ].filter((entry): entry is TreeEntry => entry !== undefined);
    const sourceInodes = new Set(
      plan.changed.removedPaths.flatMap((path) => [
        oldPaths.get(path)?.inode,
        livePaths.get(path)?.inode,
      ]),
    );
    const candidate = candidates.find((entry) => {
      if (
        retired.has(entry.inode) ||
        used.has(entry.inode) ||
        (moving.has(entry.inode) && !sourceInodes.has(entry.inode))
      ) {
        return false;
      }
      try {
        return storage.stat(BigInt(entry.inode) as Inode).type === plan.changed.stat!.type;
      } catch {
        return false;
      }
    });
    if (!candidate) {
      assigned.set(plan, plan);
      continue;
    }
    used.add(candidate.inode);
    const sourcePaths = [
      ...new Set([
        ...(before.get(candidate.inode)?.paths ?? []),
        ...(current.get(candidate.inode)?.paths ?? []),
      ]),
    ];
    assigned.set(plan, { ...plan, localInode: BigInt(candidate.inode) as Inode, sourcePaths });
  }
  return plans.map((plan) => assigned.get(plan) ?? plan);
}

function validateWorkspacePath(path: string): void {
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    path === "/" ||
    path
      .split("/")
      .slice(1)
      .some((part) => !part || part === "." || part === "..")
  ) {
    throw new KernelRevisionWorkspaceError(
      "EINVAL",
      "The persistence port returned a path outside the revision root",
    );
  }
}
