import { KernelOpenFlags, type KernelFileSystem } from "../KernelFileSystem.ts";
import type { KernelBashCredentials } from "./BashContext.ts";
import { errno, range, string } from "./BashMemory.ts";

const encoder = new TextEncoder();
export function createBashMetadata(options: {
  readonly memory: () => WebAssembly.Memory;
  readonly filesystem: KernelFileSystem;
  readonly credentials: KernelBashCredentials;
}) {
  return {
    stat_metadata: (
      fd: number,
      pathPointer: number,
      length: number,
      follow: number,
      out: number,
    ) => {
      try {
        range(options.memory(), out, 12);
        if (pathPointer !== 0) {
          const path = string(options.memory(), pathPointer, length);
          if (fd >= 0 && !path.startsWith("/")) return 58;
          if (follow) options.filesystem.stat(path);
          else options.filesystem.lstat(path);
        } else options.filesystem.fstat(fd >>> 0);
        // Inode storage has no POSIX mode or owner fields. Do not invent them.
        return 58;
      } catch (error) {
        return errno(error);
      }
    },
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
        const view = new DataView(memory.buffer);
        view.setUint32(needed >>> 0, size, true);
        if (size > capacity >>> 0) return 68;
        range(memory, out, size);
        view.setUint32(out >>> 0, uid, true);
        view.setUint32((out >>> 0) + 4, gid ?? members.length, true);
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
