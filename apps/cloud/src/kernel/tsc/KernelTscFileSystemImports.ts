import type {
  KernelTscFileSystemPort,
  KernelTscFileSystemRequest,
  KernelTscFileSystemResponse,
} from "../KernelTscFileSystem.ts";

const OP_READ = 0;
const OP_STAT = 1;
const OP_READ_DIRECTORY = 2;
const OP_REALPATH = 3;
const OP_WRITE = 4;
const OP_APPEND = 5;
const OP_REMOVE = 6;
const OP_CHTIMES = 7;
const MAX_I32 = 0x7fff_ffff;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface JSPI {
  readonly Suspending: new (
    fn: (op: number, pointer: number, length: number) => Promise<number>,
  ) => WebAssembly.ImportValue;
}

/** Implements the pinned ts_wasm host ABI, including its one-result staging buffer. */
export function createKernelTscHostImports(
  filesystem: KernelTscFileSystemPort,
  memory: () => WebAssembly.Memory,
): WebAssembly.Imports {
  const wasm = WebAssembly as unknown as JSPI;
  if (typeof wasm.Suspending !== "function") {
    throw Object.assign(new Error("tsc-rs filesystem imports require WebAssembly JSPI"), {
      code: "ERR_KERNEL_JSPI_UNAVAILABLE",
    });
  }

  let staged: Uint8Array = new Uint8Array();
  const fs = new wasm.Suspending(async (op, pointer, length) => {
    staged = new Uint8Array();
    const start = pointer >>> 0;
    const size = length >>> 0;
    const before = memory().buffer;
    if (start + size > before.byteLength) return -1;
    const requestBytes = new Uint8Array(before, start, size).slice();
    const request = decodeRequest(op >>> 0, requestBytes);
    if (request === undefined) return -1;

    let response: KernelTscFileSystemResponse;
    try {
      response = await filesystem.execute(request);
    } catch (error) {
      response = { kind: "error", message: errorMessage(error) };
    }
    staged = resultBytes(op >>> 0, response);
    const status = resultStatus(op >>> 0, response, staged.byteLength);
    if (status === undefined) {
      staged = new Uint8Array();
      return -1;
    }
    return status;
  });

  return {
    ts_host: {
      fs,
      fs_take: (pointer: number) => {
        const bytes = staged;
        staged = new Uint8Array();
        // Reacquire after the async fs import: it may have suspended while the guest grew memory.
        new Uint8Array(memory().buffer).set(bytes, pointer >>> 0);
      },
    },
  };
}

function decodeRequest(op: number, bytes: Uint8Array): KernelTscFileSystemRequest | undefined {
  if (op === OP_WRITE || op === OP_APPEND) {
    const separator = bytes.indexOf(0);
    if (separator < 0) return undefined;
    return {
      op: "write",
      path: decoder.decode(bytes.subarray(0, separator)),
      data: bytes.slice(separator + 1),
      append: op === OP_APPEND,
    };
  }
  if (op === OP_CHTIMES) {
    const [path = "", atime = "", mtime = ""] = decoder.decode(bytes).split("\0");
    try {
      return {
        op: "chtimes",
        path,
        ...(atime === "" ? {} : { atimeNs: BigInt(atime) }),
        ...(mtime === "" ? {} : { mtimeNs: BigInt(mtime) }),
      };
    } catch {
      return undefined;
    }
  }

  const path = decoder.decode(bytes);
  switch (op) {
    case OP_READ:
      return { op: "read", path };
    case OP_STAT:
      return { op: "stat", path };
    case OP_READ_DIRECTORY:
      return { op: "readDirectory", path };
    case OP_REALPATH:
      return { op: "realpath", path };
    case OP_REMOVE:
      return { op: "remove", path };
    default:
      return undefined;
  }
}

function resultBytes(op: number, response: KernelTscFileSystemResponse): Uint8Array {
  switch (response.kind) {
    case "bytes":
      return op === OP_READ ? response.bytes : new Uint8Array();
    case "stat":
      return op === OP_STAT
        ? encoder.encode(`${statKind(response.type)} ${response.size} ${response.mtimeNs}`)
        : new Uint8Array();
    case "entries":
      return op === OP_READ_DIRECTORY
        ? encoder.encode(
            response.entries.map((entry) => `${directoryKind(entry.kind)}${entry.name}\0`).join(""),
          )
        : new Uint8Array();
    case "path":
      return op === OP_REALPATH ? encoder.encode(response.path) : new Uint8Array();
    case "error":
      return isWriteOperation(op) ? encoder.encode(response.message) : new Uint8Array();
    case "written":
    case "missing":
      return new Uint8Array();
  }
}

function resultStatus(
  op: number,
  response: KernelTscFileSystemResponse,
  byteLength: number,
): number | undefined {
  if (response.kind === "missing") return -1;
  if (response.kind === "error") {
    if (!isWriteOperation(op)) return -1;
    if (byteLength > MAX_I32 - 1) {
      throw new RangeError("tsc-rs host error exceeds its signed 32-bit status ABI");
    }
    return -2 - byteLength;
  }
  const expectedKind =
    (op === OP_READ && response.kind === "bytes") ||
    (op === OP_STAT && response.kind === "stat") ||
    (op === OP_READ_DIRECTORY && response.kind === "entries") ||
    (op === OP_REALPATH && response.kind === "path") ||
    (isWriteOperation(op) && response.kind === "written");
  if (!expectedKind) return -1;
  if (byteLength > MAX_I32) {
    throw new RangeError("tsc-rs host result exceeds its signed 32-bit length ABI");
  }
  return byteLength;
}

function isWriteOperation(op: number): boolean {
  return op === OP_WRITE || op === OP_APPEND || op === OP_REMOVE || op === OP_CHTIMES;
}

function statKind(kind: "file" | "directory" | "other"): string {
  switch (kind) {
    case "directory":
      return "d";
    case "other":
      return "o";
    case "file":
      return "f";
  }
}

function directoryKind(kind: "file" | "directory" | "symlink" | "other"): string {
  switch (kind) {
    case "directory":
      return "d";
    case "symlink":
      return "l";
    case "other":
      return "o";
    case "file":
      return "f";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
