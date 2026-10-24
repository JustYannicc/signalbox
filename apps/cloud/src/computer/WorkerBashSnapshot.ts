import { RpcTarget } from "cloudflare:workers";
import type { ChildHostLease, ChildHostRef } from "./ChildHostLease.ts";
import {
  BASH_FORK_CHUNK_BYTES,
  copyKernelBashForkState,
  type KernelBashForkSource,
} from "../kernel/KernelBashFork.ts";
import { disposeKernelRpcReply } from "../kernel/KernelRpcReply.ts";

export class WorkerBashSnapshot extends RpcTarget implements KernelBashForkSource {
  readonly #source: ChildHostRef<KernelBashForkSource>;
  readonly #lease: ChildHostLease;

  constructor(lease: ChildHostLease, source: KernelBashForkSource) {
    super();
    this.#lease = lease;
    this.#source = lease.hold(source, disposeSource);
  }

  async state() {
    const reply = await this.#source.get().state();
    try {
      return copyKernelBashForkState(reply);
    } finally {
      disposeKernelRpcReply(reply);
    }
  }
  async read(offset: number, length: number) {
    const reply = await this.#source.get().read(offset, length);
    try {
      if (reply.byteLength > BASH_FORK_CHUNK_BYTES)
        throw new RangeError("Bash snapshot chunk exceeds the RPC copy limit");
      return reply.slice();
    } finally {
      disposeKernelRpcReply(reply);
    }
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
  const dispose = Symbol.dispose in source ? source[Symbol.dispose] : undefined;
  if (typeof dispose === "function") dispose.call(source);
}
