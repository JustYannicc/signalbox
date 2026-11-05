import { RpcTarget } from "cloudflare:workers";
import type { ClaudeKernelCallbacks } from "./ClaudeKernelSessionPort.ts";
import type { HarnessRuntimeReporter } from "./HarnessProcessLifetime.ts";
import type { ClaudeToolObservation } from "./ClaudeToolObservation.ts";
import { ownRpcResponse } from "../rpc/response.ts";
import { requestFromRpc, type RpcRequest } from "../rpc/Request.ts";

interface ClaudeKernelHostRuntime {
  readonly model: (request: Request) => Promise<Response>;
  readonly reporter: HarnessRuntimeReporter;
  readonly continuation: (request: unknown) => Promise<void>;
}

/** The host owns transport cancellation and reports; the CLI owns only their async capability. */
export class ClaudeKernelHostCallbacks extends RpcTarget implements ClaudeKernelCallbacks {
  readonly #lifetime: AbortSignal;
  readonly #options;
  readonly #requests = new Map<string, AbortController>();
  readonly #cancelled = new Map<string, unknown>();
  #runtime: ClaudeKernelHostRuntime | undefined;
  constructor(options: {
    readonly signal: AbortSignal;
    readonly toolObservation?: ClaudeToolObservation;
    readonly startup?: (cause: unknown) => void;
    readonly output?: (fd: number, bytes: Uint8Array) => void;
    readonly input?: (bytes: Uint8Array) => void;
  }) {
    super();
    this.#options = options;
    this.#lifetime = options.signal;
  }
  bind(runtime: ClaudeKernelHostRuntime) {
    this.#lifetime.throwIfAborted();
    if (this.#runtime !== undefined) throw new Error("CLI host callbacks already bound");
    this.#runtime = runtime;
  }
  #current() {
    if (this.#runtime === undefined) throw new Error("CLI host callbacks are unavailable");
    return this.#runtime;
  }
  async model(id: string, request: RpcRequest) {
    this.#lifetime.throwIfAborted();
    const runtime = this.#current();
    if (!id || this.#requests.has(id)) throw new Error("Duplicate CLI model request");
    const controller = new AbortController();
    this.#requests.set(id, controller);
    if (this.#cancelled.has(id)) {
      controller.abort(this.#cancelled.get(id));
      this.#cancelled.delete(id);
    }
    const signal = AbortSignal.any([this.#lifetime, controller.signal]);
    try {
      signal.throwIfAborted();
      const response = await runtime.model(requestFromRpc(request, signal));
      return await ownRpcResponse(response, {
        signal,
        release: () => {
          this.#requests.delete(id);
        },
        bodyOpened() {},
        bodyClosed() {},
        bodyBytes() {},
        socketOpened() {},
        socketClosed() {},
      });
    } catch (error) {
      this.#requests.delete(id);
      throw error;
    }
  }
  async cancel(id: string, reason?: unknown) {
    const request = this.#requests.get(id);
    if (request !== undefined) request.abort(reason);
    else if (this.#cancelled.size < 64) this.#cancelled.set(id, reason);
  }
  async report(report: Parameters<ClaudeKernelCallbacks["report"]>[0]) {
    const { reporter } = this.#current();
    if (report.type === "spawn") reporter.cliSpawnContext?.(report.context);
    else if (report.type === "milestone") reporter.turnMilestone?.(report.stage);
    else await reporter.releaseModuleOmitted(report.event, report.failure);
  }
  async startup(cause: unknown) {
    this.#options.startup?.(cause);
    this.#runtime?.reporter.cliStartupFailure?.(cause);
  }
  async observeTool(
    input: Parameters<ClaudeKernelCallbacks["observeTool"]>[0],
    toolUseId: string | undefined,
  ) {
    await this.#options.toolObservation?.hooks[input.hook_event_name]?.[0]?.hooks[0]?.(
      input,
      toolUseId,
      { signal: this.#lifetime },
    );
  }
  async continuation(input: unknown) {
    await this.#current().continuation(input);
  }
  async output(fd: number, bytes: Uint8Array) {
    this.#options.output?.(fd, bytes);
  }
  async input(bytes: Uint8Array) {
    this.#options.input?.(bytes);
  }
  close() {
    this.#runtime = undefined;
    for (const controller of this.#requests.values())
      controller.abort(new Error("CLI host closed"));
    this.#requests.clear();
    this.#cancelled.clear();
  }
}
