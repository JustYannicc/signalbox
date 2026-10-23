import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import { isPosixMetadata } from "../kernel/PosixStorage.ts";
import type { PosixStorage } from "../kernel/PosixStorage.ts";
import type { MachineProgramEntry } from "./MachineProgramInventory.ts";

const index = "/usr/share/signalbox/machine-programs.json";
export const MACHINE_PROGRAM_STUB = new TextEncoder().encode(
  "Signalbox machine executable entry. Bytes are on the machine; exec uses Computer admission.\n",
);

export function computerProgramSeeds(filesystem: KernelFileSystem) {
  const read = (path: string) => {
    const resolved = filesystem.resolve(path, { followFinal: false });
    if (resolved.stat.type !== "file") throw new Error(`Program seed is not a file: ${path}`);
    const storage = resolved.mount.storage as PosixStorage;
    const bytes = new Uint8Array(Number(resolved.stat.size));
    if (storage.readInto(resolved.inode, 0n, bytes) !== bytes.length)
      throw new Error("Short program seed read");
    return bytes;
  };
  let prior: readonly MachineProgramEntry[] = [];
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(read(index)));
    if (!Array.isArray(decoded) || !decoded.every(validEntry))
      throw new Error("Invalid program seed ownership");
    prior = decoded;
  } catch (error) {
    if (!isMissingProgramFile(error)) throw error;
  }
  const matches = (entry: MachineProgramEntry) => {
    try {
      const actual = filesystem.lstat(entry.path);
      const metadata = actual.posix;
      if (metadata?.mode !== entry.mode || metadata.uid !== entry.uid || metadata.gid !== entry.gid)
        return false;
      if (entry.target !== undefined)
        return actual.type === "symlink" && filesystem.readlink(entry.path) === entry.target;
      if (actual.type !== "file" || actual.size !== BigInt(MACHINE_PROGRAM_STUB.length))
        return false;
      return read(entry.path).every((value, offset) => value === MACHINE_PROGRAM_STUB[offset]);
    } catch (error) {
      if (isMissingProgramFile(error)) return false;
      throw error;
    }
  };
  return {
    prior: prior.filter(matches),
    write(entries: readonly MachineProgramEntry[]) {
      const parent = filesystem.resolve(index.slice(0, index.lastIndexOf("/")));
      if (parent.mount.readOnly) throw new Error("Program seed ownership is read-only");
      const storage = parent.mount.storage as PosixStorage;
      const temporary = ".machine-programs.json.next";
      const inode = storage.posix.create(parent.inode, temporary, {
        type: "file",
        exclusive: false,
        metadata: { mode: 0o644, uid: 0, gid: 0 },
      });
      try {
        const bytes = new TextEncoder().encode(JSON.stringify(entries));
        storage.truncate(inode, 0n);
        if (storage.write(inode, 0n, bytes) !== bytes.length)
          throw new Error("Short program seed index write");
        storage.rename(parent.inode, temporary, parent.inode, "machine-programs.json");
      } finally {
        storage.release(inode);
      }
    },
    remove(entry: MachineProgramEntry) {
      if (!matches(entry)) return;
      const parent = filesystem.resolve(entry.path.slice(0, entry.path.lastIndexOf("/")) || "/");
      if (parent.mount.readOnly) throw new Error("Program inventory is read-only");
      (parent.mount.storage as PosixStorage).unlink(
        parent.inode,
        entry.path.slice(entry.path.lastIndexOf("/") + 1),
        { directory: false },
      );
    },
  };
}

export function isMissingProgramFile(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function validEntry(value: unknown): value is MachineProgramEntry {
  return (
    isPosixMetadata(value) &&
    "path" in value &&
    typeof value.path === "string" &&
    value.path.startsWith("/") &&
    !value.path.includes("\0") &&
    value.path
      .slice(1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..") &&
    (!("target" in value) || typeof value.target === "string")
  );
}
