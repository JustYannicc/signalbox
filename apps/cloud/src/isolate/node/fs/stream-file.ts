import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { normalizeMode, parseOpenFlags } from "./constants.ts";
import { DescriptorLifetime } from "./descriptor-lifetime.ts";
import { openFdOperation } from "./io.ts";
import { runAsync, type AsyncLeafRunner, type FsOperation } from "./operations.ts";
import { pathString, type PathLike } from "./path.ts";

type Options = {
  fd?: number;
  flags?: string | number;
  mode?: number;
  autoClose?: boolean;
  onClose?: () => void;
};

/** Owns a stream's descriptor until every cancelled syscall has unwound. */
export class StreamFile {
  fd: number | null;
  readonly path: string | undefined;
  readonly #kernelFs: KernelFileSystem;
  readonly #options: Options;
  readonly #runLeaf: AsyncLeafRunner | undefined;
  #lifetime: DescriptorLifetime | undefined;
  readonly #controller = new AbortController();
  readonly #active = new Set<Promise<unknown>>();

  constructor(
    kernelFs: KernelFileSystem,
    path: PathLike | undefined,
    options: Options,
    runLeaf?: AsyncLeafRunner,
    lifetime?: DescriptorLifetime,
  ) {
    if (options.fd === undefined && path === undefined) {
      throw Object.assign(new TypeError("A path or file descriptor is required"), {
        code: "ERR_INVALID_ARG_VALUE",
      });
    }
    this.#kernelFs = kernelFs;
    this.#options = options;
    this.#runLeaf = runLeaf;
    this.#lifetime =
      lifetime ??
      (options.fd === undefined ? undefined : new DescriptorLifetime(kernelFs, options.fd));
    this.path = path === undefined ? undefined : pathString(path);
    this.fd = options.fd ?? null;
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#active.add(promise);
    void promise.then(
      () => this.#active.delete(promise),
      () => this.#active.delete(promise),
    );
    return promise;
  }

  run<T>(operation: FsOperation<T>): Promise<T> {
    const run = () => runAsync(operation, this.#runLeaf, this.#controller.signal);
    return this.#track(this.#lifetime ? this.#lifetime.run(run) : run());
  }

  async open(defaultFlags: string): Promise<number> {
    if (this.fd !== null) return this.fd;
    const path = this.path;
    if (path === undefined) throw new TypeError("A path is required to open the stream");
    return this.#track(
      this.run(
        openFdOperation(
          this.#kernelFs,
          path,
          parseOpenFlags(this.#options.flags ?? defaultFlags),
          normalizeMode(this.#options.mode),
        ),
      ).then((fd) => {
        this.fd = fd;
        this.#lifetime = new DescriptorLifetime(this.#kernelFs, fd);
        return fd;
      }),
    );
  }

  abort(reason?: Error): void {
    this.#controller.abort(reason ?? new Error("Stream destroyed"));
  }

  async close(): Promise<void> {
    this.abort();
    await Promise.allSettled(this.#active);
    const fd = this.fd;
    if (!(this.#options.autoClose ?? true) || fd === null) return;
    this.fd = null;
    await this.#lifetime?.close();
    this.#options.onClose?.();
  }
}
