/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
// @effect-diagnostics nodeBuiltinImport:off - The Node fs bridge returns native streams.
import * as NodeBuffer from "node:buffer";
import * as NodeStream from "node:stream";
import type { DescriptorLifetime } from "./descriptor-lifetime.ts";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { KernelOpenFlags } from "./constants.ts";
import { nodeFsError } from "./errors.ts";
import { writeAllOperation } from "./io.ts";
import { fsyncOperation } from "./metadata-ops.ts";
import type { AsyncLeafRunner } from "./operations.ts";
import { finitePosition, type PathLike } from "./path.ts";
import { StreamFile } from "./stream-file.ts";

export interface WriteStreamOptions extends NodeStream.WritableOptions {
  autoClose?: boolean;
  fd?: number;
  flags?: string | number;
  flush?: boolean;
  mode?: number;
  start?: number;
  onClose?: () => void;
}

export class NodeFsWriteStream extends NodeStream.Writable {
  readonly path: string | NodeBuffer.Buffer | undefined;
  bytesWritten = 0;
  readonly #kernelFs: KernelFileSystem;
  readonly #file: StreamFile;
  readonly #options: WriteStreamOptions;
  #position: bigint | null;
  #ready: boolean;

  constructor(
    kernelFs: KernelFileSystem,
    path: PathLike | undefined,
    options: WriteStreamOptions = {},
    runLeaf?: AsyncLeafRunner,
    lifetime?: DescriptorLifetime,
  ) {
    super({
      autoDestroy: true,
      decodeStrings: options.decodeStrings,
      defaultEncoding: options.defaultEncoding,
      emitClose: options.emitClose,
      highWaterMark: options.highWaterMark,
      objectMode: options.objectMode,
    });
    this.#kernelFs = kernelFs;
    this.#options = options;
    this.#file = new StreamFile(kernelFs, path, options, runLeaf, lifetime);
    this.path = path instanceof NodeBuffer.Buffer ? path : this.#file.path;
    this.#position = finitePosition(options.start);
    this.#ready = options.fd !== undefined;
    if (
      options.start !== undefined &&
      ((typeof options.flags === "string" && options.flags.startsWith("a")) ||
        (typeof options.flags === "number" && (options.flags & KernelOpenFlags.O_APPEND) !== 0))
    ) {
      throw Object.assign(new TypeError("The start option is not supported with append mode"), {
        code: "ERR_INVALID_ARG_VALUE",
      });
    }
    if (options.signal) NodeStream.addAbortSignal(options.signal, this);
  }

  get fd() {
    return this.#file.fd;
  }
  get pending() {
    return !this.#ready;
  }

  override _construct(callback: (error?: Error | null) => void): void {
    void this.#file.open("w").then(
      (fd) => {
        if (!this.destroyed && !this.#ready) {
          this.#ready = true;
          this.emit("open", fd);
          this.emit("ready");
        }
        callback();
      },
      (cause: unknown) =>
        callback(
          this.destroyed ? undefined : (nodeFsError(cause, "open", this.#file.path) as Error),
        ),
    );
  }

  override _write(
    chunk: NodeBuffer.Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const fd = this.fd;
    if (fd === null) {
      callback(Object.assign(new Error("The stream is not open"), { code: "EBADF" }));
      return;
    }
    const bytes = typeof chunk === "string" ? NodeBuffer.Buffer.from(chunk, encoding) : chunk;
    const writing = writeAllOperation(this.#kernelFs, fd, bytes, this.#position, (written) => {
      this.bytesWritten += written;
      if (this.#position !== null) this.#position += BigInt(written);
    });
    void this.#file.run(writing).then(
      () => callback(),
      (cause: unknown) => callback(nodeFsError(cause, "write", this.#file.path) as Error),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    const fd = this.fd;
    const done =
      this.#options.flush && fd !== null
        ? this.#file.run(fsyncOperation(this.#kernelFs, fd))
        : Promise.resolve();
    void done.then(
      () => callback(),
      (cause: unknown) => callback(nodeFsError(cause, "fsync", this.#file.path) as Error),
    );
  }

  override destroy(error?: Error): this {
    this.#file.abort(error);
    return super.destroy(error);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    void this.#file.close().then(
      () => callback(error),
      (cause: unknown) => callback(nodeFsError(cause, "close", this.#file.path) as Error),
    );
  }
}
