// @effect-diagnostics-next-line nodeBuiltinImport:off - Node compatibility requires the native stream and process interfaces.
import * as NodeStreamPromises from "node:stream/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Teardown waits on a host timer the guest cannot replace.
import * as NodeTimers from "node:timers";
import { NodeProcessExitError } from "../../isolate/NodeProcess.ts";
import type { NodeBridge } from "../../isolate/NodeBridge.ts";
import type { NodeChildProcess, NodeChildProcessObserver } from "../../isolate/NodeChildProcess.ts";
import type { KernelExitStatus } from "../../kernel/KernelProcessTable.ts";
import {
  CLAUDE_CLI_STARTUP_FAILURE_REPORTER_KEY,
  makeReleaseModuleOmittedFailure,
  type ReleaseModuleOmittedFailure,
} from "../HarnessProcessLifetime.ts";
import { createHarnessRuntime } from "./runtime.ts";
import { installHarnessPersonality, reserveHarnessRealm } from "./personality.ts";
import type { NodeHarnessProcess, NodeHarnessProcessInput } from "./types.ts";

type Outcome = { readonly status: KernelExitStatus } | { readonly error: unknown };

/** Owns one persistent release and its personality until all started work has settled. */
export function launchNodeHarnessProcess(input: NodeHarnessProcessInput): NodeHarnessProcess {
  const realm = reserveHarnessRealm();
  try {
    input.stdio.assertBound(input.computer.files);
  } catch (error) {
    realm.release();
    throw error;
  }
  const lifetime = new AbortController();
  const stdin = new AbortController();
  const output = new AbortController();
  const children = new Set<Promise<void>>();
  const childCleanupErrors: Error[] = [];
  const liveChildren = new Set<NodeChildProcess>();
  let bridge!: NodeBridge;
  let outcome: Outcome | undefined;
  let finish!: (value: Outcome) => void;
  const terminal = new Promise<Outcome>((resolve) => {
    finish = resolve;
  });
  let releaseOmissionFailure: ReleaseModuleOmittedFailure | undefined;
  const releaseReady = Promise.withResolvers<void>();
  void releaseReady.promise.catch(() => undefined);
  const processInput: NodeHarnessProcessInput = {
    ...input,
    reportReleaseModuleOmitted: (event) => {
      const failure = makeReleaseModuleOmittedFailure(event);
      releaseOmissionFailure ??= failure;
      return input.reportReleaseModuleOmitted?.(event, failure);
    },
  };
  const settle = (value: Outcome) => {
    if (outcome !== undefined) return;
    outcome = value;
    finish(value);
  };
  const failed = (error: unknown) => {
    releaseReady.reject(error);
    if (error instanceof NodeProcessExitError) {
      settle({ status: { exitCode: error.code, signal: 0, coreDumped: false } });
    } else if (!lifetime.signal.aborted) settle({ error });
  };
  const onChild: NodeChildProcessObserver = (child, spawn) => {
    liveChildren.add(child);
    const onError = (error: Error) => {
      if (lifetime.signal.aborted) {
        const code = Reflect.get(error, "code");
        if (code !== "ABORT_ERR" && code !== "ECANCELED") childCleanupErrors.push(error);
      } else if (child.listenerCount("error") === 1) failed(error);
    };
    child.on("error", onError);
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => {
        liveChildren.delete(child);
        child.removeListener("error", onError);
        resolve();
      }),
    );
    children.add(closed);
    void closed.then(() => children.delete(closed));
    try {
      input.onChildProcess?.(child, spawn);
    } catch (error) {
      // Admission and cleanup must still run after a diagnostic observer fails.
      childCleanupErrors.push(new Error("Child process observer failed", { cause: error }));
    }
  };
  let runtime: ReturnType<typeof createHarnessRuntime>;
  let personality: ReturnType<typeof installHarnessPersonality>;
  let allocated: ReturnType<typeof createHarnessRuntime> | undefined;
  let runtimeCompatibilityRequired = false;
  let releaseCompatibility: (() => unknown) | undefined;
  let assertInstalledCompatibility: NodeHarnessProcess["assertCompatibility"] = async () => {};
  try {
    runtime = createHarnessRuntime(
      processInput,
      {
        lifetime: lifetime.signal,
        stdin: stdin.signal,
        output: output.signal,
      },
      onChild,
      () => bridge,
    );
    allocated = runtime;
    void runtime.compatibility.failure.catch(failed);
    runtimeCompatibilityRequired =
      input.loadedRelease?.plan.harness === "claude-code" &&
      Object.hasOwn(input.loadedRelease.plan.hostEntrypoints, "signalbox/runtime-compatibility");
    assertInstalledCompatibility = async () => {
      await runtime.compatibility.assert();
      if (releaseCompatibility === undefined) {
        if (runtimeCompatibilityRequired) throw new Error("NODE_RUNTIME_COMPATIBILITY_UNOBSERVED");
        return;
      }
      await Reflect.apply(releaseCompatibility, undefined, []);
    };
    personality = installHarnessPersonality(runtime, processInput, lifetime.signal);
    bridge = personality.bridge;
    realm.commit();
  } catch (error) {
    lifetime.abort(error);
    stdin.abort(error);
    output.abort(error);
    if (allocated)
      for (const stream of Object.values(allocated.streams)) {
        stream.on("error", () => {});
        stream.destroy();
      }
    const exited = (async (): Promise<KernelExitStatus> => {
      try {
        await input.stdio.dispose();
      } finally {
        realm.release();
      }
      throw error;
    })();
    void exited.catch(() => undefined);
    const dispose = async () => {
      await exited;
    };
    return {
      stdin: input.stdio.stdin,
      stdout: input.stdio.stdout,
      stderr: input.stdio.stderr,
      exitStatus: undefined,
      exited,
      assertCompatibility: async () => {
        throw error;
      },
      abort: dispose,
      dispose,
    };
  }
  for (const stream of Object.values(runtime.streams)) stream.on("error", failed);
  const onExit = (exitCode: number) => {
    settle({ status: { exitCode, signal: 0, coreDumped: false } });
  };
  runtime.process.once("exit", onExit);
  const removeProcessListener = runtime.process.removeListener;
  let cliStartupFailureReported = false;
  const onCliStartupFailure = (cause: unknown) => {
    // The CLI captures this callback, so late settlement must not touch a closed owner.
    if (cliStartupFailureReported || lifetime.signal.aborted) return;
    if (cause instanceof NodeProcessExitError) {
      failed(cause);
      return;
    }
    cliStartupFailureReported = true;
    failed(cause);
    try {
      input.reportCliStartupFailure?.(cause);
    } catch (error) {
      childCleanupErrors.push(new Error("CLI startup failure observer failed", { cause: error }));
    }
    force(cause);
  };
  const startupFailureSymbol = Symbol.for(CLAUDE_CLI_STARTUP_FAILURE_REPORTER_KEY);
  Object.defineProperty(runtime.process, startupFailureSymbol, {
    value: onCliStartupFailure,
    configurable: true,
  });
  // Guests may replace process methods, so teardown keeps the remover from before guest code ran.
  let leaveCpu: (() => void) | undefined;
  const start = async () => {
    lifetime.signal.throwIfAborted();
    leaveCpu = runtime.cpu?.enterUser();
    await runtime.environment.load(lifetime.signal);
    lifetime.signal.throwIfAborted();
    const release = await input.loadRelease(bridge, lifetime.signal);
    lifetime.signal.throwIfAborted();
    if (release === null || (typeof release !== "object" && typeof release !== "function")) {
      throw new TypeError("Prepared Node release must export launch()");
    }
    const launch: unknown = Reflect.get(release, "launch");
    if (typeof launch !== "function")
      throw new TypeError("Prepared Node release must export launch()");
    const releaseAssert: unknown = Reflect.get(release, "assertRuntimeCompatibility");
    if (typeof releaseAssert === "function") {
      releaseCompatibility = releaseAssert.bind(release);
    } else if (runtimeCompatibilityRequired) {
      throw new Error("NODE_RUNTIME_COMPATIBILITY_UNOBSERVED");
    }
    releaseReady.resolve();
    try {
      input.onLaunch?.();
    } catch {
      // A passive diagnostic must not prevent the CLI from starting.
    }
    await Reflect.apply(launch, release, []);
  };
  const startup = Promise.resolve()
    .then(() => (runtime.cpu ? runtime.cpu.run(start) : start()))
    .catch(failed);
  let forced = false;
  // Set just before host globals return; guest objects must not be touched after that.
  let restoring = false;
  const force = (reason?: unknown, signal: 9 | 15 = 15) => {
    if (restoring) return;
    forced = true;
    const stopped = reason ?? new DOMException("Node harness aborted", "AbortError");
    releaseReady.reject(stopped);
    settle({ status: { exitCode: 0, signal, coreDumped: false } });
    for (const child of liveChildren) {
      try {
        child.kill(signal);
      } catch (error) {
        childCleanupErrors.push(
          error instanceof Error
            ? error
            : new Error("Harness child cleanup failed.", { cause: error }),
        );
      }
    }
    lifetime.abort(stopped);
    stdin.abort(stopped);
    output.abort(stopped);
    for (const stream of Object.values(runtime.streams)) stream.destroy();
  };
  const externalSignal =
    input.signal === undefined
      ? input.stdio.signal
      : AbortSignal.any([input.signal, input.stdio.signal]);
  const externalAbort = () => force(externalSignal.reason);
  externalSignal.addEventListener("abort", externalAbort, { once: true });
  if (externalSignal.aborted) externalAbort();

  const exited = (async () => {
    const result = await terminal;
    const failures: unknown[] = "error" in result ? [result.error] : [];
    if ("error" in result) force(result.error);
    lifetime.abort(new DOMException("Node harness exited", "AbortError"));
    stdin.abort();
    runtime.streams.stdin.destroy();
    const attempt = async (run: () => void | Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        if (!failures.includes(error)) failures.push(error);
      }
    };
    try {
      await startup;
      while (children.size > 0) await Promise.all(children);
      failures.push(...childCleanupErrors);
      await attempt(() => input.drainChildProcessObservation?.());
      await personality.drain();
      const outputs = [runtime.streams.stdout, runtime.streams.stderr];
      const completed = outputs.map((stream) =>
        NodeStreamPromises.finished(stream, { cleanup: true }),
      );
      for (const stream of outputs) stream.end();
      for (const completion of completed) {
        try {
          await completion;
        } catch (error) {
          if (!forced) failures.push(error);
        }
      }
      await attempt(() =>
        NodeStreamPromises.finished(runtime.streams.stdin, { cleanup: true }).catch(
          () => undefined,
        ),
      );
    } finally {
      await attempt(() => assertInstalledCompatibility());
      externalSignal.removeEventListener("abort", externalAbort);
      output.abort();
      input.stdio.finish();
      await attempt(() => input.stdio.dispose());
      await attempt(() => leaveCpu?.());
      // Detaching can call guest listeners, so it runs while the guest's globals are still installed.
      // Those listeners can defer work (a warning's emit, for one); a host turn lets it run first.
      await attempt(() => {
        removeProcessListener("exit", onExit);
      });
      await attempt(() => {
        Reflect.deleteProperty(runtime.process, startupFailureSymbol);
      });
      for (const stream of Object.values(runtime.streams))
        await attempt(() => {
          stream.removeListener("error", failed);
        });
      await new Promise<void>((resolve) => NodeTimers.setImmediate(resolve));
      restoring = true;
      await attempt(() => personality.restoreGlobals());
      await attempt(() => personality.drainReports());
      try {
        realm.release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Node harness execution or cleanup failed");
    if ("error" in result) throw result.error;
    return releaseOmissionFailure !== undefined && result.status.exitCode === 0
      ? { ...result.status, exitCode: 1 }
      : result.status;
  })();
  void exited.catch(() => undefined);
  const abort = async (reason?: unknown, signal: 9 | 15 = 15) => {
    force(reason, signal);
    await exited;
    await personality.drainReports();
    await assertInstalledCompatibility();
    // A reused process can finish turns before shutdown. Late imports still belong to this
    // realm, so disposal checks their latch without rewriting an already published exit.
    if (releaseOmissionFailure !== undefined) throw releaseOmissionFailure;
  };
  return {
    stdin: input.stdio.stdin,
    stdout: input.stdio.stdout,
    stderr: input.stdio.stderr,
    get exitStatus() {
      return outcome !== undefined && "status" in outcome ? outcome.status : undefined;
    },
    exited,
    assertCompatibility: async () => {
      await releaseReady.promise;
      await assertInstalledCompatibility();
    },
    abort,
    dispose: () => abort(),
  };
}
