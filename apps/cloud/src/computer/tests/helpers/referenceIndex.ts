import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import type { CliFileMetadata } from "../../../harness/CliFileWorkingSet.ts";
import { kernelError } from "../../../kernel/KernelErrno.ts";
import { nodeFsError } from "../../../isolate/NodeFsError.ts";

/**
 * The CLI index as it was read before the bulk walk: one lstat, readdir and readlink per path
 * through the syscall layer. Tests check the bulk walk against it, entry for entry.
 */
export async function referenceCliMetadata(
  filesystem: KernelFileSystem,
  metadataLimit: number,
  signal: AbortSignal,
) {
  const entries: CliFileMetadata[] = [];
  // The walk yields between a listing and its entries, so the CLI or another writer can remove a
  // child meanwhile. A gone child is left out; the change feed brings it to the next round.
  const vanished = (path: string, cause: unknown) =>
    path !== "/" && ["ENOENT", "ENOTDIR"].includes(code(cause));
  const visit = async (path: string) => {
    signal.throwIfAborted();
    let stat;
    try {
      stat = await filesystem.lstatAsync(path, signal);
    } catch (cause) {
      if (vanished(path, cause)) return;
      throw nodeFsError(cause, "lstat", path);
    }
    if (entries.length >= metadataLimit) throw kernelError("E2BIG");
    let target: string | undefined;
    if (stat.type === "symlink") {
      try {
        target = filesystem.readlink(path);
      } catch (cause) {
        if (vanished(path, cause)) return;
        throw nodeFsError(cause, "readlink", path);
      }
    }
    let entry: CliFileMetadata = {
      path,
      stat,
      ...(target === undefined ? {} : { target }),
    };
    const index = entries.length;
    entries.push(entry);
    if (stat.type === "directory") {
      const denied = (cause: unknown) =>
        typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EACCES";
      let children: string[];
      try {
        children = await filesystem.readdirAsync(path, signal);
      } catch (cause) {
        if (vanished(path, cause)) {
          entries.length = index;
          return;
        }
        if (!denied(cause)) throw nodeFsError(cause, "scandir", path);
        // Indexing is unsolicited. Retain the directory and its denial for actual CLI access.
        entries[index] = { ...entry, directoryDenial: { read: "EACCES" } };
        return;
      }
      for (const name of children) {
        try {
          await visit(`${path === "/" ? "" : path}/${name}`);
        } catch (cause) {
          if (!denied(cause)) throw cause;
          entry = { ...entry, children, directoryDenial: { search: "EACCES" } };
          entries[index] = entry;
          break;
        }
      }
    }
  };
  await visit("/");
  return entries;
}

const code = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
