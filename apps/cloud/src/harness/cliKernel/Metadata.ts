import type { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import type { CliFileMetadata } from "../CliFileWorkingSet.ts";
import { kernelError } from "../../kernel/KernelErrno.ts";
import { nodeFsError } from "../../isolate/NodeFsError.ts";

/** Index accessible metadata without turning unsolicited traversal into a CLI permission failure. */
export async function readCliMetadata(
  filesystem: KernelFileSystem,
  metadataLimit: number,
  signal: AbortSignal,
) {
  const entries: CliFileMetadata[] = [];
  const visit = async (path: string) => {
    signal.throwIfAborted();
    const stat = await filesystem.lstatAsync(path, signal).catch((cause) => {
      throw nodeFsError(cause, "lstat", path);
    });
    if (entries.length >= metadataLimit) throw kernelError("E2BIG");
    let target: string | undefined;
    if (stat.type === "symlink") {
      try {
        target = filesystem.readlink(path);
      } catch (cause) {
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
