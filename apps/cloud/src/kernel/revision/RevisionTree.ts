import { Schema } from "effect";
import type { ChangedInode, ForkCommit } from "../FilePersistencePorts.ts";
import { isPosixMetadata } from "../PosixStorage.ts";
import type { Inode, Stat } from "../storage.ts";
import { KernelRevisionWorkspaceError, errorCode } from "./RevisionErrors.ts";
import type { ApplyPlan, Persistence, TreeEntry } from "./RevisionTypes.ts";

const TreeEntrySchema = Schema.Struct({
  inode: Schema.String,
  paths: Schema.Array(Schema.String),
  stat: Schema.Struct({
    type: Schema.Literals(["file", "directory", "symlink"]),
    size: Schema.BigIntFromString,
    nlink: Schema.BigIntFromString,
    atimeNs: Schema.BigIntFromString,
    mtimeNs: Schema.BigIntFromString,
    ctimeNs: Schema.BigIntFromString,
  }),
  symlinkTarget: Schema.NullOr(Schema.String),
  posix: Schema.NullOr(
    Schema.Struct({ mode: Schema.Number, uid: Schema.Number, gid: Schema.Number }),
  ),
});
const ManifestJson = Schema.fromJsonString(Schema.Array(TreeEntrySchema));
const decodeManifestJson = Schema.decodeUnknownSync(ManifestJson);
const encodeManifestJson = Schema.encodeSync(ManifestJson);

function encodeStat(stat: Stat): Stat {
  return { ...stat };
}

export function encodeManifest(manifest: ReadonlyMap<string, TreeEntry>): string {
  return encodeManifestJson(
    [...manifest.values()].sort((left, right) => left.inode.localeCompare(right.inode)),
  );
}

export function decodeManifest(json: string): Map<string, TreeEntry> {
  let entries: readonly (typeof TreeEntrySchema.Type)[];
  try {
    entries = decodeManifestJson(json);
  } catch {
    throw new KernelRevisionWorkspaceError("EIO", "The facet workspace manifest is invalid");
  }
  const result = new Map<string, TreeEntry>();
  for (const candidate of entries) {
    const validPaths = candidate.paths.every(
      (path) =>
        path.startsWith("/") &&
        path !== "/" &&
        !path.includes("\0") &&
        !path
          .split("/")
          .slice(1)
          .some((part) => !part || part === "." || part === ".."),
    );
    if (
      !/^[1-9][0-9]*$/.test(candidate.inode) ||
      !validPaths ||
      new Set(candidate.paths).size !== candidate.paths.length ||
      candidate.stat.size < 0n ||
      candidate.stat.nlink < 0n ||
      (candidate.stat.type === "directory" && candidate.paths.length !== 1) ||
      (candidate.stat.type === "symlink") !== (candidate.symlinkTarget !== null) ||
      (candidate.posix !== null && !isPosixMetadata(candidate.posix)) ||
      result.has(candidate.inode)
    ) {
      throw new KernelRevisionWorkspaceError("EIO", "The facet workspace manifest is invalid");
    }
    result.set(candidate.inode, { ...candidate, paths: [...candidate.paths] });
  }
  return result;
}

export function scanTree(storage: Persistence["storage"], root: Inode): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  const visitedDirectories = new Set<Inode>();
  const visit = (inode: Inode, path: string, rootNode = false): void => {
    const stat = storage.stat(inode);
    const key = inode.toString();
    if (!rootNode) {
      const existing = entries.get(key);
      if (existing) {
        entries.set(key, { ...existing, paths: [...existing.paths, path].sort() });
      } else {
        let posix: TreeEntry["posix"] = null;
        try {
          posix = storage.posix.get(inode);
        } catch (error) {
          if (errorCode(error) !== "ENOTSUP") throw error;
        }
        entries.set(key, {
          inode: key,
          paths: [path],
          stat: encodeStat(stat),
          symlinkTarget: stat.type === "symlink" ? storage.readlink(inode) : null,
          posix,
        });
      }
    }
    if (stat.type !== "directory") return;
    if (visitedDirectories.has(inode))
      throw new KernelRevisionWorkspaceError("EIO", "The workspace has a directory cycle");
    visitedDirectories.add(inode);
    for (const child of storage.readdir(inode)) {
      const childPath = path === "/" ? `/${child.name}` : `${path}/${child.name}`;
      visit(child.inode, childPath);
    }
  };
  visit(root, "/", true);
  return entries;
}

export function diffTrees(
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
  dirty: ReadonlySet<string>,
): ChangedInode[] {
  const changed: ChangedInode[] = [];
  for (const inode of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(inode);
    const current = after.get(inode);
    if (old && current && !dirty.has(inode) && sameTreeEntry(old, current)) continue;
    changed.push({
      inode: BigInt(inode) as Inode,
      paths: current?.paths ?? [],
      removedPaths: old?.paths.filter((path) => !current?.paths.includes(path)) ?? [],
    });
  }
  return changed;
}

export function applyChangesToManifest(
  baseline: ReadonlyMap<string, TreeEntry>,
  plans: readonly ApplyPlan[],
): Map<string, TreeEntry> {
  const affectedPaths = new Set(
    plans.flatMap((plan) => [...plan.changed.paths, ...plan.changed.removedPaths]),
  );
  const manifest = new Map<string, TreeEntry>();
  for (const [inode, entry] of baseline) {
    const paths = entry.paths.filter((path) => !affectedPaths.has(path));
    if (paths.length === 0) continue;
    manifest.set(
      inode,
      paths.length === entry.paths.length
        ? entry
        : { ...entry, paths, stat: { ...entry.stat, nlink: BigInt(paths.length) } },
    );
  }

  for (const plan of plans) {
    const change = plan.changed;
    if (!change.stat) continue;
    if (plan.localInode === undefined)
      throw new KernelRevisionWorkspaceError("EIO", "The applied inode has no live identity");
    const inode = plan.localInode.toString();
    const prior = baseline.get(inode);
    manifest.set(inode, {
      inode,
      paths: [...change.paths].sort(),
      stat: { ...change.stat },
      symlinkTarget: change.stat.type === "symlink" ? change.symlinkTarget : null,
      posix: change.posix === undefined ? (prior?.posix ?? null) : change.posix,
    });
  }
  return manifest;
}

function sameTreeEntry(left: TreeEntry, right: TreeEntry): boolean {
  return (
    left.inode === right.inode &&
    left.paths.length === right.paths.length &&
    left.paths.every((path, index) => path === right.paths[index]) &&
    left.stat.type === right.stat.type &&
    left.stat.size === right.stat.size &&
    left.stat.nlink === right.stat.nlink &&
    left.stat.atimeNs === right.stat.atimeNs &&
    left.stat.mtimeNs === right.stat.mtimeNs &&
    left.stat.ctimeNs === right.stat.ctimeNs &&
    left.symlinkTarget === right.symlinkTarget &&
    left.posix?.mode === right.posix?.mode &&
    left.posix?.uid === right.posix?.uid &&
    left.posix?.gid === right.posix?.gid
  );
}

export async function hydrateChangedFiles(
  changed: readonly ChangedInode[],
  storage: Persistence["storage"],
  persistence: Persistence,
  signal: AbortSignal,
): Promise<void> {
  for (const { inode } of changed) {
    let stat: Stat;
    try {
      stat = storage.stat(inode);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (stat.type !== "file") continue;
    signal.throwIfAborted();
    await persistence.runLeaf(() => storage.readInto(inode, 0n, new Uint8Array(0)), signal);
  }
}

export function sameCommit(left: ForkCommit, right: ForkCommit): boolean {
  return (
    left.repository === right.repository && left.fork === right.fork && left.commit === right.commit
  );
}
