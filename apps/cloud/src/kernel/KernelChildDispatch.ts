import { startKernelBashDispatch } from "./KernelBashDispatch.ts";
import type { KernelBashDispatcher } from "./KernelBashDispatchPort.ts";
import { RpcTarget } from "cloudflare:workers";
import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";
import { createKernelBusyboxHost } from "./KernelBusyboxHost.ts";
import { createKernelCoreutilsHost } from "./KernelCoreutilsHost.ts";
import { createKernelGitHost } from "./KernelGitHost.ts";
import { createKernelProcessAdmissionPort } from "./KernelProcessAdmissionPort.ts";
import type { KernelProcessAdmissionPort } from "./KernelProcessAdmissionPort.ts";
import type {
  KernelChildDispatchPort,
  KernelChildHostPort,
  KernelChildRegistration,
} from "./KernelChildDispatchPort.ts";

class ProcessAdmissionTarget extends RpcTarget implements KernelProcessAdmissionPort {
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

class ChildHostTarget extends RpcTarget implements KernelChildHostPort {
  #port: Partial<KernelChildHostPort> | undefined;
  constructor(port: Partial<KernelChildHostPort>) {
    super();
    this.#port = port;
  }
  #current() {
    if (this.#port === undefined)
      throw Object.assign(new Error("Child kernel port is closed"), { code: "EBADF" });
    return this.#port;
  }
  async call(input: Parameters<KernelChildHostPort["call"]>[0]) {
    const port = this.#current();
    if (port.call === undefined) throw new Error("Kernel syscall port is unavailable");
    return await port.call(input);
  }
  async callBusybox(input: Parameters<KernelChildHostPort["callBusybox"]>[0]) {
    const port = this.#current();
    if (port.callBusybox === undefined) throw new Error("Kernel BusyBox port is unavailable");
    return await port.callBusybox(input);
  }
  async callCoreutils(input: Parameters<KernelChildHostPort["callCoreutils"]>[0]) {
    const port = this.#current();
    if (port.callCoreutils === undefined) throw new Error("Kernel coreutils port is unavailable");
    return await port.callCoreutils(input);
  }
  async callGit(input: Parameters<KernelChildHostPort["callGit"]>[0]) {
    const port = this.#current();
    if (port.callGit === undefined) throw new Error("Kernel Git port is unavailable");
    return await port.callGit(input);
  }
  revoke() {
    this.#port = undefined;
  }
}

/** One admitted body borrows its exact process descriptors until dispatch acknowledges stop. */
export class KernelChildDispatch extends RpcTarget implements KernelChildDispatchPort {
  #context: KernelAsyncProgramContext | undefined;
  readonly #registration;
  readonly #hostname;
  #bash: ReturnType<typeof startKernelBashDispatch> | undefined;
  readonly #controller = new AbortController();
  readonly #requester;
  readonly #cancelled = Promise.withResolvers<{
    readonly aborted: boolean;
    readonly reason?: unknown;
  }>();
  readonly #onAbort;
  #host: { readonly port: ChildHostTarget; readonly close: () => Promise<void> | void } | undefined;
  #opened = false;
  #closed: Promise<void> | undefined;
  constructor(
    context: KernelAsyncProgramContext,
    registration: KernelChildRegistration,
    hostname: string,
  ) {
    super();
    this.#context = {
      ...context,
      signal: AbortSignal.any([context.signal, this.#controller.signal]),
    };
    this.#registration = registration;
    this.#hostname = hostname;
    this.#requester = createKernelProcessAdmissionPort({
      processes: context.processes,
      process: context.identity.handle,
      signal: context.signal,
    });
    const signal = this.#context.signal;
    this.#onAbort = () => {
      const signal = this.#context?.signal;
      if (signal !== undefined) this.#cancelled.resolve({ aborted: true, reason: signal.reason });
    };
    signal.addEventListener("abort", this.#onAbort, { once: true });
    if (signal.aborted) this.#onAbort();
  }
  #current() {
    if (this.#context === undefined)
      throw Object.assign(new Error("Kernel dispatch is closed"), { code: "EBADF" });
    this.#context.signal.throwIfAborted();
    return this.#context;
  }
  async describe() {
    const context = this.#current();
    return {
      command: {
        executable: this.#registration.executable,
        argv: [...context.args],
        cwd: context.filesystem.cwd,
        env: {
          ...context.env,
          ...(this.#registration.pwd === true ? { PWD: context.filesystem.cwd } : {}),
        },
      },
      requester: new ProcessAdmissionTarget(this.#requester),
    };
  }
  async open() {
    const original = this.#current();
    const context =
      this.#registration.pwd === true
        ? { ...original, env: { ...original.env, PWD: original.filesystem.cwd } }
        : original;
    if (this.#opened) throw new Error("Kernel dispatch was already opened");
    this.#opened = true;
    const common = { context };
    const host = (() => {
      switch (this.#registration.hostKind) {
        case "syscall": {
          const owner = createKernelSyscallHost({
            filesystem: context.filesystem,
            args: context.args,
            env: {
              ...context.env,
              ...(this.#registration.pwd === true ? { PWD: context.filesystem.cwd } : {}),
            },
            signal: context.signal,
            process: context,
            sigpipe: this.#registration.sigpipe ?? "terminate",
          });
          return { port: owner, close: owner.close };
        }
        case "busybox":
          return createKernelBusyboxHost(common);
        case "coreutils":
          return createKernelCoreutilsHost(common);
        case "git":
          return createKernelGitHost(common);
        case "bash":
          throw new Error("Bash requires a process continuation owner");
      }
    })();
    const port = new ChildHostTarget(host.port);
    this.#host = { port, close: host.close };
    return port;
  }
  async bash(dispatcher: KernelBashDispatcher) {
    const context = this.#current();
    if (this.#opened || this.#registration.hostKind !== "bash")
      throw new Error("Kernel dispatch is not an available Bash process");
    this.#opened = true;
    const posix = context.filesystem.posixPolicy;
    if (posix === undefined) throw new Error("Bash requires the kernel POSIX policy");
    this.#bash = startKernelBashDispatch(
      context,
      { ...posix.credentials, umask: posix.umask, hostname: this.#hostname },
      dispatcher,
    );
    void this.#bash.finished.catch(() => undefined);
    return await this.#bash.exited;
  }
  async finished() {
    await this.#bash?.finished;
  }
  async aborted() {
    return await this.#cancelled.promise;
  }
  async cancel(reason?: unknown) {
    this.#controller.abort(reason);
  }
  close() {
    return (this.#closed ??= (async () => {
      this.#controller.abort(new Error("Kernel dispatch closed"));
      await this.#bash?.finished;
      this.#bash = undefined;
      const context = this.#context;
      this.#context = undefined;
      context?.signal.removeEventListener("abort", this.#onAbort);
      this.#cancelled.resolve({ aborted: false });
      this.#requester.close();
      const owner = this.#host;
      this.#host = undefined;
      owner?.port.revoke();
      await owner?.close();
    })());
  }
}
