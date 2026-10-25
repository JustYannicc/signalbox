/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { DescriptorLifetime } from "./descriptor-lifetime.ts";
import { createAsyncOperations } from "./async-operations.ts";
import { runAsync, type AsyncLeafRunner } from "./operations.ts";
import { fchownOperation } from "./permission-ops.ts";
import type { ReadFileOptions, WriteFileOptions } from "./files.ts";
import { ioOptions, type IoOptions } from "./fd-ops.ts";
import type { TimeLike } from "./metadata-ops.ts";
import type { ReadStreamOptions, WriteStreamOptions } from "./streams.ts";
import { createReadStream, createWriteStream } from "./streams.ts";

export class NodeFileHandle {
  readonly fd: number;
  readonly path: string | undefined;
  readonly #kernelFs: KernelFileSystem;
  readonly #operations: ReturnType<typeof createAsyncOperations>;
  readonly #runLeaf: AsyncLeafRunner | undefined;
  readonly #lifetime: DescriptorLifetime;

  constructor(kernelFs: KernelFileSystem, fd: number, path?: string, runLeaf?: AsyncLeafRunner) {
    this.#kernelFs = kernelFs;
    this.#runLeaf = runLeaf;
    this.#operations = createAsyncOperations(kernelFs, runLeaf);
    this.#lifetime = new DescriptorLifetime(kernelFs, fd);
    this.fd = fd;
    this.path = path;
  }

  get closed() {
    return this.#lifetime.closed;
  }

  async close(): Promise<void> {
    await this.#lifetime.close();
  }

  async stat(options?: { bigint?: boolean }) {
    return await this.#lifetime.run(() => this.#operations.fstat(this.fd, options));
  }

  async chmod(mode: number | string): Promise<void> {
    await this.#lifetime.run(() => this.#operations.fchmod(this.fd, mode));
  }

  async chown(uid: number, gid: number): Promise<void> {
    await this.#lifetime.run(() =>
      runAsync(fchownOperation(this.#kernelFs, this.fd, uid, gid), this.#runLeaf),
    );
  }

  async truncate(length = 0): Promise<void> {
    await this.#lifetime.run(() => this.#operations.ftruncate(this.fd, length));
  }

  async sync(): Promise<void> {
    await this.#lifetime.run(() => this.#operations.fsync(this.fd, false));
  }

  async datasync(): Promise<void> {
    await this.#lifetime.run(() => this.#operations.fsync(this.fd, true));
  }

  async utimes(atime: TimeLike, mtime: TimeLike): Promise<void> {
    await this.#lifetime.run(() => this.#operations.futimes(this.fd, atime, mtime));
  }

  async read(
    buffer: ArrayBufferView,
    offsetOrOptions: number | IoOptions = 0,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesRead: number; buffer: ArrayBufferView }> {
    const bytesRead = await this.#lifetime.run(() =>
      this.#operations.read(this.fd, buffer, offsetOrOptions, length, position),
    );
    return { bytesRead, buffer };
  }

  async write(
    data: string | ArrayBufferView,
    offsetOrOptions?: number | null | IoOptions,
    lengthOrEncoding?: number | BufferEncoding,
    position?: number | null,
  ): Promise<{ bytesWritten: number; buffer: string | ArrayBufferView }> {
    if (typeof data === "string") {
      const textPosition = typeof offsetOrOptions === "number" ? offsetOrOptions : undefined;
      const encoding = typeof lengthOrEncoding === "string" ? lengthOrEncoding : "utf8";
      const bytesWritten = await this.#lifetime.run(() =>
        this.#operations.writeString(this.fd, data, textPosition, encoding),
      );
      return { bytesWritten, buffer: data };
    }
    const offset = typeof offsetOrOptions === "number" ? offsetOrOptions : 0;
    const length =
      typeof lengthOrEncoding === "number" ? lengthOrEncoding : data.byteLength - offset;
    const bytePosition =
      typeof offsetOrOptions === "object" && offsetOrOptions !== null
        ? offsetOrOptions.position
        : position;
    const byteOffset =
      typeof offsetOrOptions === "object" && offsetOrOptions !== null
        ? offsetOrOptions.offset
        : offset;
    const byteLength =
      typeof offsetOrOptions === "object" && offsetOrOptions !== null
        ? offsetOrOptions.length
        : length;
    const bytesWritten = await this.#lifetime.run(() =>
      this.#operations.writeBuffer(this.fd, data, ioOptions(byteOffset, byteLength, bytePosition)),
    );
    return { bytesWritten, buffer: data };
  }

  async readFile(options?: BufferEncoding | ReadFileOptions) {
    return await this.#lifetime.run(() => this.#operations.readFile(this.fd, options));
  }

  async writeFile(
    data: string | ArrayBuffer | ArrayBufferView,
    options?: BufferEncoding | WriteFileOptions,
  ): Promise<void> {
    await this.#lifetime.run(() => this.#operations.writeFile(this.fd, data, options));
  }

  async appendFile(
    data: string | ArrayBuffer | ArrayBufferView,
    options?: BufferEncoding | WriteFileOptions,
  ): Promise<void> {
    await this.#lifetime.run(() => this.#operations.appendFile(this.fd, data, options));
  }

  createReadStream(options: ReadStreamOptions = {}) {
    return createReadStream(
      this.#kernelFs,
      this.path,
      {
        ...options,
        fd: this.fd,
        autoClose: options.autoClose ?? true,
      },
      this.#runLeaf,
      this.#lifetime,
    );
  }

  createWriteStream(options: WriteStreamOptions = {}) {
    return createWriteStream(
      this.#kernelFs,
      this.path,
      {
        ...options,
        fd: this.fd,
        autoClose: options.autoClose ?? true,
      },
      this.#runLeaf,
      this.#lifetime,
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
