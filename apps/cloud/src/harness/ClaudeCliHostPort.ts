import { RpcTarget } from "cloudflare:workers";
import type { ClaudeCliHost } from "./ClaudeCliKernelPort.ts";

/** A facet stub stays with its parent; the sibling receives a transferable capability. */
export class ClaudeCliHostPort extends RpcTarget implements ClaudeCliHost {
  readonly #target;
  constructor(target: ClaudeCliHost) {
    super();
    this.#target = target;
  }
  async open(...args: Parameters<ClaudeCliHost["open"]>) {
    return await this.#target.open(...args);
  }
}
