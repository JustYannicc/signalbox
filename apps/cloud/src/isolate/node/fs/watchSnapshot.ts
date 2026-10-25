// @effect-diagnostics nodeBuiltinImport:off - POSIX paths describe the virtual filesystem; reads use KernelFileSystem.
import * as NodePath from "node:path";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import type { KernelStat } from "./metadata.ts";
import type { WatchEventType } from "./watchOptions.ts";

interface Fingerprint {
  readonly type: KernelStat["type"];
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface Snapshot {
  /** A descriptor-alias path can change when a descriptor opens or closes, with no storage write. */
  readonly descriptorDependent: boolean;
  readonly rootType: KernelStat["type"] | "missing";
  readonly rootFingerprint?: Fingerprint;
  readonly entries: ReadonlyMap<string, Fingerprint>;
}

export interface SnapshotChange {
  readonly eventType: WatchEventType;
  readonly filename: string;
}

function fingerprint(stat: KernelStat): Fingerprint {
  return {
    type: stat.type,
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function takeSnapshot(kernelFs: KernelFileSystem, path: string, recursive: boolean): Snapshot {
  const root = kernelFs.stat(path);
  let descriptorDependent = kernelFs.resolvesThroughDescriptors(path);
  if (root.type !== "directory") {
    return {
      descriptorDependent,
      rootType: root.type,
      rootFingerprint: fingerprint(root),
      entries: new Map([["", fingerprint(root)]]),
    };
  }

  const entries = new Map<string, Fingerprint>();
  const visit = (directory: string, prefix: string): void => {
    let names: string[];
    try {
      names = kernelFs.readdir(directory);
    } catch (error) {
      if (isMissingError(error)) return;
      throw error;
    }

    for (const name of names) {
      const childPath = NodePath.posix.join(directory, name);
      if (kernelFs.resolvesThroughDescriptors(childPath)) descriptorDependent = true;
      let stat: KernelStat;
      try {
        stat = kernelFs.lstat(childPath);
      } catch (error) {
        if (isMissingError(error)) continue;
        throw error;
      }
      const relativePath = prefix === "" ? name : NodePath.posix.join(prefix, name);
      entries.set(relativePath, fingerprint(stat));
      if (recursive && stat.type === "directory") visit(childPath, relativePath);
    }
  };
  visit(path, "");
  return { descriptorDependent, rootType: root.type, rootFingerprint: fingerprint(root), entries };
}

export function takeWatchSnapshot(
  kernelFs: KernelFileSystem,
  path: string,
  recursive: boolean,
): Snapshot {
  return takeSnapshot(kernelFs, path, recursive);
}

export function takeWatchSnapshotAllowMissing(
  kernelFs: KernelFileSystem,
  path: string,
  recursive: boolean,
): Snapshot {
  try {
    return takeSnapshot(kernelFs, path, recursive);
  } catch (error) {
    if (isMissingError(error))
      return {
        descriptorDependent: kernelFs.resolvesThroughDescriptors(path),
        rootType: "missing",
        entries: new Map(),
      };
    throw error;
  }
}

function equalFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return (
    left.type === right.type &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isRename(left: Fingerprint, right: Fingerprint): boolean {
  return (
    left.type !== right.type ||
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.nlink !== right.nlink
  );
}

export function diffWatchSnapshots(
  previous: Snapshot,
  current: Snapshot,
  rootPath: string,
): SnapshotChange[] {
  if (previous.rootType !== current.rootType) {
    return [{ eventType: "rename", filename: NodePath.posix.basename(rootPath) || rootPath }];
  }
  const previousRoot = previous.rootFingerprint;
  const currentRoot = current.rootFingerprint;
  if (
    previousRoot !== undefined &&
    currentRoot !== undefined &&
    (previousRoot.dev !== currentRoot.dev || previousRoot.ino !== currentRoot.ino)
  ) {
    return [{ eventType: "rename", filename: NodePath.posix.basename(rootPath) || rootPath }];
  }
  const changes: SnapshotChange[] = [];
  const names = new Set([...previous.entries.keys(), ...current.entries.keys()]);
  for (const name of [...names].sort()) {
    const before = previous.entries.get(name);
    const after = current.entries.get(name);
    const filename = name === "" ? NodePath.posix.basename(rootPath) || rootPath : name;
    if (before === undefined || after === undefined) {
      changes.push({ eventType: "rename", filename });
    } else if (!equalFingerprint(before, after)) {
      changes.push({ eventType: isRename(before, after) ? "rename" : "change", filename });
    }
  }
  return changes;
}
