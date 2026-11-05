// @effect-diagnostics cryptoRandomUUID:off - the CLI facet's incarnation and I/O ids exist without an Effect runtime.
import { DurableObject, RpcTarget } from "cloudflare:workers";
import type { Computer } from "../computer/Computer.ts";
import type { KernelCommandChild } from "../kernel/KernelCommandForwarder.ts";
import {
  createClaudeKernelResources,
  type ClaudeKernelLocalOptions,
} from "./ClaudeKernelResources.ts";
import { ClaudeCliProcess } from "./ClaudeCliProcess.ts";
import { captureClaudeTranscriptFiles } from "./ClaudeTranscriptFiles.ts";
import type {
  ClaudeKernelInitialize,
  ClaudeKernelSessionPort,
  ClaudeKernelCommand,
} from "./ClaudeKernelSessionPort.ts";
import {
  captureKernelCheckpointFiles,
  materializeKernelCheckpointFiles,
} from "../kernel/KernelCheckpointFiles.ts";
import {
  KernelFileTransfer,
  kernelFileTransferManifest,
  readKernelFileTransfer,
  type KernelFileTransferManifest,
  type KernelFileTransferPort,
} from "../kernel/KernelFileTransfer.ts";
import { ClaudeKernelNetworkTarget } from "./ClaudeKernelNetworkPort.ts";
import { ownRpcResponse } from "../rpc/response.ts";
import { retainRpcCapability } from "../rpc/Capability.ts";
import { rpcRequest } from "../rpc/Request.ts";

class CommandControl extends RpcTarget {
  #child: KernelCommandChild | undefined;
  readonly #remove;
  #closed: Promise<void> | undefined;
  constructor(child: KernelCommandChild, remove: () => void) {
    super();
    this.#child = child;
    this.#remove = remove;
  }
  async exited() {
    if (this.#child === undefined) throw new Error("Kernel command is closed");
    return await this.#child.exited;
  }
  async signal(signal: number) {
    if (this.#child === undefined) throw new Error("Kernel command is closed");
    return await this.#child.signal(signal);
  }
  dispose() {
    return (this.#closed ??= (async () => {
      const child = this.#child;
      this.#child = undefined;
      try {
        await child?.dispose();
      } finally {
        this.#remove();
      }
    })());
  }
}

/** A CLI facet owns exactly one canonical kernel and one unchanged official process. */
export class ClaudeKernelSession extends RpcTarget implements ClaudeKernelSessionPort {
  readonly #build;
  readonly #nonce = crypto.randomUUID();
  readonly #lifetime = new AbortController();
  #input: ClaudeKernelInitialize | undefined;
  #initializing: Promise<ReturnType<typeof createClaudeKernelResources>> | undefined;
  #configured:
    | Promise<{
        readonly fileIdentity: string;
        readonly registrations: Awaited<
          ReturnType<Parameters<ClaudeKernelSessionPort["configure"]>[0]["owner"]["registrations"]>
        >;
      }>
    | undefined;
  #callbacks: Parameters<ClaudeKernelSessionPort["configure"]>[0]["callbacks"] | undefined;
  #restored: Awaited<ReturnType<typeof readKernelFileTransfer>> | undefined;
  #cli: ClaudeCliProcess | undefined;
  #opened = false;
  #closed: Promise<void> | undefined;
  readonly #commands = new Map<
    string,
    { readonly controller: AbortController; readonly child?: { dispose(): Promise<void> } }
  >();
  readonly #earlyCancel = new Map<string, unknown>();
  readonly #active = new Set<Promise<unknown>>();
  readonly #diagnostics = new Set<Promise<unknown>>();
  readonly #diagnosticFailures: unknown[] = [];
  readonly #capabilities: Disposable[] = [];
  constructor(
    build: (
      input: ClaudeKernelInitialize,
    ) => Promise<ClaudeKernelLocalOptions> | ClaudeKernelLocalOptions,
  ) {
    super();
    this.#build = build;
  }
  #track(pending: Promise<unknown>) {
    this.#diagnostics.add(pending);
    void pending.then(
      () => this.#diagnostics.delete(pending),
      (error: unknown) => {
        this.#diagnostics.delete(pending);
        this.#diagnosticFailures.push(error);
      },
    );
  }
  #current() {
    this.#lifetime.signal.throwIfAborted();
    if (this.#initializing === undefined) throw new Error("CLI kernel is not initialized");
    return this.#initializing;
  }
  async initialize(input: ClaudeKernelInitialize) {
    this.#lifetime.signal.throwIfAborted();
    if (this.#input !== undefined) {
      if (
        input.threadId !== this.#input.threadId ||
        input.sessionKey !== this.#input.sessionKey ||
        input.nativeSessionId !== this.#input.nativeSessionId ||
        input.files.identity !== this.#input.files.identity ||
        input.machineInventory.imageDigest !== this.#input.machineInventory.imageDigest ||
        JSON.stringify(input.process) !== JSON.stringify(this.#input.process) ||
        JSON.stringify(input.files) !== JSON.stringify(this.#input.files)
      )
        throw new Error("CLI kernel initialization changed its owner or policy");
    } else {
      this.#input = input;
      this.#initializing = Promise.resolve(this.#build(input)).then((options) => {
        this.#lifetime.signal.throwIfAborted();
        return createClaudeKernelResources(input, options, this.#lifetime.signal);
      });
    }
    await this.#current();
    return { fileIdentity: `${input.files.identity}/${this.#nonce}` };
  }
  configure(config: Parameters<ClaudeKernelSessionPort["configure"]>[0]) {
    this.#lifetime.signal.throwIfAborted();
    if (this.#configured !== undefined) throw new Error("CLI kernel is already configured");
    const retain = <T extends object>(value: T) => {
      const owner = retainRpcCapability(value);
      this.#capabilities.push(owner);
      return owner.value;
    };
    config = {
      ...config,
      owner: retain(config.owner),
      source: retain(config.source),
      callbacks: retain(config.callbacks),
    };
    this.#configured = (async () => {
      const resources = await this.#current();
      if (
        config.threadId !== this.#input?.threadId ||
        JSON.stringify(config.process) !== JSON.stringify(this.#input.process)
      )
        throw new Error("CLI kernel configuration changed process ownership");
      this.#callbacks = config.callbacks;
      const registrations = await resources.configure({
        ...config,
        callbacks: {
          model: (id, request) => config.callbacks.model(id, request),
          cancel: (id, reason) => config.callbacks.cancel(id, reason),
          report: (report) => config.callbacks.report(report),
          startup: (cause) => config.callbacks.startup(cause),
          observeTool: (input, id) => config.callbacks.observeTool(input, id),
          continuation: (input) => config.callbacks.continuation(input),
          output: (fd, bytes) => {
            const pending = config.callbacks.output(fd, bytes);
            this.#track(pending);
            return pending;
          },
          input: (bytes) => {
            const pending = config.callbacks.input(bytes);
            this.#track(pending);
            return pending;
          },
        },
      });
      return { fileIdentity: `${this.#input.files.identity}/${this.#nonce}`, registrations };
    })();
    return this.#configured;
  }
  async #ready() {
    if (this.#configured === undefined) throw new Error("CLI kernel is not configured");
    await this.#configured;
    return await this.#current();
  }
  async #operation<T>(pending: Promise<T>): Promise<T> {
    this.#active.add(pending);
    try {
      return await pending;
    } finally {
      this.#active.delete(pending);
    }
  }
  #controlled<T>(id: string, run: (signal: AbortSignal) => Promise<T>) {
    return this.#operation(
      (async () => {
        this.#lifetime.signal.throwIfAborted();
        if (!id || this.#commands.has(id)) throw new Error("Duplicate CLI kernel operation");
        const controller = new AbortController();
        this.#commands.set(id, { controller });
        if (this.#earlyCancel.has(id)) {
          controller.abort(this.#earlyCancel.get(id));
          this.#earlyCancel.delete(id);
        }
        const signal = AbortSignal.any([this.#lifetime.signal, controller.signal]);
        try {
          signal.throwIfAborted();
          return await run(signal);
        } finally {
          this.#commands.delete(id);
        }
      })(),
    );
  }
  seed(stage: "assets" | "programs", id: string = crypto.randomUUID()) {
    return this.#controlled(id, async (signal) => {
      const resources = await this.#ready();
      await resources.boot().seed(stage, signal);
    });
  }
  claim(attemptId: string, inputHash: string, id: string = crypto.randomUUID()) {
    return this.#controlled(id, async (signal) => {
      const resources = await this.#ready();
      await resources.boot().claim(attemptId, inputHash, signal);
    });
  }
  prepare(id: string = crypto.randomUUID()) {
    return this.#controlled(id, async (signal) => {
      const resources = await this.#ready();
      await resources.prepare(this.#restored, signal);
      this.#restored = undefined;
    });
  }
  materialize(manifest: KernelFileTransferManifest, source: KernelFileTransferPort) {
    return this.#operation(
      (async () => {
        if (this.#configured !== undefined)
          throw new Error("Checkpoint restore must precede kernel configuration");
        const resources = await this.#current();
        const files = await readKernelFileTransfer(manifest, source);
        this.#lifetime.signal.throwIfAborted();
        materializeKernelCheckpointFiles(resources.storage.files, files);
        this.#restored = files;
      })(),
    );
  }
  async capture(paths: readonly string[]) {
    const resources = await this.#ready();
    const cwd = resources.storage.files.cwd;
    await resources.storage.files.prepareLowerPaths(
      paths.map((path) => (path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`)),
      this.#lifetime.signal,
    );
    const files = captureKernelCheckpointFiles(resources.storage.files, paths);
    return { manifest: kernelFileTransferManifest(files), source: new KernelFileTransfer(files) };
  }
  captureTranscripts(
    nativeId: string,
    configurationDirectory: string,
    id: string = crypto.randomUUID(),
  ) {
    return this.#controlled(id, async (signal) =>
      captureClaudeTranscriptFiles(
        (await this.#ready()).storage.files,
        configurationDirectory,
        nativeId,
        signal,
      ),
    );
  }
  open(input: Parameters<ClaudeKernelSessionPort["open"]>[0]) {
    return this.#operation(this.#open(input));
  }
  async #open(input: Parameters<ClaudeKernelSessionPort["open"]>[0]) {
    const resources = await this.#ready();
    if (this.#opened || this.#input === undefined || this.#callbacks === undefined)
      throw new Error("CLI kernel has no available process ownership");
    this.#opened = true;
    const callbacks = this.#callbacks;
    const configured = this.#input;
    const computer: Computer = {
      threadId: configured.threadId,
      files: resources.storage.files,
      exec: resources.commands().exec,
      port: (port, signal) => resources.port(port, signal),
      save: (signal) => resources.save(signal),
    };
    const report = (value: Parameters<typeof callbacks.report>[0]) =>
      this.#track(callbacks.report(value));
    this.#cli = new ClaudeCliProcess(
      {
        ...configured.process,
        ...resources.native(),
        systemIdentity: resources.systemIdentity,
        host: resources.commands().host,
        computer,
        stdio: resources.stdio,
        loadedRelease: resources.loaded(),
        modelTransport: (request) => this.#model(request),
      },
      {
        ...input,
        computer,
        modelTransport: (request) => this.#model(request),
        loadedRelease: resources.loaded(),
      },
      {
        cliSpawnContext: (context) => report({ type: "spawn", context }),
        turnMilestone: (stage) => report({ type: "milestone", stage }),
        cliStartupFailure: (cause) => this.#track(callbacks.startup(cause)),
        releaseModuleOmitted: (event, failure) => {
          if (failure === undefined)
            throw new Error("CLI omission did not include its compatibility failure");
          return callbacks.report({ type: "omission", event, failure });
        },
      },
      async (event, toolUseId) => callbacks.observeTool(event, toolUseId),
      async (request) => callbacks.continuation(request),
    );
    return this.#cli;
  }
  async #model(request: Request) {
    const callbacks = this.#callbacks;
    if (callbacks === undefined) throw new Error("CLI host callbacks are unavailable");
    const id: string = crypto.randomUUID();
    const abort = () => {
      void callbacks.cancel(id, request.signal.reason).catch(() => undefined);
    };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    try {
      const response = await callbacks.model(id, rpcRequest(request));
      return await ownRpcResponse(response, {
        signal: request.signal,
        release: () => request.signal.removeEventListener("abort", abort),
        bodyOpened() {},
        bodyClosed() {},
        bodyBytes() {},
        socketOpened() {},
        socketClosed() {},
      });
    } catch (error) {
      request.signal.removeEventListener("abort", abort);
      throw error;
    }
  }
  exec(id: string, command: Parameters<ClaudeKernelSessionPort["exec"]>[1], localOnly: boolean) {
    return this.#operation(this.#exec(id, command, localOnly));
  }
  async #exec(
    id: string,
    command: Parameters<ClaudeKernelSessionPort["exec"]>[1],
    localOnly: boolean,
  ): Promise<ClaudeKernelCommand> {
    const resources = await this.#ready();
    if (!id || this.#commands.has(id)) throw new Error("Duplicate CLI command operation");
    const controller = new AbortController();
    if (this.#earlyCancel.has(id)) {
      controller.abort(this.#earlyCancel.get(id));
      this.#earlyCancel.delete(id);
    }
    this.#commands.set(id, { controller });
    try {
      const signal = AbortSignal.any([this.#lifetime.signal, controller.signal]);
      signal.throwIfAborted();
      const child = await (localOnly ? resources.commands().isolate : resources.commands()).exec(
        command,
        signal,
        undefined,
      );
      if (signal.aborted) {
        await child.dispose();
        signal.throwIfAborted();
      }
      const control = new CommandControl(child, () => this.#commands.delete(id));
      this.#commands.set(id, { controller, child: control });
      return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, control };
    } catch (error) {
      this.#commands.delete(id);
      throw error;
    }
  }
  async cancel(id: string, reason?: unknown) {
    const current = this.#commands.get(id);
    if (current !== undefined) current.controller.abort(reason);
    else if (this.#earlyCancel.size < 64) this.#earlyCancel.set(id, reason);
  }
  save(id: string = crypto.randomUUID()) {
    return this.#controlled(id, async (signal) => (await this.#ready()).save(signal));
  }
  port(port: number, id: string = crypto.randomUUID()) {
    return this.#operation(
      (async () => {
        const resources = await this.#ready();
        if (!id || this.#commands.has(id)) throw new Error("Duplicate CLI kernel port operation");
        const controller = new AbortController();
        this.#commands.set(id, { controller });
        if (this.#earlyCancel.has(id)) {
          controller.abort(this.#earlyCancel.get(id));
          this.#earlyCancel.delete(id);
        }
        const signal = AbortSignal.any([this.#lifetime.signal, controller.signal]);
        try {
          signal.throwIfAborted();
          const target = new ClaudeKernelNetworkTarget(
            await resources.port(port, signal),
            signal,
            () => this.#commands.delete(id),
          );
          if (signal.aborted) {
            await target.dispose();
            signal.throwIfAborted();
          }
          this.#commands.set(id, { controller, child: target });
          return target;
        } catch (error) {
          this.#commands.delete(id);
          throw error;
        }
      })(),
    );
  }
  async kernelIdentity() {
    await this.#current();
    return { kernelNonce: this.#nonce, fileIdentity: this.#input!.files.identity };
  }
  close() {
    return (this.#closed ??= (async () => {
      this.#lifetime.abort(new Error("CLI kernel owner closed"));
      const resources = await this.#initializing?.catch(() => undefined);
      await this.#configured?.catch(() => undefined);
      while (this.#active.size > 0) await Promise.allSettled(this.#active);
      const results = await Promise.allSettled([
        this.#cli?.dispose(),
        ...[...this.#commands.values()].map((entry) => entry.child?.dispose()),
      ]);
      const resourceCleanup = await Promise.allSettled([resources?.close()]);
      while (this.#diagnostics.size > 0) await Promise.allSettled(this.#diagnostics);
      this.#commands.clear();
      this.#earlyCancel.clear();
      this.#callbacks = undefined;
      this.#restored = undefined;
      this.#input = undefined;
      this.#initializing = undefined;
      this.#configured = undefined;
      this.#cli = undefined;
      const failures = [
        ...this.#diagnosticFailures,
        ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        ...resourceCleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        ),
      ];
      for (const capability of this.#capabilities.splice(0).toReversed()) {
        try {
          capability[Symbol.dispose]();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "CLI kernel cleanup failed");
    })());
  }
}

export function createClaudeKernelFacetClass<Env>(
  build: (input: {
    readonly ctx: DurableObjectState;
    readonly env: Env;
    readonly configuration: ClaudeKernelInitialize;
  }) => ClaudeKernelLocalOptions | Promise<ClaudeKernelLocalOptions>,
) {
  return class ClaudeKernelFacet extends DurableObject<Env> {
    readonly #session = new ClaudeKernelSession((configuration) =>
      build({ ctx: this.ctx, env: this.env, configuration }),
    );
    initialize(input: ClaudeKernelInitialize) {
      return this.#session.initialize(input);
    }
    configure(input: Parameters<ClaudeKernelSessionPort["configure"]>[0]) {
      return this.#session.configure(input);
    }
    seed(stage: "assets" | "programs", id?: string) {
      return this.#session.seed(stage, id);
    }
    claim(attemptId: string, inputHash: string, id?: string) {
      return this.#session.claim(attemptId, inputHash, id);
    }
    prepare(id?: string) {
      return this.#session.prepare(id);
    }
    materialize(manifest: KernelFileTransferManifest, source: KernelFileTransferPort) {
      return this.#session.materialize(manifest, source);
    }
    capture(paths: readonly string[]) {
      return this.#session.capture(paths);
    }
    captureTranscripts(nativeId: string, configurationDirectory: string, id?: string) {
      return this.#session.captureTranscripts(nativeId, configurationDirectory, id);
    }
    open(input: Parameters<ClaudeKernelSessionPort["open"]>[0]) {
      return this.#session.open(input);
    }
    exec(id: string, command: Parameters<ClaudeKernelSessionPort["exec"]>[1], localOnly: boolean) {
      return this.#session.exec(id, command, localOnly);
    }
    cancel(id: string, reason?: unknown) {
      return this.#session.cancel(id, reason);
    }
    save(id?: string) {
      return this.#session.save(id);
    }
    port(port: number, id?: string) {
      return this.#session.port(port, id);
    }
    kernelIdentity() {
      return this.#session.kernelIdentity();
    }
    close() {
      return this.#session.close();
    }
  };
}
