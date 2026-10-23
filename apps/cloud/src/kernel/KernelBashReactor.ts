import type { KernelBashCredentials } from "./KernelBashProgram.ts";
import type { KernelBashPort } from "./KernelBashPort.ts";
import type { KernelExitStatus } from "./KernelProcessTable.ts";
import { KernelProcessSignal } from "./KernelProcessSignal.ts";
import { createBashInstance } from "./bash/BashInstance.ts";
import { createBashEnvironment } from "./bash/BashEnvironment.ts";
import { errno, range } from "./bash/BashMemory.ts";
import type { KernelBashForkSource } from "./KernelBashFork.ts";
import { createBashForkSnapshot, restoreBashFork } from "./bash/BashForkSnapshot.ts";
import {
  bashTransitionImports,
  rewindBash,
  type BashContinuation,
} from "./bash/BashTransitions.ts";

export interface KernelBashReactorBinding {
  readonly imports: WebAssembly.Imports;
  bind(instance: WebAssembly.Instance): void;
  /** `_start` returns void; a numeric result denotes WASI proc_exit. */
  run(start: WebAssembly.ExportValue): Promise<unknown>;
}

export interface KernelBashReactorOptions {
  readonly module: WebAssembly.Module;
  readonly residentWasmBudgetBytes: number;
  readonly credentials: KernelBashCredentials;
  readonly pid: number;
  readonly port: KernelBashPort;
  readonly createBinding: (
    port: KernelBashPort,
    residentWasmBytes: () => number,
  ) => KernelBashReactorBinding;
  readonly snapshot?: KernelBashForkSource | undefined;
  readonly createForkSource?: (source: KernelBashForkSource) => KernelBashForkSource;
}

const status = (exitCode: number): KernelExitStatus => ({ exitCode, signal: 0, coreDumped: false });

/** Owns only guest continuations and heaps. Process resources remain behind the supplied ports. */
export function createKernelBashReactor(options: KernelBashReactorOptions) {
  const children = new Set<Promise<void>>();
  const resident = new Set<WebAssembly.Memory>();
  let peakResidentWasmBytes = 0;
  let root: Promise<KernelExitStatus> | undefined;

  const residentWasmBytes = () => {
    let bytes = 0;
    for (const memory of resident) bytes += memory.buffer.byteLength;
    peakResidentWasmBytes = Math.max(peakResidentWasmBytes, bytes);
    return bytes;
  };

  function create(pid: number, port: KernelBashPort) {
    const binding = options.createBinding(port, residentWasmBytes);
    // Instance construction needs these closures before exports exist. They run only after binding.
    const process = {
      stats: { mainHi: 0, captureBytesHi: 0, captureCompactions: 0, captureLiveHi: 0 },
      rewinding: false,
      resume: 0,
      pending: undefined,
    } as BashContinuation;
    const memory = () => process.exports.memory;
    const imports: WebAssembly.Imports = {
      ...binding.imports,
      env: {
        ...createBashEnvironment({
          memory,
          credentials: { ...options.credentials },
          pid: () => pid,
        }),
        ...binding.imports.env,
      },
      nimbus_proc: {
        ...binding.imports.nimbus_proc,
        ...bashTransitionImports(process, pid),
      },
      nimbus_procenv: { full: () => process.captures.applyLog(memory()) },
    };
    const created = createBashInstance(options.module, imports);
    Object.assign(process, created);
    resident.add(created.exports.memory);
    residentWasmBytes();
    binding.bind(created.instance);
    return { process, binding, pid, port };
  }

  type Process = ReturnType<typeof create>;

  async function execute(current: Process): Promise<KernelExitStatus> {
    const { process, binding, pid, port } = current;
    const ex = process.exports;
    for (;;) {
      const result = await binding.run(ex._start);
      await port.observeResident?.(residentWasmBytes());
      if (typeof result === "number") return status(result);
      const pending = process.pending;
      process.pending = undefined;
      if (pending === undefined) {
        if (process.rewinding)
          throw new Error("GNU Bash returned before landing its Asyncify continuation");
        return status(0);
      }
      ex.asyncify_stop_unwind();
      switch (pending.kind) {
        case "capture":
          rewindBash(
            process,
            process.captures.take(ex.memory, pending.env, pending.stack, process.stats, pid),
          );
          break;
        case "longjmp": {
          const target = process.captures.jump(ex.memory, pending.env, pending.value, pid);
          ex.__stack_pointer.value = target.sp;
          rewindBash(process, target.at);
          break;
        }
        case "fork": {
          const forked = await port.fork();
          if (forked.kind === "error") process.resume = -forked.errno;
          else {
            let disposed = false;
            const dispose = () => {
              if (disposed) return;
              disposed = true;
              disposeFork(forked);
            };
            try {
              if (
                residentWasmBytes() + ex.memory.buffer.byteLength >
                options.residentWasmBudgetBytes
              ) {
                process.resume = await runRemoteFork(current, forked, dispose);
                rewindBash(process);
                break;
              }
              const child = create(forked.pid, forked.port);
              const source = ex.memory;
              const target = child.process.exports.memory;
              if (target.buffer.byteLength < source.buffer.byteLength)
                target.grow((source.buffer.byteLength - target.buffer.byteLength) / 65_536);
              new Uint8Array(target.buffer).set(new Uint8Array(source.buffer));
              child.process.exports.__stack_pointer.value = ex.__stack_pointer.value;
              child.process.captures = process.captures.fork();
              rewindBash(child.process);
              // The port records failure for waitpid; a fork cannot replace the root's exit result.
              const completion = Promise.resolve()
                .then(() => run(child))
                .finally(dispose)
                .then(
                  () => {},
                  () => {},
                );
              children.add(completion);
              void completion.then(() => children.delete(completion));
              process.resume = forked.pid;
            } catch (error) {
              try {
                await forked.port.complete({ kind: "failure", message: String(error) });
              } finally {
                dispose();
              }
              throw error;
            }
          }
          rewindBash(process);
          break;
        }
        case "wait": {
          const waited = await port.wait(pending.pid, pending.options);
          process.resume = waited.kind === "error" ? -waited.errno : waited.pid;
          if (waited.kind === "wait" && waited.status !== undefined && pending.status !== 0) {
            const child = waited.status;
            const raw =
              child.signal === 0
                ? (child.exitCode & 255) << 8
                : (child.signal & 127) | (child.coreDumped ? 128 : 0);
            const bytes = range(ex.memory, pending.status, 4);
            new DataView(bytes.buffer, bytes.byteOffset, 4).setInt32(0, raw, true);
          }
          rewindBash(process);
          break;
        }
        case "exec": {
          const replacement = await port.exec({
            path: pending.path,
            args: pending.args,
            env: pending.env,
          });
          if (replacement.kind === "exit") return replacement.status;
          process.resume = -replacement.errno;
          rewindBash(process);
        }
      }
    }
  }

  async function runRemoteFork(
    current: Process,
    forked: Extract<Awaited<ReturnType<KernelBashPort["fork"]>>, { kind: "fork" }>,
    dispose: () => void,
  ) {
    const snapshot = createBashForkSnapshot(current.process);
    const source = options.createForkSource?.(snapshot.source) ?? snapshot.source;
    const remote = Promise.resolve().then(() => forked.port.runFork(source));
    const copied = remote.then(() => {
      throw new Error("Bash fork worker stopped before restoring its snapshot");
    });
    const completion = remote.finally(dispose).then(
      () => {},
      () => {},
    );
    children.add(completion);
    void completion.then(() => children.delete(completion));
    try {
      // Returning from fork lets the parent mutate memory. Wait only for restoration.
      await Promise.race([snapshot.copied, copied]);
      return forked.pid;
    } catch (error) {
      snapshot.discard();
      // runFork owns completion. A child that never restored is not a successful fork.
      await current.port.wait(forked.pid, 0);
      return -errno(error);
    }
  }

  async function run(current: Process): Promise<KernelExitStatus> {
    try {
      return await runProcess(current);
    } finally {
      resident.delete(current.process.exports.memory);
    }
  }

  async function runProcess(current: Process): Promise<KernelExitStatus> {
    let result: KernelExitStatus;
    try {
      result = await execute(current);
    } catch (error) {
      if (error instanceof KernelProcessSignal) result = error.exitStatus;
      else {
        await current.port.complete({ kind: "failure", message: String(error) });
        throw error;
      }
    }
    await current.port.complete({ kind: "exit", status: result });
    return result;
  }

  return {
    get peakResidentWasmBytes() {
      residentWasmBytes();
      return peakResidentWasmBytes;
    },
    async run(): Promise<KernelExitStatus> {
      if (root !== undefined) throw new Error("GNU Bash reactor has already started");
      root = Promise.resolve().then(async () => {
        const current = create(options.pid, options.port);
        if (options.snapshot !== undefined) {
          try {
            await restoreBashFork(current.process, options.snapshot);
            residentWasmBytes();
            rewindBash(current.process);
            await options.snapshot.restored();
          } catch (error) {
            await current.port.complete({ kind: "failure", message: String(error) });
            resident.delete(current.process.exports.memory);
            throw error;
          }
        }
        return run(current);
      });
      void root.catch(() => {});
      return root;
    },
    /** Keep the worker request open through this drain even when its root has already exited. */
    async drain(): Promise<void> {
      if (root === undefined) throw new Error("GNU Bash reactor has not started");
      await root.catch(() => {});
      while (children.size > 0) await Promise.all(children);
    },
  };
}

// RPC fork results own their returned port stubs; same-isolate results have no disposer.
function disposeFork(result: object): void {
  if (!(Symbol.dispose in result)) return;
  const dispose = result[Symbol.dispose];
  if (typeof dispose === "function") dispose.call(result);
}
