/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
// @effect-diagnostics nodeBuiltinImport:off - This adapter must return native Node streams to Node consumers.
import * as NodeBuffer from "node:buffer";
import * as NodeStream from "node:stream";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { closeFd, openFd, writeAll } from "./io.ts";
import { normalizeMode, parseOpenFlags, KernelOpenFlags } from "./constants.ts";
import { nodeFsError } from "./errors.ts";
import { finitePosition, pathString, type PathLike } from "./path.ts";

export interface ReadStreamOptions extends NodeStream.ReadableOptions {
  autoClose?: boolean;
  end?: number;
  fd?: number;
  flags?: string | number;
  mode?: number;
  start?: number;
  onClose?: () => void;
}

export interface WriteStreamOptions extends NodeStream.WritableOptions {
  autoClose?: boolean;
  fd?: number;
  flags?: string | number;
  flush?: boolean;
  mode?: number;
  start?: number;
  onClose?: () => void;
}

export class NodeFsReadStream extends NodeStream.Readable {
  readonly path: string | NodeBuffer.Buffer | undefined;
  fd: number | null;
  bytesRead = 0;
  pending: boolean;
  readonly #kernelFs: KernelFileSystem;
  readonly #options: ReadStreamOptions;
  readonly #autoClose: boolean;
  readonly #fsPath: string | undefined;
  #position: bigint | null;
  #end: bigint | undefined;
  #ended = false;

  constructor(
    kernelFs: KernelFileSystem,
    path: PathLike | undefined,
    options: ReadStreamOptions = {},
  ) {
    super({
      autoDestroy: true,
      emitClose: options.emitClose,
      encoding: options.encoding,
      highWaterMark: options.highWaterMark,
    });
    if (options.fd === undefined && path === undefined) {
      throw Object.assign(new TypeError("A path or file descriptor is required"), {
        code: "ERR_INVALID_ARG_VALUE",
      });
    }
    this.#kernelFs = kernelFs;
    this.#options = options;
    this.#fsPath = path === undefined ? undefined : pathString(path);
    this.path =
      path === undefined ? undefined : path instanceof NodeBuffer.Buffer ? path : this.#fsPath;
    this.fd = options.fd ?? null;
    this.#autoClose = options.autoClose ?? true;
    this.#position =
      options.start !== undefined
        ? finitePosition(options.start)
        : options.fd === undefined && options.end !== undefined
          ? 0n
          : null;
    this.#end = options.end === undefined ? undefined : (finitePosition(options.end) ?? undefined);
    this.pending = this.fd === null;
    if (options.start !== undefined && options.end !== undefined && options.end < options.start) {
      throw Object.assign(new RangeError('The value of "end" is out of range'), {
        code: "ERR_OUT_OF_RANGE",
      });
    }
  }

  override _read(size: number): void {
    if (this.destroyed || this.#ended) return;
    try {
      const fd = this.#ensureOpen();
      const requested = Math.max(1, Math.min(size || 64 * 1024, 1024 * 1024));
      let length = requested;
      let reachesEnd = false;
      if (this.#end !== undefined) {
        const position = this.#position ?? this.#kernelFs.descriptors.get(fd).offset;
        if (position > this.#end) {
          this.#ended = true;
          this.push(null);
          return;
        }
        const remaining = this.#end - position + 1n;
        reachesEnd = remaining <= BigInt(requested);
        if (reachesEnd) length = Number(remaining);
      }
      const buffer = NodeBuffer.Buffer.allocUnsafe(length);
      const bytesRead = this.#kernelFs.read(fd, buffer, this.#position);
      if (bytesRead === 0) {
        this.#ended = true;
        this.push(null);
        return;
      }
      this.bytesRead += bytesRead;
      if (this.#position !== null) this.#position += BigInt(bytesRead);
      this.push(buffer.subarray(0, bytesRead));
      if (reachesEnd && bytesRead === length) {
        this.#ended = true;
        this.push(null);
      }
    } catch (cause) {
      this.destroy(nodeFsError(cause, "read", this.#fsPath) as Error);
    }
  }

  #ensureOpen(): number {
    if (this.fd !== null) return this.fd;
    const path = this.#fsPath;
    if (path === undefined) throw new TypeError("A path is required to open the stream");
    this.fd = openFd(
      this.#kernelFs,
      path,
      parseOpenFlags(this.#options.flags ?? "r"),
      normalizeMode(this.#options.mode),
    );
    this.pending = false;
    this.emit("open", this.fd);
    this.emit("ready");
    return this.fd;
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    try {
      const didClose = this.#autoClose && this.fd !== null;
      if (didClose && this.fd !== null) closeFd(this.#kernelFs, this.fd);
      if (this.#autoClose) this.fd = null;
      if (didClose) this.#options.onClose?.();
      callback(error);
    } catch (cause) {
      callback(nodeFsError(cause, "close", this.#fsPath) as Error);
    }
  }
}

export class NodeFsWriteStream extends NodeStream.Writable {
  readonly path: string | NodeBuffer.Buffer | undefined;
  fd: number | null;
  bytesWritten = 0;
  pending: boolean;
  readonly #kernelFs: KernelFileSystem;
  readonly #options: WriteStreamOptions;
  readonly #autoClose: boolean;
  readonly #fsPath: string | undefined;
  #position: bigint | null;

  constructor(
    kernelFs: KernelFileSystem,
    path: PathLike | undefined,
    options: WriteStreamOptions = {},
  ) {
    super({
      autoDestroy: true,
      decodeStrings: options.decodeStrings,
      defaultEncoding: options.defaultEncoding,
      emitClose: options.emitClose,
      highWaterMark: options.highWaterMark,
      objectMode: options.objectMode,
    });
    if (options.fd === undefined && path === undefined) {
      throw Object.assign(new TypeError("A path or file descriptor is required"), {
        code: "ERR_INVALID_ARG_VALUE",
      });
    }
    this.#kernelFs = kernelFs;
    this.#options = options;
    this.#fsPath = path === undefined ? undefined : pathString(path);
    this.path =
      path === undefined ? undefined : path instanceof NodeBuffer.Buffer ? path : this.#fsPath;
    this.fd = options.fd ?? null;
    this.#autoClose = options.autoClose ?? true;
    this.#position = finitePosition(options.start);
    this.pending = this.fd === null;
    if (
      options.start !== undefined &&
      ((typeof options.flags === "string" && options.flags.startsWith("a")) ||
        (typeof options.flags === "number" &&
          (options.flags & KernelOpenFlags.O_APPEND) === KernelOpenFlags.O_APPEND))
    ) {
      throw Object.assign(new TypeError("The start option is not supported with append mode"), {
        code: "ERR_INVALID_ARG_VALUE",
      });
    }
  }

  override _construct(callback: (error?: Error | null) => void): void {
    try {
      if (this.fd === null) {
        const path = this.#fsPath;
        if (path === undefined) throw new TypeError("A path is required to open the stream");
        const flags = parseOpenFlags(this.#options.flags ?? "w");
        this.fd = openFd(this.#kernelFs, path, flags, normalizeMode(this.#options.mode));
        this.pending = false;
        this.emit("open", this.fd);
        this.emit("ready");
      }
      callback();
    } catch (cause) {
      callback(nodeFsError(cause, "open", this.#fsPath) as Error);
    }
  }

  override _write(
    chunk: NodeBuffer.Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      if (this.fd === null)
        throw Object.assign(new Error("The stream is not open"), { code: "EBADF" });
      const bytes = typeof chunk === "string" ? NodeBuffer.Buffer.from(chunk, encoding) : chunk;
      const written = writeAll(this.#kernelFs, this.fd, bytes, this.#position);
      this.bytesWritten += written;
      if (this.#position !== null) this.#position += BigInt(written);
      callback();
    } catch (cause) {
      callback(nodeFsError(cause, "write", this.#fsPath) as Error);
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    try {
      if (this.#options.flush && this.fd !== null) this.#kernelFs.sync(this.fd, false);
      callback();
    } catch (cause) {
      callback(nodeFsError(cause, "fsync", this.#fsPath) as Error);
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    try {
      const didClose = this.#autoClose && this.fd !== null;
      if (didClose && this.fd !== null) closeFd(this.#kernelFs, this.fd);
      if (this.#autoClose) this.fd = null;
      if (didClose) this.#options.onClose?.();
      callback(error);
    } catch (cause) {
      callback(nodeFsError(cause, "close", this.#fsPath) as Error);
    }
  }
}

export function createReadStream(
  kernelFs: KernelFileSystem,
  path: PathLike | undefined,
  options: ReadStreamOptions = {},
) {
  return new NodeFsReadStream(kernelFs, path, options);
}

export function createWriteStream(
  kernelFs: KernelFileSystem,
  path: PathLike | undefined,
  options: WriteStreamOptions = {},
) {
  return new NodeFsWriteStream(kernelFs, path, options);
}
