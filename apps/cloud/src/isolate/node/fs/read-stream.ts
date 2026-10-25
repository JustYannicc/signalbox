/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
// @effect-diagnostics nodeBuiltinImport:off - The Node fs bridge returns native streams.
import * as NodeBuffer from "node:buffer";
import * as NodeStream from "node:stream";
import type { DescriptorLifetime } from "./descriptor-lifetime.ts";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { nodeFsError } from "./errors.ts";
import { readIntoOperation } from "./io.ts";
import type { AsyncLeafRunner } from "./operations.ts";
import { finitePosition, type PathLike } from "./path.ts";
import { StreamFile } from "./stream-file.ts";

export interface ReadStreamOptions extends NodeStream.ReadableOptions {
  autoClose?: boolean;
  end?: number;
  fd?: number;
  flags?: string | number;
  mode?: number;
  start?: number;
  onClose?: () => void;
}

export class NodeFsReadStream extends NodeStream.Readable {
  readonly path: string | NodeBuffer.Buffer | undefined;
  bytesRead = 0;
  readonly #kernelFs: KernelFileSystem;
  readonly #file: StreamFile;
  #position: bigint | null;
  readonly #end: bigint | undefined;
  #ended = false;
  #reading = false;
  #ready: boolean;

  constructor(
    kernelFs: KernelFileSystem,
    path: PathLike | undefined,
    options: ReadStreamOptions = {},
    runLeaf?: AsyncLeafRunner,
    lifetime?: DescriptorLifetime,
  ) {
    super({
      autoDestroy: true,
      emitClose: options.emitClose,
      encoding: options.encoding,
      highWaterMark: options.highWaterMark,
    });
    this.#kernelFs = kernelFs;
    this.#file = new StreamFile(kernelFs, path, options, runLeaf, lifetime);
    this.path = path instanceof NodeBuffer.Buffer ? path : this.#file.path;
    this.#ready = options.fd !== undefined;
    this.#position =
      options.start !== undefined
        ? finitePosition(options.start)
        : options.fd === undefined && options.end !== undefined
          ? 0n
          : null;
    this.#end = options.end === undefined ? undefined : (finitePosition(options.end) ?? undefined);
    if (options.start !== undefined && options.end !== undefined && options.end < options.start) {
      throw Object.assign(new RangeError('The value of "end" is out of range'), {
        code: "ERR_OUT_OF_RANGE",
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

  override _read(size: number): void {
    if (this.destroyed || this.#ended || this.#reading) return;
    this.#reading = true;
    void this.#read(size).then(
      () => {},
      (cause: unknown) => {
        this.#reading = false;
        this.destroy(nodeFsError(cause, "read", this.#file.path) as Error);
      },
    );
  }

  async #read(size: number): Promise<void> {
    const fd = await this.#file.open("r");
    if (this.destroyed) return;
    if (!this.#ready) {
      this.#ready = true;
      this.emit("open", fd);
      this.emit("ready");
    }
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
    const bytesRead = await this.#file.run(
      readIntoOperation(this.#kernelFs, fd, buffer, this.#position),
    );
    if (this.destroyed) return;
    if (bytesRead === 0) {
      this.#ended = true;
      this.push(null);
      return;
    }
    this.bytesRead += bytesRead;
    if (this.#position !== null) this.#position += BigInt(bytesRead);
    // Clear before push: a flowing reader can request the next chunk synchronously.
    this.#reading = false;
    this.push(buffer.subarray(0, bytesRead));
    if (reachesEnd && bytesRead === length) {
      this.#ended = true;
      this.push(null);
    }
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
