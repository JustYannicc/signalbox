import type { NodeFsBackend } from "../../NodeFsBackend.ts";
import { codedError } from "./errors.ts";
import { closeFdOperation } from "./io.ts";
import { runAsync } from "./operations.ts";

/** FileHandles and their streams share one close and drain their active operations first. */
export class DescriptorLifetime {
  readonly fd: number;
  readonly #kernelFs: NodeFsBackend;
  readonly #active = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  #closed = false;

  constructor(kernelFs: NodeFsBackend, fd: number) {
    this.#kernelFs = kernelFs;
    this.fd = fd;
  }

  get closed() {
    return this.#closed;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#closing)
      return Promise.reject(codedError("EBADF", "file handle was closed"));
    const promise = operation();
    this.#active.add(promise);
    void promise.then(
      () => this.#active.delete(promise),
      () => this.#active.delete(promise),
    );
    return promise;
  }

  close(): Promise<void> {
    this.#closing ??= Promise.allSettled(this.#active).then(async () => {
      if (this.#closed) return;
      await runAsync(closeFdOperation(this.#kernelFs, this.fd));
      this.#closed = true;
    });
    return this.#closing;
  }
}
