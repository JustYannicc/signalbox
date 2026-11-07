// @effect-diagnostics cryptoRandomUUID:off - The CLI Worker has no Effect runtime.
import { DurableObject } from "cloudflare:workers";
import { readClaudeKernelRelease } from "./ClaudeKernelSeed.ts";
import { ClaudeCliProcess } from "./ClaudeCliProcess.ts";
import type { ClaudeCliHost, ClaudeCliInitialization } from "./ClaudeCliKernelPort.ts";
import type { NodeHarnessBaseInput, NodeHarnessStdio } from "./NodeHarnessProcess.ts";
import { launchPreparedNodeHarnessProcess } from "./NodeHarnessLaunch.ts";
import type { NodeFsBackend } from "../isolate/NodeFsBackend.ts";
import { remoteCliRuntime } from "./cliProcess/Runtime.ts";
import { createRemoteChildren } from "./cliProcess/Children.ts";
import { createCliFileBackend } from "./ClaudeCliFileSystem.ts";
import { rpcRequest } from "../rpc/Request.ts";
import { ownRpcResponse } from "../rpc/response.ts";
import { retainRpcCapability } from "../rpc/Capability.ts";

type Native = Pick<
  NodeHarnessBaseInput,
  | "nativeModules"
  | "loadPackages"
  | "loadRelease"
  | "prepared"
  | "resolvePrepared"
  | "addons"
  | "onChildProcess"
  | "drainChildProcessObservation"
  | "reportCliStartupFailure"
>;

function observedWritable(
  stream: WritableStream<Uint8Array>,
  accepted: (bytes: Uint8Array) => void,
  before?: () => Promise<void>,
) {
  const writer = stream.getWriter();
  return new WritableStream<Uint8Array>({
    async write(bytes) {
      await before?.();
      await writer.write(bytes);
      accepted(bytes);
    },
    close: () => writer.close(),
    abort: (reason) => writer.abort(reason),
  });
}

function cliStdio(
  configuration: ClaudeCliInitialization,
  files: NodeFsBackend,
  signal: AbortSignal,
  commit: () => Promise<void>,
) {
  const observers = new Set<(fd: 0 | 1 | 2, bytes: Uint8Array) => void>();
  const notify = (fd: 0 | 1 | 2, bytes: Uint8Array) => {
    for (const observer of observers) {
      try {
        observer(fd, bytes.slice());
      } catch {
        /* Observation cannot change accepted I/O. */
      }
    }
  };
  const io = {
    ...configuration.io,
    stdout: observedWritable(configuration.io.stdout, (bytes) => notify(1, bytes), commit),
    stderr: observedWritable(configuration.io.stderr, (bytes) => notify(2, bytes)),
  };
  const stdio: NodeHarnessStdio = {
    signal,
    stdin: observedWritable(configuration.io.sdkStdin, (bytes) => notify(0, bytes)),
    stdout: configuration.io.sdkStdout,
    stderr: configuration.io.sdkStderr,
    assertBound(current) {
      if (current !== files) throw new Error("CLI stdio changed its filesystem read view");
    },
    observeAcceptedWrites(observer) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    finish: async () => {
      await commit();
      await configuration.kernel.finish();
    },
    dispose: async () => {
      observers.clear();
    },
  };
  return { io, stdio };
}

/** This entry owns the official CLI and compatibility read data, with no kernel implementation. */
export function createClaudeCliFacetClass<Env>(
  native: (
    ctx: DurableObjectState,
    env: Env,
    configuration: ClaudeCliInitialization,
  ) => Native | Promise<Native>,
) {
  return class ClaudeCliFacet extends DurableObject<Env> implements ClaudeCliHost {
    readonly #lifetime = new AbortController();
    #opened = false;
    async open(
      configuration: ClaudeCliInitialization,
      input: Parameters<ClaudeCliHost["open"]>[1],
    ) {
      if (this.#opened) throw new Error("A CLI facet can launch only once");
      this.#opened = true;
      const retainedKernel = retainRpcCapability(configuration.kernel);
      const retainedCallbacks = retainRpcCapability(configuration.callbacks);
      const retainedSource = retainRpcCapability(configuration.source);
      const diagnostics = new Set<Promise<unknown>>();
      const failures: unknown[] = [];
      const track = (pending: Promise<unknown>) => {
        diagnostics.add(pending);
        void pending.then(
          () => diagnostics.delete(pending),
          (cause) => {
            diagnostics.delete(pending);
            failures.push(cause);
          },
        );
      };
      const drainDiagnostics = async () => {
        while (diagnostics.size > 0) await Promise.allSettled(diagnostics);
        if (failures.length > 0)
          throw new AggregateError(failures, "CLI diagnostics could not finish");
      };
      let files: Awaited<ReturnType<typeof createCliFileBackend>> | undefined;
      let closed: Promise<void> | undefined;
      const childrenStopped = new AbortController();
      const close = () =>
        (closed ??= (async () => {
          // A child still reaching Computer holds its files open; ending it first lets them close.
          childrenStopped.abort(new Error("CLI facet closed"));
          const results = await Promise.allSettled([files?.close(), drainDiagnostics()]);
          try {
            await configuration.kernel.dispose();
          } finally {
            this.#lifetime.abort(new Error("CLI facet closed"));
            retainedSource[Symbol.dispose]();
            retainedCallbacks[Symbol.dispose]();
            retainedKernel[Symbol.dispose]();
          }
          const rejected = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (rejected.length > 0) throw new AggregateError(rejected, "CLI facet cleanup failed");
        })());
      try {
        configuration = {
          ...configuration,
          kernel: retainedKernel.value,
          callbacks: retainedCallbacks.value,
        };
        const loaded = await readClaudeKernelRelease(
          configuration.loaded.plan,
          retainedSource.value,
          this.#lifetime.signal,
        );
        const reports = configuration.callbacks;
        const backend = await createCliFileBackend(
          {
            ...configuration,
            // The view also writes Computer's own log, which needs no turn.
            trace: (event) => void reports.report({ type: "trace", event }).catch(() => undefined),
          },
          this.#lifetime.signal,
        );
        files = backend;
        const { stdio, io } = cliStdio(
          configuration,
          backend.backend,
          this.#lifetime.signal,
          backend.commit,
        );
        const callbacks = configuration.callbacks;
        const modelTransport = async (request: Request) => {
          await backend.commit();
          const id = crypto.randomUUID();
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
          } catch (cause) {
            request.signal.removeEventListener("abort", abort);
            throw cause;
          }
        };
        const options: NodeHarnessBaseInput = {
          ...configuration.process,
          ...(await native(this.ctx, this.env, configuration)),
          systemIdentity: configuration.systemIdentity,
          computer: { threadId: configuration.threadId, files: backend.backend },
          loadedRelease: loaded,
          stdio,
          modelTransport,
        };
        const children = await createRemoteChildren({
          kernel: configuration.kernel,
          process: options,
          beforeRemote: backend.beforeRemote,
          afterRemote: backend.afterRemote,
          holdDescriptors: backend.holdDescriptors,
          writeDescriptor: backend.writeDescriptor,
          stop: childrenStopped.signal,
        });
        const runtime = remoteCliRuntime(
          { ...configuration, io },
          children,
          configuration.systemIdentity,
          backend.signalProcess,
        );
        const cli = new ClaudeCliProcess(
          {
            ...options,
            launch: (process) => {
              const abort = () => this.#lifetime.abort(process.signal?.reason);
              process.signal?.addEventListener("abort", abort, { once: true });
              if (process.signal?.aborted) abort();
              return launchPreparedNodeHarnessProcess(process, runtime);
            },
            files: {
              async call(operation, args, signal) {
                await backend.barrier();
                signal?.throwIfAborted();
                const id = crypto.randomUUID();
                const abort = () => {
                  void configuration.kernel.cancel(id, signal?.reason).catch(() => undefined);
                };
                signal?.addEventListener("abort", abort, { once: true });
                try {
                  const result = await configuration.kernel.sdkFiles(id, operation, args);
                  await backend.refresh();
                  return result;
                } finally {
                  signal?.removeEventListener("abort", abort);
                }
              },
              close,
            },
          },
          { ...input, computer: options.computer, modelTransport, loadedRelease: loaded },
          {
            cliSpawnContext: (context) => {
              track(callbacks.report({ type: "spawn", context }));
            },
            turnMilestone: (stage) => {
              track(callbacks.report({ type: "milestone", stage }));
            },
            cliStartupFailure: (cause) => {
              track(callbacks.startup(cause));
            },
            releaseModuleOmitted: (event, failure) => {
              if (failure === undefined) throw new Error("CLI omission has no failure");
              return callbacks.report({ type: "omission", event, failure });
            },
          },
          async (event, toolUseId) => {
            await backend.commit();
            await callbacks.observeTool(event, toolUseId);
          },
          async (request) => {
            await backend.commit();
            await callbacks.continuation(request);
          },
        );
        return cli;
      } catch (cause) {
        this.#lifetime.abort(cause);
        try {
          await close();
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], "CLI startup and cleanup failed", {
            cause: cleanup,
          });
        }
        throw cause;
      }
    }
  };
}
