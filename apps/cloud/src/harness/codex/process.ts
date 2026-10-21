import { CodexExecHandler } from "../../kernel/CodexExecHandler.ts";
import { CodexExecSessions } from "../../kernel/CodexExecSessions.ts";
import type { KernelHandle } from "../../kernel/KernelAbi.ts";
import type { KernelExitStatus } from "../../kernel/KernelProcessTable.ts";
import { createKernelAsyncWasi, type KernelAsyncWasi } from "../../kernel/KernelWasi.ts";
import type { CodexHarnessProcess, CodexHarnessProcessOptions } from "./types.ts";
import { createCodexImports } from "../CodexImports.ts";
import { createCodexInput, observeCodexReady } from "../CodexTransport.ts";
import type { HarnessProcessStartup } from "../HarnessProcessLifetime.ts";

const activeFilesystems = new WeakSet<object>();

export async function runCodexProcess(
  options: CodexHarnessProcessOptions,
): Promise<CodexHarnessProcess> {
  const files = options.computer.files;
  if (activeFilesystems.has(files)) throw new Error("A Codex process already owns this filesystem");
  const controller = new AbortController();
  const external = AbortSignal.any([options.signal, options.stdio.signal]);
  const signal = AbortSignal.any([external, controller.signal]);
  const readiness = observeCodexReady(options.stdio.stdout, options.bootstrap.host_capabilities);
  activeFilesystems.add(files);
  const failures: unknown[] = [];
  let finishing = false;
  let stopSignal = 15;
  const stop = (reason: unknown) => {
    if (finishing) return;
    readiness.fail(reason);
    controller.abort(reason);
    options.stdio.stopInput(reason);
  };
  const externalAbort = () => stop(external.reason);
  external.addEventListener("abort", externalAbort, { once: true });
  if (external.aborted) externalAbort();
  const sessions = new CodexExecSessions({
    environmentInfo: options.environmentInfo,
    createSession: (context) =>
      new CodexExecHandler({
        filesystem: files,
        spawn: (command, abort) => options.computer.exec(command, abort, undefined),
        notify: context.notify,
        sessionSignal: context.signal,
        baseEnv: options.environment,
        ...(options.environmentInfo.platformOs === undefined
          ? {}
          : { platformOs: options.environmentInfo.platformOs }),
      }),
    onCleanupError: (error) => failures.push(error),
  });
  let input: ReturnType<typeof createCodexInput> | undefined;
  let bootstrapState: "pending" | "written" | "failed" = "pending";
  let wasiState: HarnessProcessStartup["wasi"] = "not-started";
  let nativeExit: KernelExitStatus | undefined;
  const startup = (): HarnessProcessStartup => ({
    bootstrap: input === undefined ? null : { bytes: input.bootstrapBytes, state: bootstrapState },
    wasi: wasiState,
    exit: nativeExit === undefined ? null : { ...nativeExit },
  });
  let completion: Promise<KernelExitStatus> | undefined;
  let handle: KernelHandle<"process"> | undefined;
  try {
    signal.throwIfAborted();
    input = createCodexInput(options, (error) => {
      if (!signal.aborted && !finishing) {
        failures.push(error);
        stop(error);
      }
    });
    void input.bootstrap.then(
      () => {
        bootstrapState = "written";
      },
      () => {
        bootstrapState = "failed";
      },
    );
    const admitted = options.host.processes.spawn(
      undefined,
      (identity) => {
        handle = identity.handle;
        completion = execute(identity.handle);
        return {
          completion,
          signal(number) {
            if (number !== 0 && number !== 9 && number !== 15)
              return {
                status: "error",
                error: { code: "UNSUPPORTED", message: "Unsupported engine signal" },
              };
            if (number !== 0) {
              stopSignal = number;
              stop(new Error(`Codex received signal ${number}`));
            }
            return { status: "ok", value: undefined };
          },
        };
      },
      () => undefined,
    );
    if (admitted.status !== "ok" || completion === undefined)
      throw new Error("Codex process admission failed", { cause: admitted });
  } catch (error) {
    stop(error);
    finishing = true;
    external.removeEventListener("abort", externalAbort);
    await cleanup([
      () => sessions.dispose(),
      () => options.stdio.dispose(),
      () => input?.dispose(),
    ]);
    activeFilesystems.delete(files);
    if (failures.length > 0)
      throw new AggregateError([error, ...failures], "Codex launch failed", { cause: error });
    throw error;
  }
  const exited = completion.then(
    (status) => settle({ status }),
    (error: unknown) => settle({ error }),
  );
  void exited.catch(() => undefined);
  void exited.then((status) => readiness.fail(exitedBeforeReady(status)), readiness.fail);
  let disposal: Promise<void> | undefined;
  const abort = (reason?: unknown) =>
    (disposal ??= (async () => {
      stop(reason ?? new DOMException("Codex session disposed", "AbortError"));
      await exited;
    })());
  return {
    ready: readiness.ready,
    stdin: input.stdin,
    stdout: readiness.stdout,
    stderr: options.stdio.stderr,
    startup,
    exited,
    abort,
    dispose: () => abort(),
  };

  async function settle(
    outcome: { status: KernelExitStatus } | { error: unknown },
  ): Promise<KernelExitStatus> {
    if (handle !== undefined) {
      await options.host.exitStatus(handle);
      const reaped = options.host.reap(handle);
      if ("status" in outcome && reaped.status !== "ok")
        throw new Error("Codex process could not be reaped", { cause: reaped });
    }
    if ("error" in outcome) throw outcome.error;
    return outcome.status;
  }

  async function cleanup(operations: ReadonlyArray<() => unknown | Promise<unknown>>) {
    for (const operation of operations) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
  }

  async function execute(parent: KernelHandle<"process">): Promise<KernelExitStatus> {
    const originalDescriptors = new Map(files.descriptors.entries());
    let binding: KernelAsyncWasi | undefined;
    let imports: Awaited<ReturnType<typeof createCodexImports>> | undefined;
    let running = false;
    let status: KernelExitStatus = { exitCode: 0, signal: 0, coreDumped: false };
    try {
      signal.throwIfAborted();
      binding = createKernelAsyncWasi({
        filesystem: files,
        wakes: options.host.wakes,
        agentOsPreopens: true,
        options: { version: "preview1", args: ["/bin/codex"], env: options.environment },
      });
      let memory: WebAssembly.Memory | undefined;
      imports = await createCodexImports({
        options,
        binding,
        parent,
        sessions,
        signal,
        memory: () => {
          if (memory === undefined) throw new Error("Codex memory is not initialized");
          return memory;
        },
      });
      signal.throwIfAborted();
      const instance = new WebAssembly.Instance(options.engine, imports.imports);
      if (!(instance.exports.memory instanceof WebAssembly.Memory))
        throw new Error("Codex engine does not export its memory");
      memory = instance.exports.memory;
      running = true;
      wasiState = "running";
      const exitCode = await binding.wasi.start(instance, signal);
      status = { exitCode, signal: signal.aborted ? stopSignal : 0, coreDumped: false };
      nativeExit = { ...status };
      wasiState = "returned";
    } catch (error) {
      if (running) wasiState = "failed";
      if (running && signal.aborted && failures.length === 0)
        status = { exitCode: 0, signal: stopSignal, coreDumped: false };
      else {
        failures.push(error);
        readiness.fail(error);
      }
    } finally {
      finishing = true;
      external.removeEventListener("abort", externalAbort);
      controller.abort(new DOMException("Codex engine exited", "AbortError"));
      readiness.fail(exitedBeforeReady(nativeExit));
      options.stdio.stopInput();
      await cleanup([
        () => sessions.dispose(),
        () => imports?.dispose(),
        () => binding?.wasi.close(),
      ]);
      for (const [fd, descriptor] of files.descriptors.entries()) {
        if (originalDescriptors.get(fd) !== descriptor) await cleanup([() => files.close(fd)]);
      }
      await cleanup([
        () => options.stdio.finish(),
        () => options.stdio.dispose(),
        () => input?.dispose(),
      ]);
      activeFilesystems.delete(files);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Codex execution or cleanup failed");
    return status;
  }
}

function exitedBeforeReady(status?: KernelExitStatus) {
  return new Error("Codex exited before signalbox/ready", {
    cause: status === undefined ? undefined : { ...status },
  });
}
