/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { appendFileSync, readFileSync, writeFileSync } from "./files.ts";
import { closeFd } from "./io.ts";
import { ioOptions, readSync, writeBufferSync, writeStringSync, type IoOptions } from "./fd-ops.ts";
import { fstatSync, ftruncateSync, fsyncSync, futimesSync, type TimeLike } from "./metadata-ops.ts";
import type { ReadStreamOptions, WriteStreamOptions } from "./streams.ts";
import { createReadStream, createWriteStream } from "./streams.ts";

export class NodeFileHandle {
  readonly fd: number;
  readonly path: string | undefined;
  readonly #kernelFs: KernelFileSystem;
  #closed = false;

  constructor(kernelFs: KernelFileSystem, fd: number, path?: string) {
    this.#kernelFs = kernelFs;
    this.fd = fd;
    this.path = path;
  }

  get closed() {
    return this.#closed;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    closeFd(this.#kernelFs, this.fd);
    this.#closed = true;
  }

  async stat(options?: { bigint?: boolean }) {
    return fstatSync(this.#kernelFs, this.fd, options);
  }

  async truncate(length = 0): Promise<void> {
    ftruncateSync(this.#kernelFs, this.fd, length);
  }

  async sync(): Promise<void> {
    fsyncSync(this.#kernelFs, this.fd, false);
  }

  async datasync(): Promise<void> {
    fsyncSync(this.#kernelFs, this.fd, true);
  }

  async utimes(atime: TimeLike, mtime: TimeLike): Promise<void> {
    futimesSync(this.#kernelFs, this.fd, atime, mtime);
  }

  async read(
    buffer: ArrayBufferView,
    offsetOrOptions: number | IoOptions = 0,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesRead: number; buffer: ArrayBufferView }> {
    const bytesRead = readSync(this.#kernelFs, this.fd, buffer, offsetOrOptions, length, position);
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
      const bytesWritten = writeStringSync(this.#kernelFs, this.fd, data, textPosition, encoding);
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
    const bytesWritten = writeBufferSync(
      this.#kernelFs,
      this.fd,
      data,
      ioOptions(byteOffset, byteLength, bytePosition),
    );
    return { bytesWritten, buffer: data };
  }

  async readFile(options?: BufferEncoding | { encoding?: BufferEncoding | "buffer" | null }) {
    return readFileSync(this.#kernelFs, this.fd, options);
  }

  async writeFile(
    data: string | ArrayBuffer | ArrayBufferView,
    options?: BufferEncoding | { encoding?: BufferEncoding; flush?: boolean },
  ): Promise<void> {
    writeFileSync(this.#kernelFs, this.fd, data, options);
  }

  async appendFile(
    data: string | ArrayBuffer | ArrayBufferView,
    options?: BufferEncoding | { encoding?: BufferEncoding; flush?: boolean },
  ): Promise<void> {
    appendFileSync(this.#kernelFs, this.fd, data, options);
  }

  createReadStream(options: ReadStreamOptions = {}) {
    return createReadStream(this.#kernelFs, this.path, {
      ...options,
      fd: this.fd,
      autoClose: options.autoClose ?? true,
      onClose: () => {
        this.#closed = true;
      },
    });
  }

  createWriteStream(options: WriteStreamOptions = {}) {
    return createWriteStream(this.#kernelFs, this.path, {
      ...options,
      fd: this.fd,
      autoClose: options.autoClose ?? true,
      onClose: () => {
        this.#closed = true;
      },
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
