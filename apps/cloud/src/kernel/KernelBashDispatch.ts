import { RpcTarget } from "cloudflare:workers";
import { retainRpcCapability } from "../rpc/Capability.ts";
import { createKernelBashHost } from "./KernelBashHost.ts";
import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import type { KernelBashCredentials } from "./KernelBashProgram.ts";
import { ChildBashExecutionGroup } from "./KernelBashExecutionGroup.ts";
import { ChildHostLease } from "./KernelDispatchLease.ts";
import { isStoppedWorkerLoaderQuotaFailure } from "./KernelWorkerDispatchError.ts";
import { createKernelProcessAdmissionPort } from "./KernelProcessAdmissionPort.ts";
import type { KernelProcessAdmissionPort } from "./KernelProcessAdmissionPort.ts";
import type { KernelBashWorkerRunner } from "./KernelWorkerExecution.ts";
import type {
  KernelBashDispatcher,
  KernelBashPhasePort,
  KernelBashPhaseExecution,
} from "./KernelBashDispatchPort.ts";
import { restoreKernelWorkerFailure, type KernelWorkerFailure } from "./KernelWorkerFailure.ts";

class RequesterTarget extends RpcTarget implements KernelProcessAdmissionPort {
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

class BashPhase extends RpcTarget implements KernelBashPhasePort {
  #context: KernelAsyncProgramContext | undefined;
  #create: Parameters<KernelBashWorkerRunner["run"]>[1] | undefined;
  readonly #lease = new ChildHostLease();
  readonly #requester;
  readonly #abort = Promise.withResolvers<{
    readonly aborted: boolean;
    readonly reason?: unknown;
  }>();
  readonly #onAbort;
  #host: Awaited<ReturnType<Parameters<KernelBashWorkerRunner["run"]>[1]>> | undefined;
  #opened = false;
  #execution: ReturnType<typeof retainRpcCapability<KernelBashPhaseExecution>> | undefined;
  constructor(
    context: KernelAsyncProgramContext,
    create: Parameters<KernelBashWorkerRunner["run"]>[1],
  ) {
    super();
    this.#context = context;
    this.#create = create;
    this.#requester = createKernelProcessAdmissionPort({
      processes: context.processes,
      process: context.identity.handle,
      signal: context.signal,
    });
    this.#onAbort = () => {
      const signal = this.#context?.signal;
      if (signal !== undefined) this.#abort.resolve({ aborted: true, reason: signal.reason });
    };
    context.signal.addEventListener("abort", this.#onAbort, { once: true });
    if (context.signal.aborted) this.#onAbort();
  }
  #current() {
    if (this.#context === undefined)
      throw Object.assign(new Error("Bash phase is closed"), { code: "EBADF" });
    this.#context.signal.throwIfAborted();
    return this.#context;
  }
  async describe() {
    const context = this.#current();
    return {
      command: {
        executable: context.args[0] ?? "/bin/bash",
        argv: [...context.args],
        cwd: context.filesystem.cwd,
        env: { ...context.env },
      },
      requester: new RequesterTarget(this.#requester),
    };
  }
  async open(residentByteLimit: number, execution: KernelBashPhaseExecution) {
    const context = this.#current();
    if (this.#opened || this.#create === undefined)
      throw new Error("Bash phase was already opened");
    if (!Number.isSafeInteger(residentByteLimit) || residentByteLimit < 1)
      throw new RangeError("Invalid Bash resident byte limit");
    this.#opened = true;
    const capability = retainRpcCapability(execution);
    this.#execution = capability;
    try {
      this.#host = this.#create(context, this.#lease, {
        residentByteLimit,
        handoff: () => capability.value.handoff(),
      });
    } catch (cause) {
      capability[Symbol.dispose]();
      this.#execution = undefined;
      throw cause;
    }
    return this.#host.host;
  }
  async aborted() {
    return await this.#abort.promise;
  }
  async failure(failure: KernelWorkerFailure) {
    await this.#host?.onDispatchFailure?.(
      restoreKernelWorkerFailure(failure, new Promise<void>(() => {})),
    );
  }
  async revoke() {
    this.#lease.release();
    await this.#host?.close();
  }
  async stopped() {
    try {
      await this.#host?.onStopped?.();
    } finally {
      const context = this.#context;
      this.#context = undefined;
      this.#create = undefined;
      this.#host = undefined;
      this.#requester.close();
      context?.signal.removeEventListener("abort", this.#onAbort);
      this.#abort.resolve({ aborted: false });
      this.#execution?.[Symbol.dispose]();
      this.#execution = undefined;
    }
  }
}

/** Kernel fork and checkpoint state stays beside the single authoritative filesystem. */
export function startKernelBashDispatch(
  context: KernelAsyncProgramContext,
  credentials: KernelBashCredentials,
  dispatcher: KernelBashDispatcher,
) {
  const runner = (initial: boolean): KernelBashWorkerRunner => ({
    async run(context, createHost, residentBytes = 0) {
      const phase = new BashPhase(context, createHost);
      const result = await dispatcher.run(phase, initial, residentBytes);
      if (!result.ok) throw restoreKernelWorkerFailure(result.failure, dispatcher.finished());
      return result.exit;
    },
  });
  const group = new ChildBashExecutionGroup(runner(true), runner(false), credentials);
  const owner = createKernelBashHost({
    context,
    credentials,
    isStoppedQuotaFailure: isStoppedWorkerLoaderQuotaFailure,
    runFork: (forked, forkOwner, source) => group.run(forked, forkOwner, source),
  });
  void group.run(context, owner, undefined, true).catch(() => undefined);
  return { exited: owner.exited, finished: group.finish(owner.close) };
}
