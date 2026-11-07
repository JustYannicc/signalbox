import type { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import type { CliFileMetadata } from "../CliFileWorkingSet.ts";
import type { ClaudeCliLookup } from "../ClaudeCliKernelPort.ts";
import { KernelOpenFlags } from "../../kernel/KernelOpenFlags.ts";
import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../../kernel/KernelSyscallPort.ts";
import { sha256Hex, UNCHANGED_DIGEST } from "../cliFilesystem/Digest.ts";
import { turnBudget } from "../cliFilesystem/Turn.ts";
import { nodeFsError } from "../../isolate/NodeFsError.ts";

const code = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";

/** Reads named paths now; a denial asks the CLI to re-index so denial rules stay in one place. */
export async function lookupCliPaths(
  filesystem: KernelFileSystem,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<ClaudeCliLookup[]> {
  const results: ClaudeCliLookup[] = [];
  const turn = turnBudget();
  for (const path of paths) {
    signal.throwIfAborted();
    await turn();
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

/**
 * Hashes current bytes in Computer so the CLI can keep a cached copy without re-reading it. The
 * buffer is the size the CLI's index read; a file that differs from it now reports unverified.
 */
export async function digestCliFiles(
  filesystem: KernelFileSystem,
  files: readonly { readonly path: string; readonly size: number }[],
  signal: AbortSignal,
  unchanged?: (path: string, ino: bigint) => Promise<boolean>,
): Promise<(string | null)[]> {
  const digests: (string | null)[] = [];
  const turn = turnBudget(16);
  for (const { path, size } of files) {
    signal.throwIfAborted();
    await turn(size);
    if (typeof path !== "string" || !path.startsWith("/"))
      throw new TypeError("CLI digest paths must be absolute");
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("Invalid CLI digest size");
    digests.push(
      size > MAX_DIGEST_FILE_BYTES
        ? null
        : await digestFile(filesystem, path, size, signal, unchanged),
    );
  }
  return digests;
}

async function digestFile(
  filesystem: KernelFileSystem,
  path: string,
  size: number,
  signal: AbortSignal,
  unchanged?: (path: string, ino: bigint) => Promise<boolean>,
): Promise<string | null> {
  let fd: number;
  try {
    const stat = await filesystem.lstatAsync(path, signal);
    if (stat.type !== "file" || stat.size !== BigInt(size)) return null;
    if (unchanged !== undefined && (await unchanged(path, stat.ino))) return UNCHANGED_DIGEST;
    fd = await filesystem.openAsync(path, KernelOpenFlags.O_RDONLY, undefined, signal);
  } catch (cause) {
    if (["ENOENT", "ENOTDIR", "EACCES"].includes(code(cause))) return null;
    throw nodeFsError(cause, "open", path);
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    const read = (target: Uint8Array, at: number) =>
      filesystem.readAsync(fd, target, BigInt(at), signal).catch((cause) => {
        throw nodeFsError(cause, "read", path);
      });
    while (offset < size) {
      const count = await read(
        bytes.subarray(offset, Math.min(size, offset + KERNEL_SYSCALL_MAX_IO_BYTES)),
        offset,
      );
      // Truncated, or grown past the size the CLI holds, since lstat.
      if (count === 0) return null;
      offset += count;
    }
    if ((await read(new Uint8Array(1), size)) !== 0) return null;
    return await sha256Hex(bytes);
  } finally {
    try {
      filesystem.close(fd);
    } catch (cause) {
      throw nodeFsError(cause, "close", path);
    }
  }
}
