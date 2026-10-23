import { RpcTarget } from "cloudflare:workers";
import type { ChildHostLease, ChildHostRef } from "./ChildHostLease.ts";
import type { KernelBashForkSource } from "../kernel/KernelBashFork.ts";

export class WorkerBashSnapshot extends RpcTarget implements KernelBashForkSource {
  readonly #source: ChildHostRef<KernelBashForkSource>;
  readonly #lease: ChildHostLease;

  constructor(lease: ChildHostLease, source: KernelBashForkSource) {
    super();
    this.#lease = lease;
    this.#source = lease.hold(source, disposeSource);
  }

  state() {
    return this.#source.get().state();
  }
  read(offset: number, length: number) {
    return this.#source.get().read(offset, length);
  }
  async restored() {
    try {
      await this.#source.get().restored();
    } finally {
      // A remote source stub pins its producer's request even after all heap bytes were copied.
      this.#lease.drop(this.#source);
    }
  }
}

function disposeSource(source: KernelBashForkSource): void {
  if (Symbol.dispose in source && typeof source[Symbol.dispose] === "function")
    source[Symbol.dispose]();
}
