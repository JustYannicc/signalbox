/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type * as NodeBuffer from "node:buffer";
import { codedError } from "./errors.ts";
import type { PathLike } from "./path.ts";
import type { NodeDirentLike } from "./metadata.ts";

export class NodeFsDir implements AsyncIterable<NodeDirentLike> {
  readonly path: string | NodeBuffer.Buffer | URL;
  readonly #names: string[];
  readonly #entry: (name: string) => NodeDirentLike;
  readonly #asyncEntry: (name: string) => Promise<NodeDirentLike>;
  readonly #bufferSize: number;
  readonly #buffer: NodeDirentLike[] = [];
  #index = 0;
  #closed = false;
  #pending: Promise<NodeDirentLike | null> | undefined;

  constructor(
    path: PathLike,
    names: string[],
    entry: (name: string) => NodeDirentLike,
    asyncEntry: (name: string) => Promise<NodeDirentLike>,
    bufferSize: number,
  ) {
    this.path = path;
    this.#names = names;
    this.#entry = entry;
    this.#asyncEntry = asyncEntry;
    this.#bufferSize = bufferSize;
  }

  readSync(): NodeDirentLike | null {
    if (this.#pending)
      throw codedError("ERR_DIR_CONCURRENT_OPERATION", "directory read is pending");
    if (this.#closed) throw codedError("EBADF", "directory handle was closed", "scandir");
    if (this.#buffer.length === 0) {
      const end = Math.min(this.#index + this.#bufferSize, this.#names.length);
      while (this.#index < end) {
        const name = this.#names[this.#index++]!;
        this.#buffer.push(this.#entry(name));
      }
    }
    return this.#buffer.shift() ?? null;
  }

  async read(): Promise<NodeDirentLike | null> {
    if (this.#pending)
      throw codedError("ERR_DIR_CONCURRENT_OPERATION", "directory read is pending");
    if (this.#closed) throw codedError("EBADF", "directory handle was closed", "scandir");
    this.#pending = (async () => {
      if (this.#buffer.length === 0) {
        const end = Math.min(this.#index + this.#bufferSize, this.#names.length);
        while (this.#index < end) {
          this.#buffer.push(await this.#asyncEntry(this.#names[this.#index++]!));
        }
      }
      return this.#buffer.shift() ?? null;
    })();
    try {
      return await this.#pending;
    } finally {
      this.#pending = undefined;
    }
  }

  closeSync(): void {
    if (this.#pending)
      throw codedError("ERR_DIR_CONCURRENT_OPERATION", "directory read is pending");
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer.length = 0;
    this.#names.length = 0;
  }

  async close(): Promise<void> {
    try {
      await this.#pending;
    } finally {
      this.#closed = true;
      this.#buffer.length = 0;
      this.#names.length = 0;
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<NodeDirentLike> {
    try {
      while (true) {
        const entry = await this.read();
        if (entry === null) return;
        yield entry;
      }
    } finally {
      await this.close();
    }
  }
}
