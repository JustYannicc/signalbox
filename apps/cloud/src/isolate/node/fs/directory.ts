/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type * as NodeBuffer from "node:buffer";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { codedError } from "./errors.ts";
import { readdirSync, type ReaddirOptions } from "./directories.ts";
import type { PathLike } from "./path.ts";
import type { NodeDirentLike } from "./metadata.ts";

export class NodeFsDir implements AsyncIterable<NodeDirentLike> {
  readonly path: string | NodeBuffer.Buffer | URL;
  readonly #entries: NodeDirentLike[];
  #index = 0;
  #closed = false;

  constructor(kernelFs: KernelFileSystem, path: PathLike, options: ReaddirOptions = {}) {
    this.path = path;
    this.#entries = readdirSync(kernelFs, path, {
      ...options,
      withFileTypes: true,
    }) as NodeDirentLike[];
  }

  readSync(): NodeDirentLike | null {
    if (this.#closed) throw codedError("EBADF", "directory handle was closed", "scandir");
    const entries = this.#entries;
    if (this.#index >= entries.length) return null;
    return entries[this.#index++] ?? null;
  }

  async read(): Promise<NodeDirentLike | null> {
    return this.readSync();
  }

  closeSync(): void {
    if (this.#closed) return;
    this.#closed = true;
  }

  async close(): Promise<void> {
    this.closeSync();
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
