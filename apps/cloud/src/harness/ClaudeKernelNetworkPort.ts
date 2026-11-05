import { RpcTarget } from "cloudflare:workers";
import type { ComputerPort } from "../computer/Computer.ts";
import { ownRpcResponse } from "../rpc/response.ts";
import { requestFromRpc, type RpcRequest } from "../rpc/Request.ts";

export interface ClaudeKernelNetworkPort {
  fetch(id: string, request: RpcRequest): Promise<Response>;
  cancel(id: string, reason?: unknown): Promise<void>;
  dispose(): Promise<void>;
}

/** A port retains request cancellation through response-body completion. */
export class ClaudeKernelNetworkTarget extends RpcTarget implements ClaudeKernelNetworkPort {
  #port: ComputerPort | undefined;
  readonly #lifetime = new AbortController();
  readonly #signal;
  readonly #remove;
  readonly #requests = new Map<
    string,
    { readonly controller: AbortController; readonly closed: PromiseWithResolvers<void> }
  >();
  readonly #cancelled = new Map<string, unknown>();
  #disposed: Promise<void> | undefined;
  constructor(port: ComputerPort, signal: AbortSignal, remove: () => void) {
    super();
    this.#port = port;
    this.#remove = remove;
    this.#signal = AbortSignal.any([signal, this.#lifetime.signal]);
    signal.addEventListener(
      "abort",
      () => {
        void this.dispose().catch(() => undefined);
      },
      { once: true },
    );
  }
  async fetch(id: string, request: RpcRequest) {
    this.#signal.throwIfAborted();
    const port = this.#port;
    if (!id || port === undefined || this.#requests.has(id))
      throw new Error("Kernel network port is closed or request is duplicate");
    const controller = new AbortController();
    const closed = Promise.withResolvers<void>();
    this.#requests.set(id, { controller, closed });
    if (this.#cancelled.has(id)) {
      controller.abort(this.#cancelled.get(id));
      this.#cancelled.delete(id);
    }
    const signal = AbortSignal.any([this.#signal, controller.signal]);
    const release = () => {
      this.#requests.delete(id);
      closed.resolve();
    };
    try {
      signal.throwIfAborted();
      return await ownRpcResponse(await port.fetch(requestFromRpc(request, signal)), {
        signal,
        release,
        bodyOpened() {},
        bodyClosed() {},
        bodyBytes() {},
        socketOpened() {},
        socketClosed() {},
      });
    } catch (error) {
      release();
      throw error;
    }
  }
  async cancel(id: string, reason?: unknown) {
    const request = this.#requests.get(id);
    if (request !== undefined) request.controller.abort(reason);
    else if (this.#cancelled.size < 64) this.#cancelled.set(id, reason);
  }
  dispose() {
    return (this.#disposed ??= (async () => {
      this.#lifetime.abort(new Error("Kernel network port closed"));
      const requests = [...this.#requests.values()];
      for (const request of requests) request.controller.abort(this.#signal.reason);
      await Promise.allSettled(requests.map((request) => request.closed.promise));
      this.#port = undefined;
      this.#cancelled.clear();
      this.#remove();
    })());
  }
}
