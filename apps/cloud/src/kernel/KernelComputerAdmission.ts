// @effect-diagnostics cryptoRandomUUID:off - invocation ids belong to the portable kernel RPC adapter.
import { RpcTarget } from "cloudflare:workers";
import { rpcStubOwner } from "../rpc/Resources.ts";
import { KernelProgramExecAdmissionError } from "./KernelAsyncProgram.ts";
import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import type {
  KernelProgramAdmissionRequest,
  KernelProgramAdmissionDecision,
} from "./KernelProgramAdmission.ts";
import { validateKernelProgramAdmissionContext } from "./KernelProgramAdmissionContext.ts";
import {
  assertComputerForwardingSupported,
  createComputerForwardedProgram,
} from "./KernelForwardedProgram.ts";
import type { KernelCommandForwarder } from "./KernelCommandForwarder.ts";
import { createKernelProcessAdmissionPort } from "./KernelProcessAdmissionPort.ts";
import type { KernelProcessAdmissionPort } from "./KernelProcessAdmissionPort.ts";
import type { KernelExecutableNamespaceOwner } from "./KernelExecutableNamespace.ts";
import type { KernelChildRegistration } from "./KernelChildDispatchPort.ts";
import type {
  ComputerProgramOwnerPort,
  ComputerAdmissionResult,
  KernelComputerAdmissionCapture,
} from "./KernelComputerAdmissionPort.ts";
import { KernelChildDispatch } from "./KernelChildDispatch.ts";
import { restoreKernelWorkerFailure } from "./KernelWorkerFailure.ts";

class Requester extends RpcTarget implements KernelProcessAdmissionPort {
  readonly #owner;
  constructor(owner: KernelProcessAdmissionPort) {
    super();
    this.#owner = owner;
  }
  async describe() {
    return await this.#owner.describe();
  }
  async bind(owner: string) {
    await this.#owner.bind(owner);
  }
}

const currentCapture = Symbol("currentCapture");
const bindCapture = Symbol("bindCapture");
const dispatchCapture = Symbol("dispatchCapture");
const finishNamespaceCapture = Symbol("finishNamespaceCapture");
const closeCapture = Symbol("closeCapture");
const ownReplyCapture = Symbol("ownReplyCapture");
const signalCapture = Symbol("signalCapture");

class AdmissionCapture extends RpcTarget implements KernelComputerAdmissionCapture {
  #request: KernelProgramAdmissionRequest | undefined;
  #context:
    | {
        readonly value: KernelAsyncProgramContext;
        readonly cwd: string;
        readonly pid: number;
        readonly handle: KernelAsyncProgramContext["identity"]["handle"];
      }
    | undefined;
  readonly #namespace;
  readonly #controller = new AbortController();
  readonly #abort = Promise.withResolvers<{
    readonly aborted: boolean;
    readonly reason?: unknown;
  }>();
  readonly #onAbort;
  #requester: ReturnType<typeof createKernelProcessAdmissionPort> | undefined;
  #claimed = false;
  #reply: (() => Promise<void>) | undefined;
  constructor(request: KernelProgramAdmissionRequest, namespace: KernelExecutableNamespaceOwner) {
    super();
    this.#request = request;
    this.#namespace = namespace;
    this.#onAbort = () => {
      const signal = this.#request?.signal;
      if (signal === undefined) return;
      this.#controller.abort(signal.reason);
      this.#abort.resolve({ aborted: true, reason: signal.reason });
    };
    request.signal.addEventListener("abort", this.#onAbort, { once: true });
    if (request.signal.aborted) this.#onAbort();
  }
  [currentCapture]() {
    if (this.#request === undefined || this.#controller.signal.aborted)
      throw new KernelProgramExecAdmissionError(
        "ECANCELED",
        "Kernel admission capability was revoked",
      );
    this.#request.signal.throwIfAborted();
    return this.#request;
  }
  async inspect(path: string, artifact?: Parameters<KernelExecutableNamespaceOwner["inspect"]>[1]) {
    this[currentCapture]();
    return await this.#namespace.inspect(path, artifact);
  }
  async canReplace(path: string) {
    this[currentCapture]();
    return (await this.#namespace.canReplace?.(path)) ?? false;
  }
  async requester() {
    const request = this[currentCapture]();
    if (this.#requester !== undefined)
      throw new Error("Kernel admission requester was already taken");
    const process = request.kind === "exec" ? request.identity?.handle : request.parent;
    const info = request.processes.info(process);
    if (info.status !== "ok")
      throw new KernelProgramExecAdmissionError("ESRCH", "Kernel admission parent is unavailable");
    this.#requester = createKernelProcessAdmissionPort({
      processes: request.processes,
      process,
      signal: this.#controller.signal,
      parentPid: request.kind === "exec" ? info.value.parentPid : info.value.pid,
    });
    return new Requester(this.#requester);
  }
  async assertForwarding() {
    assertComputerForwardingSupported(this[currentCapture]());
  }
  async aborted() {
    return await this.#abort.promise;
  }
  async revoke() {
    this.#controller.abort(
      new KernelProgramExecAdmissionError(
        "ECANCELED",
        "Computer admission owner revoked its grant",
      ),
    );
    this.#abort.resolve({ aborted: true, reason: this.#controller.signal.reason });
    await this[finishNamespaceCapture]();
  }
  [bindCapture](context: KernelAsyncProgramContext) {
    const request = this[currentCapture]();
    if (this.#context !== undefined || this.#claimed)
      throw new Error("Computer grant was already bound");
    validateKernelProgramAdmissionContext(request, context);
    this.#context = {
      value: context,
      cwd: context.filesystem.cwd,
      pid: context.identity.pid,
      handle: context.identity.handle,
    };
  }
  [dispatchCapture](
    context: KernelAsyncProgramContext,
    registration: KernelChildRegistration,
    hostname: string,
  ) {
    const request = this[currentCapture]();
    const bound = this.#context;
    if (
      this.#claimed ||
      bound?.value !== context ||
      bound.cwd !== context.filesystem.cwd ||
      bound.pid !== context.identity.pid ||
      bound.handle !== context.identity.handle
    )
      throw new TypeError("Computer grant does not own this kernel dispatch");
    validateKernelProgramAdmissionContext(request, context);
    this.#claimed = true;
    return new KernelChildDispatch(
      { ...context, signal: AbortSignal.any([context.signal, this.#controller.signal]) },
      registration,
      hostname,
    );
  }
  async [finishNamespaceCapture]() {
    this.#requester?.close();
    await this.#namespace.close();
  }
  [ownReplyCapture](reply: ComputerAdmissionResult) {
    const owner = rpcStubOwner(reply);
    let released: Promise<void> | undefined;
    this.#reply = () =>
      (released ??= (async () => {
        try {
          if (reply.route === "child") await reply.grant.finished();
        } finally {
          owner[Symbol.dispose]();
        }
      })());
  }
  async [closeCapture]() {
    const request = this.#request;
    this.#request = undefined;
    this.#context = undefined;
    request?.signal.removeEventListener("abort", this.#onAbort);
    this.#abort.resolve({ aborted: false });
    try {
      await this[finishNamespaceCapture]();
    } finally {
      try {
        await this.#reply?.();
      } finally {
        this.#reply = undefined;
      }
    }
  }
  [signalCapture](signal: AbortSignal) {
    return AbortSignal.any([signal, this.#controller.signal]);
  }
}

/** Local guards remain synchronous; the Computer DO owns policy, reservations and child execution. */
export function createKernelComputerAdmission(options: {
  readonly owner: ComputerProgramOwnerPort;
  readonly namespace: (request: KernelProgramAdmissionRequest) => KernelExecutableNamespaceOwner;
  readonly machine: KernelCommandForwarder;
  readonly track: (pending: Promise<unknown>) => void;
  readonly hostname: string;
}) {
  return async (
    request: KernelProgramAdmissionRequest,
    localOnly = false,
  ): Promise<KernelProgramAdmissionDecision> => {
    const id = crypto.randomUUID();
    const capture = new AdmissionCapture(request, options.namespace(request));
    let transferred = false;
    try {
      const result = await options.owner.admit(
        id,
        {
          kind: request.kind,
          command: request.command,
          localOnly,
          target:
            request.target.kind === "resolved"
              ? { kind: "resolved", manifest: request.target.binding.manifest }
              : request.target,
        },
        capture,
      );
      capture[ownReplyCapture](result);
      capture[currentCapture]();
      if (result.route === "machine") {
        assertComputerForwardingSupported(request);
        const implementation = createComputerForwardedProgram(options.machine, result.command);
        transferred = true;
        return {
          kind: "forward",
          implementation: {
            kind: "async",
            run: async (context) => {
              try {
                return await implementation.run({
                  ...context,
                  signal: capture[signalCapture](context.signal),
                });
              } finally {
                await capture[closeCapture]();
              }
            },
          },
          assertCurrent: () => {
            capture[currentCapture]();
            assertComputerForwardingSupported(request);
          },
          cancel: () => {
            options.track(capture.revoke().then(() => capture[closeCapture]()));
          },
        };
      }
      await capture[finishNamespaceCapture]();
      capture[currentCapture]();
      transferred = true;
      return {
        kind: "forward",
        admission: Object.freeze({}),
        implementation: {
          kind: "async",
          ...(result.registration.sigpipe === undefined
            ? {}
            : { sigpipe: result.registration.sigpipe }),
          async run(context) {
            const process = capture[dispatchCapture](
              context,
              result.registration,
              options.hostname,
            );
            let reply;
            try {
              reply = await result.grant.run(process);
            } catch (error) {
              const finished = result.grant
                .finished()
                .then(() => process.close())
                .finally(() => capture[closeCapture]());
              options.track(finished);
              throw restoreKernelWorkerFailure(
                {
                  message: error instanceof Error ? error.message : String(error),
                  confirmed: false,
                },
                finished.then(() => undefined),
              );
            }
            const finished = result.grant
              .finished()
              .then(() => process.close())
              .finally(() => capture[closeCapture]());
            options.track(finished);
            if (!reply.ok)
              throw restoreKernelWorkerFailure(
                reply.failure,
                finished.then(() => undefined),
              );
            return reply.exit;
          },
        },
        assertCurrent: () => {
          capture[currentCapture]();
        },
        onDispatch: (context) => capture[bindCapture](context),
        cancel: () => {
          options.track(
            capture
              .revoke()
              .then(() => options.owner.cancel(id))
              .finally(() => capture[closeCapture]()),
          );
        },
      };
    } finally {
      if (!transferred) {
        await options.owner.cancel(id).catch(() => undefined);
        await capture[closeCapture]();
      }
    }
  };
}
