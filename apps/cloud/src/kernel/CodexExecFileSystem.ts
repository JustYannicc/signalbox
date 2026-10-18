// @effect-diagnostics nodeBuiltinImport:off - workerd provides this byte codec at the wire boundary.
import * as NodeBuffer from "node:buffer";
import type { ExecSessionHandler } from "./CodexExecSessions.ts";
import { object, RpcError, string } from "./CodexExecProtocol.ts";
import { KernelOpenFlags, type KernelFileSystem } from "./KernelFileSystem.ts";
import { fileUriToGuestPath } from "./execServer/ProcessesLaunch.ts";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const methods = new Set([
  "fs/readFile",
  "fs/writeFile",
  "fs/createDirectory",
  "fs/getMetadata",
  "fs/canonicalize",
]);

/** Borrows the same filesystem used by commands; session cleanup never closes it. */
export class CodexExecFileSystem implements ExecSessionHandler {
  readonly #filesystem: KernelFileSystem;

  constructor(options: { readonly filesystem: KernelFileSystem }) {
    this.#filesystem = options.filesystem;
  }

  async request(method: string, value: unknown, signal: AbortSignal): Promise<unknown> {
    if (!methods.has(method)) throw new RpcError(-32601, "Method not found");
    if (signal.aborted) throw new DOMException("Filesystem request aborted", "AbortError");
    try {
      const params = object(value);
      if (params.sandbox !== undefined && params.sandbox !== null) {
        throw new RpcError(-32600, "Filesystem sandbox requests are unsupported");
      }
      const path = fileUriToGuestPath(string(params.path, "path"));
      const follow = optionalBoolean(params.followSymlinks, "followSymlinks", true);
      switch (method) {
        case "fs/readFile":
          if (!follow) this.#rejectSymlinks(path);
          return { dataBase64: this.#read(path).toString("base64") };
        case "fs/writeFile": {
          const bytes = decodeBytes(params.dataBase64);
          if (!follow) this.#rejectSymlinks(path);
          this.#write(path, bytes);
          return {};
        }
        case "fs/createDirectory":
          this.#mkdir(path, optionalBoolean(params.recursive, "recursive", true), follow);
          return {};
        case "fs/getMetadata": {
          if (!follow) this.#rejectSymlinks(path);
          const isSymlink = this.#filesystem.lstat(path).type === "symlink";
          const stat = this.#filesystem.stat(path);
          return {
            isDirectory: stat.type === "directory",
            isFile: stat.type === "file",
            isSymlink,
            size: exactNumber(stat.size),
            // Kernel storage has no birth time. Upstream also uses zero when it is unavailable.
            createdAtMs: 0,
            modifiedAtMs: exactNumber(stat.mtimeNs / 1_000_000n),
          };
        }
        case "fs/canonicalize":
          return { path: guestPathToUri(this.#filesystem.realpath(path)) };
      }
    } catch (error) {
      throw filesystemRpcError(error);
    }
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  #read(path: string) {
    const fs = this.#filesystem;
    const fd = fs.open(path, KernelOpenFlags.O_RDONLY);
    try {
      const stat = fs.fstat(fd);
      requireFile(stat.type);
      if (stat.size > BigInt(MAX_FILE_BYTES)) {
        throw new RpcError(-32600, "File exceeds the whole-file RPC limit");
      }
      const bytes = NodeBuffer.Buffer.alloc(exactNumber(stat.size));
      let offset = 0;
      while (offset < bytes.byteLength) {
        const count = fs.read(fd, bytes.subarray(offset), null);
        if (count === 0) break;
        offset += count;
      }
      return bytes.subarray(0, offset);
    } finally {
      fs.close(fd);
    }
  }

  #write(path: string, bytes: Uint8Array) {
    const fs = this.#filesystem;
    const fd = fs.open(path, KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_CREAT);
    try {
      requireFile(fs.fstat(fd).type);
      fs.ftruncate(fd, 0n);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const count = fs.write(fd, bytes.subarray(offset), null);
        if (count === 0) throw new RpcError(-32603, "Filesystem write made no progress");
        offset += count;
      }
    } finally {
      fs.close(fd);
    }
  }

  #mkdir(path: string, recursive: boolean, follow: boolean) {
    if (!follow) this.#rejectSymlinks(path);
    if (!recursive) {
      this.#filesystem.mkdir(path);
      return;
    }
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      try {
        if (this.#filesystem.stat(current).type !== "directory") {
          throw new RpcError(-32603, "Path is not a directory");
        }
        continue;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      this.#filesystem.mkdir(current);
    }
    if (parts.length === 0 && this.#filesystem.stat(path).type !== "directory") {
      throw new RpcError(-32603, "Path is not a directory");
    }
  }

  #rejectSymlinks(path: string) {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      current += `/${part}`;
      try {
        if (this.#filesystem.lstat(current).type === "symlink") {
          throw new RpcError(-32600, "Path contains a symbolic link");
        }
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }
    }
  }
}

function decodeBytes(value: unknown) {
  const encoded = string(value, "dataBase64");
  if (encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) {
    throw new RpcError(-32600, "File exceeds the whole-file RPC limit");
  }
  const bytes = NodeBuffer.Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new RpcError(-32600, "dataBase64 must be standard padded base64");
  }
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new RpcError(-32600, "File exceeds the whole-file RPC limit");
  }
  return bytes;
}

function optionalBoolean(value: unknown, field: string, fallback: boolean) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new RpcError(-32602, `${field} must be a boolean`);
  return value;
}

function requireFile(type: string) {
  if (type !== "file") throw new RpcError(-32600, "Path is not a regular file");
}

function exactNumber(value: bigint) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new RpcError(-32603, "Filesystem value cannot be represented exactly");
  }
  return number;
}

function guestPathToUri(path: string) {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function filesystemRpcError(error: unknown) {
  if (error instanceof RpcError) return error;
  const code = errorCode(error);
  const rpcCode =
    code === "ENOENT"
      ? -32004
      : code === "EINVAL" || code === "EACCES" || code === "EPERM" || code === "EROFS"
        ? -32600
        : -32603;
  return new RpcError(rpcCode, typeof code === "string" ? code : "Filesystem operation failed");
}
