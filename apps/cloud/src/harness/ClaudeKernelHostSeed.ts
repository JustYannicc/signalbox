import { RpcTarget } from "cloudflare:workers";
import type { ClaudeKernelSeedSource } from "./ClaudeKernelSessionPort.ts";
import type { SeedCatalog } from "../kernel/KernelSeedCatalog.ts";
import type { LoadedHarnessRelease } from "./HarnessReleaseLoader.ts";
import { KERNEL_FILE_TRANSFER_BYTES } from "../kernel/KernelFileTransfer.ts";

/** These are immutable bootstrap bytes, released after the kernel verifies and installs them. */
export class ClaudeKernelHostSeed extends RpcTarget implements ClaudeKernelSeedSource {
  #catalog: SeedCatalog | undefined;
  #release: LoadedHarnessRelease | undefined;
  readonly #signal;
  readonly #payloads = new Map<"assets" | "programs", Promise<ReadonlyMap<string, Uint8Array>>>();
  constructor(catalog: SeedCatalog, loaded: LoadedHarnessRelease, signal: AbortSignal) {
    super();
    this.#catalog = catalog;
    this.#release = loaded;
    this.#signal = signal;
  }
  async read(stage: "assets" | "programs", path: string, offset: number, length: number) {
    this.#signal.throwIfAborted();
    if (this.#catalog === undefined) throw new Error("Kernel seed source is closed");
    let payloads = this.#payloads.get(stage);
    if (payloads === undefined) {
      payloads = this.#catalog.payloads(stage, this.#signal);
      this.#payloads.set(stage, payloads);
    }
    return range((await payloads).get(path), offset, length);
  }
  async releasePayload(path: string, offset: number, length: number) {
    this.#signal.throwIfAborted();
    return range(this.#release?.payloads.get(path), offset, length);
  }
  async release(stage: "assets" | "programs") {
    try {
      await this.#payloads.get(stage);
    } finally {
      this.#payloads.delete(stage);
    }
  }
  close() {
    this.#catalog = undefined;
    this.#release = undefined;
    this.#payloads.clear();
  }
}
function range(bytes: Uint8Array | undefined, offset: number, length: number) {
  if (
    bytes === undefined ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > KERNEL_FILE_TRANSFER_BYTES ||
    offset + length > bytes.length
  )
    throw new RangeError("Invalid kernel bootstrap range");
  return bytes.slice(offset, offset + length);
}
