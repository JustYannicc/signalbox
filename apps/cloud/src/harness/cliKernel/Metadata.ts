import type { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import type { CliFileMetadata } from "../CliFileWorkingSet.ts";
import type { ClaudeCliLookup } from "../ClaudeCliKernelPort.ts";
import { kernelError } from "../../kernel/KernelErrno.ts";
import { KernelOpenFlags } from "../../kernel/KernelOpenFlags.ts";
import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../../kernel/KernelSyscallPort.ts";
import { sha256Hex } from "../cliFilesystem/Digest.ts";
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

const code = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";

/** Reads named paths now; a denial asks the CLI to re-index so denial rules stay in one place. */
export async function lookupCliPaths(
  filesystem: KernelFileSystem,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<ClaudeCliLookup[]> {
  const results: ClaudeCliLookup[] = [];
  for (const path of paths) {
    signal.throwIfAborted();
    if (typeof path !== "string" || !path.startsWith("/"))
      throw new TypeError("CLI lookup paths must be absolute");
    let stat;
    try {
      stat = await filesystem.lstatAsync(path, signal);
    } catch (cause) {
      const failure = code(cause);
      if (failure === "ENOENT" || failure === "ENOTDIR") results.push({ path, missing: true });
      else if (failure === "EACCES") results.push({ path, denied: true });
      else throw nodeFsError(cause, "lstat", path);
      continue;
    }
    let target: string | undefined;
    if (stat.type === "symlink") {
      try {
        target = filesystem.readlink(path);
      } catch (cause) {
        throw nodeFsError(cause, "readlink", path);
      }
    }
    const entry: CliFileMetadata = { path, stat, ...(target === undefined ? {} : { target }) };
    if (stat.type !== "directory") {
      results.push({ path, entry });
      continue;
    }
    try {
      results.push({ path, entry, names: await filesystem.readdirAsync(path, signal) });
    } catch (cause) {
      if (code(cause) !== "EACCES") throw nodeFsError(cause, "scandir", path);
      results.push({ path, denied: true });
    }
  }
  return results;
}

/**
 * A digest buffers the whole file in the owner, and no single request may exhaust its isolate.
 * The CLI facet's own budget is far smaller, so it never caches a file this large anyway.
 */
const MAX_DIGEST_FILE_BYTES = 64 * 1024 * 1024;

/** Hashes current bytes in Computer so the CLI can keep a cached copy without re-reading it. */
export async function digestCliFiles(
  filesystem: KernelFileSystem,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<(string | null)[]> {
  const digests: (string | null)[] = [];
  for (const path of paths) {
    signal.throwIfAborted();
    if (typeof path !== "string" || !path.startsWith("/"))
      throw new TypeError("CLI digest paths must be absolute");
    let fd: number;
    let size: number;
    try {
      const stat = await filesystem.lstatAsync(path, signal);
      if (stat.type !== "file" || stat.size > BigInt(MAX_DIGEST_FILE_BYTES)) {
        digests.push(null);
        continue;
      }
      size = Number(stat.size);
      fd = await filesystem.openAsync(path, KernelOpenFlags.O_RDONLY, undefined, signal);
    } catch (cause) {
      if (["ENOENT", "ENOTDIR", "EACCES"].includes(code(cause))) {
        digests.push(null);
        continue;
      }
      throw nodeFsError(cause, "open", path);
    }
    try {
      // A file that changed size since lstat hashes differently, which is the right answer.
      const bytes = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const count = await filesystem
          .readAsync(
            fd,
            bytes.subarray(offset, Math.min(size, offset + KERNEL_SYSCALL_MAX_IO_BYTES)),
            BigInt(offset),
            signal,
          )
          .catch((cause) => {
            throw nodeFsError(cause, "read", path);
          });
        if (count === 0) break;
        offset += count;
      }
      digests.push(await sha256Hex(bytes.subarray(0, offset)));
    } finally {
      try {
        filesystem.close(fd);
      } catch (cause) {
        throw nodeFsError(cause, "close", path);
      }
    }
  }
  return digests;
}
