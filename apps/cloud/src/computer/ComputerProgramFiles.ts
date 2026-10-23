import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import type { PosixStorage } from "../kernel/PosixStorage.ts";
import type { MachineProgramEntry, MachineProgramInventory } from "./MachineProgramInventory.ts";
import {
  computerProgramSeeds,
  isMissingProgramFile,
  MACHINE_PROGRAM_STUB,
} from "./ComputerProgramSeeds.ts";

/** Seed the image namespace without overwriting catalog bytes or workspace files. */
export function seedComputerProgramFiles(
  filesystem: KernelFileSystem,
  inventory: MachineProgramInventory,
  localPaths: ReadonlyMap<string, string>,
) {
  const ensureDirectory = (path: string): void => {
    if (path === "/") return;
    try {
      if (filesystem.stat(path).type !== "directory")
        throw new Error(`Program parent is not a directory: ${path}`);
      return;
    } catch (error) {
      if (!isMissingProgramFile(error)) throw error;
    }
    const split = path.lastIndexOf("/");
    ensureDirectory(path.slice(0, split) || "/");
    const parent = filesystem.resolve(path.slice(0, split) || "/");
    if (parent.mount.readOnly) throw new Error("Program inventory seed is read-only");
    const storage = parent.mount.storage as PosixStorage;
    const inode = storage.posix.create(parent.inode, path.slice(split + 1), {
      type: "directory",
      exclusive: true,
      metadata: { uid: 0, gid: 0, mode: 0o755 },
    });
    storage.release(inode);
  };
  const ownership = computerProgramSeeds(filesystem);
  if (inventory.entries.length === 0 && ownership.prior.length === 0) return;
  const owned = new Map(ownership.prior.map((entry) => [entry.path, entry]));
  const desired = inventory.entries.map((entry) => {
    const local = localPaths.get(entry.path);
    const target = local !== entry.path ? (local ?? entry.target) : undefined;
    return {
      path: entry.path,
      mode: target === undefined ? entry.mode : 0o777,
      uid: entry.uid,
      gid: entry.gid,
      ...(target === undefined ? {} : { target }),
    };
  });
  const pending: MachineProgramEntry[] = [];
  const managed: MachineProgramEntry[] = [];
  for (const entry of desired) {
    const previous = owned.get(entry.path);
    if (previous !== undefined) {
      managed.push(entry);
      if (
        previous.target !== entry.target ||
        previous.mode !== entry.mode ||
        previous.uid !== entry.uid ||
        previous.gid !== entry.gid
      )
        pending.push(entry);
      continue;
    }
    try {
      filesystem.lstat(entry.path);
    } catch (error) {
      if (!isMissingProgramFile(error)) throw error;
      managed.push(entry);
      pending.push(entry);
    }
  }
  if (
    pending.length === 0 &&
    managed.length === ownership.prior.length &&
    ownership.prior.every((entry) => managed.some((candidate) => candidate.path === entry.path))
  )
    return;
  // Record intended ownership before changing entries, so restart can finish a partial seed.
  ensureDirectory("/usr/share/signalbox");
  ownership.write([...ownership.prior, ...managed]);
  const retained = new Set(
    managed.filter((entry) => !pending.includes(entry)).map((entry) => entry.path),
  );
  for (const entry of ownership.prior) if (!retained.has(entry.path)) ownership.remove(entry);
  for (const entry of pending) {
    const split = entry.path.lastIndexOf("/");
    const parentPath = entry.path.slice(0, split) || "/";
    ensureDirectory(parentPath);
    const parent = filesystem.resolve(parentPath);
    if (parent.mount.readOnly) throw new Error("Program inventory seed is read-only");
    const storage = parent.mount.storage as PosixStorage;
    const target = entry.target;
    const inode = storage.posix.create(parent.inode, entry.path.slice(split + 1), {
      ...(target === undefined ? { type: "file" as const } : { type: "symlink" as const, target }),
      exclusive: true,
      metadata: { mode: target === undefined ? entry.mode : 0o777, uid: entry.uid, gid: entry.gid },
    });
    try {
      if (
        target === undefined &&
        storage.write(inode, 0n, MACHINE_PROGRAM_STUB) !== MACHINE_PROGRAM_STUB.length
      )
        throw new Error("Short machine program seed write");
    } finally {
      storage.release(inode);
    }
  }
  ownership.write(managed);
}
