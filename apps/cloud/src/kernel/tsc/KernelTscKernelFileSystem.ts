import type {
  KernelTscFileKind,
  KernelTscFileSystemPort,
  KernelTscFileSystemRequest,
  KernelTscFileSystemResponse,
} from "../KernelTscFileSystem.ts";
import { KernelOpenFlags, type KernelFileSystem } from "../KernelFileSystem.ts";

const CHUNK_BYTES = 64 * 1024;
const encoder = new TextEncoder();

const ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  EACCES: "permission denied",
  EEXIST: "file exists",
  EFBIG: "file too large",
  EINVAL: "invalid argument",
  EIO: "input/output error",
  EISDIR: "is a directory",
  ELOOP: "too many symbolic links encountered",
  ENAMETOOLONG: "file name too long",
  ENOENT: "no such file or directory",
  ENOSPC: "no space left on device",
  ENOTDIR: "not a directory",
  ENOTEMPTY: "directory not empty",
  ENOTSUP: "operation not supported",
  EPERM: "operation not permitted",
  EROFS: "read-only file system",
});

/** Adapts the local kernel filesystem; Worker callers implement the same port over RPC. */
export class KernelTscKernelFileSystem implements KernelTscFileSystemPort {
  readonly #filesystem: KernelFileSystem;

  constructor(filesystem: KernelFileSystem) {
    this.#filesystem = filesystem;
  }

  async execute(request: KernelTscFileSystemRequest): Promise<KernelTscFileSystemResponse> {
    try {
      switch (request.op) {
        case "read":
          return { kind: "bytes", bytes: this.#read(request.path) };
        case "stat":
          return this.#stat(request.path);
        case "readDirectory":
          return this.#readDirectory(request.path);
        case "realpath":
          return { kind: "path", path: this.#filesystem.realpath(request.path) };
        case "write":
          this.#write(request.path, request.data, request.append);
          return { kind: "written" };
        case "remove":
          this.#remove(request.path);
          return { kind: "written" };
        case "chtimes":
          if (request.atimeNs !== undefined || request.mtimeNs !== undefined) {
            this.#filesystem.setTimes(request.path, {
              ...(request.atimeNs === undefined ? {} : { atimeNs: request.atimeNs }),
              ...(request.mtimeNs === undefined ? {} : { mtimeNs: request.mtimeNs }),
            });
          }
          return { kind: "written" };
      }
    } catch (error) {
      if (
        request.op === "read" ||
        request.op === "stat" ||
        request.op === "readDirectory" ||
        request.op === "realpath"
      ) {
        return isMissing(error)
          ? { kind: "missing" }
          : { kind: "error", message: hostError(request, error) };
      }
      return { kind: "error", message: hostError(request, error) };
    }
  }

  #read(path: string): Uint8Array {
    const fd = this.#filesystem.open(path, KernelOpenFlags.O_RDONLY);
    try {
      const chunks: Uint8Array[] = [];
      const buffer = new Uint8Array(CHUNK_BYTES);
      let total = 0;
      for (;;) {
        const count = this.#filesystem.read(fd, buffer, null);
        if (count === 0) break;
        total += count;
        if (!Number.isSafeInteger(total)) throw kernelError("EFBIG");
        chunks.push(buffer.slice(0, count));
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } finally {
      this.#filesystem.close(fd);
    }
  }

  #stat(path: string): KernelTscFileSystemResponse {
    const stat = this.#filesystem.stat(path);
    return {
      kind: "stat",
      type: stat.type === "directory" ? "directory" : stat.type === "file" ? "file" : "other",
      size: stat.size,
      mtimeNs: stat.mtimeNs,
    };
  }

  #readDirectory(path: string): KernelTscFileSystemResponse {
    const names = this.#filesystem
      .readdir(path)
      .map((name) => ({ name, bytes: encoder.encode(name) }));
    names.sort((left, right) => compareBytes(left.bytes, right.bytes));
    const entries: { name: string; kind: KernelTscFileKind }[] = [];
    for (const { name } of names) {
      const stat = this.#filesystem.lstat(joinPath(path, name));
      entries.push({
        name,
        kind:
          stat.type === "directory"
            ? "directory"
            : stat.type === "symlink"
              ? "symlink"
              : stat.type === "file"
                ? "file"
                : "other",
      });
    }
    return { kind: "entries", entries };
  }

  #write(path: string, data: Uint8Array, append: boolean): void {
    this.#ensureParents(path);
    const flags =
      KernelOpenFlags.O_WRONLY |
      KernelOpenFlags.O_CREAT |
      (append ? KernelOpenFlags.O_APPEND : KernelOpenFlags.O_TRUNC);
    const fd = this.#filesystem.open(path, flags, 0o666);
    try {
      let offset = 0;
      while (offset < data.byteLength) {
        const written = this.#filesystem.write(fd, data.subarray(offset), null);
        if (written === 0) throw kernelError("EIO");
        offset += written;
      }
    } finally {
      this.#filesystem.close(fd);
    }
  }

  #remove(path: string): void {
    const stat = this.#filesystem.lstat(path);
    if (stat.type !== "directory") {
      this.#filesystem.unlink(path);
      return;
    }
    for (const name of this.#filesystem.readdir(path)) this.#remove(joinPath(path, name));
    this.#filesystem.rmdir(path);
  }

  #ensureParents(path: string): void {
    const separator = path.lastIndexOf("/");
    if (separator < 0) return;
    const parent = separator === 0 ? "/" : path.slice(0, separator);
    if (parent === "") return;
    try {
      if (this.#filesystem.stat(parent).type !== "directory") throw kernelError("ENOTDIR");
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    this.#ensureParents(parent);
    this.#filesystem.mkdir(parent, 0o777);
  }
}

function joinPath(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function hostError(request: KernelTscFileSystemRequest, error: unknown): string {
  const operation =
    request.op === "write"
      ? "open"
      : request.op === "remove"
        ? "remove"
        : request.op === "chtimes"
          ? "chtimes"
          : request.op;
  const code =
    error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const reason = code === undefined ? errorMessage(error) : (ERROR_TEXT[code] ?? code);
  return `${operation} ${request.path}: ${reason || "host file system error"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function kernelError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
