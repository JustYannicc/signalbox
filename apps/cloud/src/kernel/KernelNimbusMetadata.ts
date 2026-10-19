import { KernelOpenFlags, type KernelFileSystem } from "./KernelFileSystem.ts";
import type { KernelBashCredentials } from "./bash/BashContext.ts";
import { asWasiMemory, type WasiMemory } from "./wasi/internal_wasi_memory.ts";
import { errno, range, string } from "./bash/BashMemory.ts";
import { assertBashPosixCredentials } from "./bash/BashEnvironment.ts";

const encoder = new TextEncoder();
export function createKernelNimbusMetadata(options: {
  readonly memory: () => WebAssembly.Memory | WasiMemory;
  readonly filesystem: KernelFileSystem;
  readonly credentials?: Pick<KernelBashCredentials, "uid" | "gid" | "euid" | "egid">;
  readonly directoryFd?: (fd: number) => number;
}) {
  if (options.credentials !== undefined)
    assertBashPosixCredentials(options.credentials, options.filesystem);
  const at = <T>(fd: number, path: string, operation: (filesystem: KernelFileSystem) => T): T => {
    if (path.startsWith("/") || fd === -1) return operation(options.filesystem);
    const anchored = options.filesystem.fork(options.filesystem.descriptors);
    try {
      anchored.fchdir(options.directoryFd?.(fd >>> 0) ?? fd >>> 0);
      return operation(anchored);
    } finally {
      anchored.dispose();
    }
  };
  const change = (operation: () => void): number => {
    try {
      operation();
      return 0;
    } catch (error) {
      return errno(error);
    }
  };
  const storedFd = (fd: number): number => {
    const descriptor = options.filesystem.descriptors.get(fd >>> 0);
    if (descriptor.mount === undefined || descriptor.inode === undefined) {
      throw Object.assign(new Error("Nimbus descriptor has no inode metadata"), { code: "EBADF" });
    }
    return fd >>> 0;
  };
  return {
    stat_metadata: (
      fd: number,
      pathPointer: number,
      length: number,
      follow: number,
      out: number,
    ) => {
      try {
        const memory = options.memory();
        range(memory, out, 12);
        let type: "file" | "directory" | "symlink" | "character";
        let metadata: ReturnType<KernelFileSystem["getPosixMetadata"]>;
        if (pathPointer !== 0) {
          const path = string(memory, pathPointer, length);
          const result = at(fd, path, (filesystem) => ({
            type: (follow ? filesystem.stat(path) : filesystem.lstat(path)).type,
            metadata: filesystem.getPosixMetadata(path, follow !== 0),
          }));
          type = result.type;
          metadata = result.metadata;
        } else {
          // Nimbus libc keeps preview1's stream stat when this extension reports EBADF.
          const descriptor = storedFd(fd);
          type = options.filesystem.fstat(descriptor).type;
          metadata = options.filesystem.getPosixMetadataForFd(descriptor);
        }
        const bits = {
          file: 0o100000,
          directory: 0o040000,
          symlink: 0o120000,
          character: 0o020000,
        };
        const view = asWasiMemory(memory).view(out, 12);
        view.setUint32(0, bits[type] | (metadata.mode & 0o7777), true);
        view.setUint32(4, metadata.uid, true);
        view.setUint32(8, metadata.gid, true);
        return 0;
      } catch (error) {
        return errno(error);
      }
    },
    chmod: (pathPointer: number, length: number, mode: number) =>
      change(() => {
        const path = string(options.memory(), pathPointer, length);
        options.filesystem.chmod(path, mode & 0o7777);
      }),
    fchmod: (fd: number, mode: number) =>
      change(() => options.filesystem.fchmod(storedFd(fd), mode & 0o7777)),
    chown: (
      fd: number,
      pathPointer: number,
      length: number,
      uidBits: number,
      gidBits: number,
      follow: number,
    ) =>
      change(() => {
        const uid = uidBits >>> 0;
        const gid = gidBits >>> 0;
        if (pathPointer === 0) {
          const descriptor = storedFd(fd);
          const current = options.filesystem.getPosixMetadataForFd(descriptor);
          options.filesystem.fchown(
            descriptor,
            uid === 0xffff_ffff ? current.uid : uid,
            gid === 0xffff_ffff ? current.gid : gid,
          );
          return;
        }
        const path = string(options.memory(), pathPointer, length);
        at(fd, path, (filesystem) => {
          const current = filesystem.getPosixMetadata(path, follow !== 0);
          filesystem.chown(
            path,
            uid === 0xffff_ffff ? current.uid : uid,
            gid === 0xffff_ffff ? current.gid : gid,
            follow !== 0,
          );
        });
      }),
    account: (
      kind: number,
      by: number,
      namePointer: number,
      nameLength: number,
      id: number,
      out: number,
      capacity: number,
      needed: number,
    ) => {
      try {
        if ((kind !== 0 && kind !== 1) || by < 0 || by > 2) return 28;
        const memory = options.memory();
        range(memory, needed, 4);
        const name = by === 1 ? string(memory, namePointer, nameLength) : undefined;
        const rows = readAccounts(options.filesystem, kind === 0 ? "/etc/passwd" : "/etc/group");
        const row =
          by === 2
            ? rows[id >>> 0]
            : rows.find((row) => (by === 1 ? row[0] === name : Number(row[2]) === id >>> 0));
        if (row === undefined) return 44;
        const uid = Number(row[2]);
        const gid = kind === 0 ? Number(row[3]) : undefined;
        if (
          !Number.isSafeInteger(uid) ||
          uid < 0 ||
          uid > 0xffff_ffff ||
          (gid !== undefined && (!Number.isSafeInteger(gid) || gid < 0 || gid > 0xffff_ffff))
        )
          return 28;
        const members = kind === 1 ? (row[3] ? row[3].split(",") : []) : [];
        const strings =
          kind === 0
            ? [row[0]!, row[1]!, row[4]!, row[5]!, row[6]!]
            : [row[0]!, row[1]!, ...members];
        const encoded = strings.map((value) => encoder.encode(value));
        const size = 8 + encoded.reduce((total, bytes) => total + bytes.length + 1, 0);
        asWasiMemory(memory).u32(needed, size);
        if (size > capacity >>> 0) return 68;
        range(memory, out, size);
        const view = asWasiMemory(memory).view(out, 8);
        view.setUint32(0, uid, true);
        view.setUint32(4, gid ?? members.length, true);
        let cursor = (out >>> 0) + 8;
        for (const bytes of encoded) {
          const target = range(memory, cursor, bytes.length + 1);
          target.set(bytes);
          target[bytes.length] = 0;
          cursor += bytes.length + 1;
        }
        return 0;
      } catch (error) {
        return errno(error);
      }
    },
  };
}

function readAccounts(filesystem: KernelFileSystem, path: string): string[][] {
  const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const size = filesystem.fstat(fd).size;
    if (size > 1_048_576n)
      throw Object.assign(new Error("Account file is too large"), { code: "EFBIG" });
    const bytes = new Uint8Array(Number(size));
    let count = 0;
    while (count < bytes.length) {
      const read = filesystem.read(fd, bytes.subarray(count), null);
      if (read === 0) break;
      count += read;
    }
    const fields = path.endsWith("passwd") ? 7 : 4;
    return new TextDecoder()
      .decode(bytes.subarray(0, count))
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.split(":"))
      .filter(
        (row) =>
          row.length >= fields &&
          row[0] !== "" &&
          validId(row[2]) &&
          (fields !== 7 || validId(row[3])),
      );
  } finally {
    filesystem.close(fd);
  }
}

function validId(value: string | undefined): boolean {
  if (value === undefined || !/^\d+$/.test(value)) return false;
  const id = Number(value);
  return Number.isSafeInteger(id) && id <= 0xffff_ffff;
}
