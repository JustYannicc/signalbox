import { RpcTarget } from "cloudflare:workers";
import type { KernelBashForkSource } from "../kernel/KernelBashFork.ts";

/** Only one bounded chunk crosses each RPC hop; the facet holds a capability to the paused parent. */
export class ChildBashForkSource extends RpcTarget implements KernelBashForkSource {
  readonly #source: KernelBashForkSource;

  constructor(source: KernelBashForkSource) {
    super();
    this.#source = source;
  }

  state() {
    return this.#source.state();
  }

  read(offset: number, length: number) {
    return this.#source.read(offset, length);
  }

  restored() {
    return this.#source.restored();
  }
}
