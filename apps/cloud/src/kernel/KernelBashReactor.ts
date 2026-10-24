import type { KernelBashCredentials } from "./KernelBashProgram.ts";
import type { KernelBashPort } from "./KernelBashPort.ts";
import type { KernelExitStatus } from "./KernelProcessTable.ts";
import { KernelProcessSignal } from "./KernelProcessSignal.ts";
import { copyKernelRpcRecord, disposeKernelRpcReply } from "./KernelRpcReply.ts";
import { createBashInstance } from "./bash/BashInstance.ts";
import { createBashEnvironment } from "./bash/BashEnvironment.ts";
import { errno, range } from "./bash/BashMemory.ts";
import type { KernelBashForkSource } from "./KernelBashFork.ts";
import {
  type KernelBashCheckpointContinuation,
  type KernelBashImportCall,
  type KernelBashOperation,
  type KernelBashOperationEffect,
  type KernelBashOperationResult,
  type KernelBashOperationStart,
} from "./KernelBashCheckpoint.ts";
import { createBashForkSnapshot, restoreBashFork } from "./bash/BashForkSnapshot.ts";
import {
  bashTransitionImports,
  createBashAsyncifyOperationHooks,
  rewindBash,
  type BashAsyncifyOperationHooks,
  type BashContinuation,
} from "./bash/BashTransitions.ts";

const MIB = 1024 * 1024;
const DEFAULT_LOCAL_FORK_PACKING_BYTES = 64 * MIB;
const PAGE_BYTES = 65_536;

class BashForkStartError extends Error {
  readonly errno: number;

  constructor(errno: number, cause: unknown) {
    super("Bash fork worker stopped before restoring its snapshot", { cause });
    this.errno = errno;
  }
}

export interface KernelBashReactorBinding {
  readonly imports: WebAssembly.Imports;
  bind(instance: WebAssembly.Instance): void;
  /** `_start` returns void; a numeric result denotes WASI proc_exit. */
  run(start: WebAssembly.ExportValue): Promise<unknown>;
  /** Apply a saved WASI or Nimbus result to its ABI ranges before Asyncify rewinds. */
  applyOperation?(
    operation: KernelBashOperation,
    call: KernelBashImportCall,
    result: KernelBashOperationResult,
  ): KernelBashOperationEffect;
}

export interface KernelBashReactorOptions {
  readonly module: WebAssembly.Module;
  /** Maximum tracked Bash linear memory assigned to one loader slot. */
  readonly residentWasmBudgetBytes: number;
  /** Local fork packing threshold; separate from a slot's placement budget. */
  readonly localForkPackingBytes?: number;
  readonly credentials: KernelBashCredentials;
  readonly pid: number;
  readonly port: KernelBashPort;
  readonly createBinding: (
    port: KernelBashPort,
    asyncify: BashAsyncifyOperationHooks,
    residentWasmBytes: () => number,
  ) => KernelBashReactorBinding;
  readonly snapshot?: KernelBashForkSource | undefined;
  readonly createForkSource?: (
    source: KernelBashForkSource,
  ) => KernelBashForkSource | Promise<KernelBashForkSource>;
}

const status = (exitCode: number): KernelExitStatus => ({ exitCode, signal: 0, coreDumped: false });

/** Owns guest continuations and heaps; host operations remain behind the supplied process ports. */
export function createKernelBashReactor(options: KernelBashReactorOptions) {
  const children = new Set<Promise<void>>();
  const resident = new Set<WebAssembly.Memory>();
  const guestRuns = new BashGuestRunGate();
  const localForkPackingBytes = options.localForkPackingBytes ?? DEFAULT_LOCAL_FORK_PACKING_BYTES;
  const slotWasmBudgetBytes = options.residentWasmBudgetBytes;
  let peakObservedResidentWasmBytes = 0;
  let peakPostEnforcementResidentWasmBytes = 0;
  let root: Promise<KernelExitStatus> | undefined;

  const residentWasmBytes = () => {
    let bytes = 0;
    for (const memory of resident) bytes += memory.buffer.byteLength;
    return bytes;
  };

  async function observeResident(current: Process): Promise<number> {
    const bytes = residentWasmBytes();
    peakObservedResidentWasmBytes = Math.max(peakObservedResidentWasmBytes, bytes);
    await current.port.observeResident?.(bytes);
    return bytes;
  }

  function recordResidentAfterPlacement(current: Process): void {
    const localBytes = residentWasmBytes();
    const parkedBytes = current.process.exports.memory.buffer.byteLength;
    peakPostEnforcementResidentWasmBytes = Math.max(
      peakPostEnforcementResidentWasmBytes,
      Math.max(0, localBytes - parkedBytes),
    );
  }

  function create(pid: number, port: KernelBashPort) {
    // Imports close over this object before exports exist; Asyncify calls run only after bind.
    const process = {
      stats: { mainHi: 0, captureBytesHi: 0, captureCompactions: 0, captureLiveHi: 0 },
      rewinding: false,
      resume: 0,
      pending: undefined,
      parked: false,
    } as BashContinuation;
    const asyncify = createBashAsyncifyOperationHooks(process, pid);
    const binding = options.createBinding(port, asyncify, residentWasmBytes);
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
        ...bashTransitionImports(process, pid, asyncify),
      },
      nimbus_procenv: { full: () => process.captures.applyLog(memory()) },
    };
    const created = createBashInstance(options.module, imports);
    Object.assign(process, created);
    resident.add(created.exports.memory);
    binding.bind(created.instance);
    return { process, binding, pid, port, placed: false };
  }

  type Process = ReturnType<typeof create>;

  async function createInitialProcess(): Promise<Process> {
    let current: Process | undefined;
    try {
      current = create(options.pid, options.port);
      if (options.snapshot !== undefined) {
        current.process.checkpoint = await restoreBashFork(current.process, options.snapshot);
        current.placed = true;
        await options.snapshot.restored();
      }
      return current;
    } catch (error) {
      if (current !== undefined) {
        await current.port.complete({ kind: "failure", message: String(error) });
        resident.delete(current.process.exports.memory);
      }
      throw error;
    } finally {
      if (options.snapshot !== undefined) disposeFork(options.snapshot);
    }
  }

  async function execute(current: Process): Promise<KernelExitStatus> {
    const { process, binding, pid, port } = current;
    const ex = process.exports;
    if (process.checkpoint !== undefined) {
      const checkpoint = process.checkpoint;
      delete process.checkpoint;
      process.resume = checkpoint.resume;
      const pending = checkpoint.pending;
      if (pending?.kind === "fork") {
        if (pending.role === "parent") {
          process.pending = { kind: "fork" };
          const parked = await resumeFork(current, await observeResident(current));
          if (parked) return status(0);
        } else {
          process.pending = undefined;
          rewindBash(process);
        }
      } else if (pending?.kind === "operation") {
        const transition = {
          kind: "operation" as const,
          operation: pending.operation,
          call: pending.call,
        };
        process.pending = transition;
        const outcome = await executeOperation(
          current,
          transition,
          checkpoint.result,
          checkpoint.operationId,
        );
        if (outcome !== undefined) return outcome;
      } else {
        rewindBash(process);
      }
    }

    for (;;) {
      const result = await guestRuns.run(() => binding.run(ex._start));
      const aggregateBytes = await observeResident(current);
      if (typeof result === "number") return status(result);
      const pending = process.pending;
      if (pending === undefined) {
        if (process.rewinding)
          throw new Error("GNU Bash returned before landing its Asyncify continuation");
        return status(0);
      }
      ex.asyncify_stop_unwind();
      switch (pending.kind) {
        case "capture":
          process.pending = undefined;
          rewindBash(
            process,
            process.captures.take(ex.memory, pending.env, pending.stack, process.stats, pid),
          );
          break;
        case "longjmp": {
          process.pending = undefined;
          const target = process.captures.jump(ex.memory, pending.env, pending.value, pid);
          ex.__stack_pointer.value = target.sp;
          rewindBash(process, target.at);
          break;
        }
        case "fork":
          if (await resumeFork(current, aggregateBytes)) return status(0);
          break;
        case "operation": {
          const outcome = await executeOperation(current, pending);
          if (outcome !== undefined) return outcome;
          break;
        }
        case "wait": {
          const waited = copyKernelRpcRecord(await port.wait(pending.pid, pending.options));
          process.resume = waited.kind === "error" ? -waited.errno : waited.pid;
          if (waited.kind === "wait" && waited.status !== undefined && pending.status !== 0) {
            const raw = waitStatus(waited.status);
            const bytes = range(ex.memory, pending.status, 4);
            new DataView(bytes.buffer, bytes.byteOffset, 4).setInt32(0, raw, true);
          }
          process.pending = undefined;
          rewindBash(process);
          break;
        }
        case "exec": {
          const replacement = copyKernelRpcRecord(
            await port.exec({
              path: pending.path,
              args: pending.args,
              env: pending.env,
            }),
          );
          if (replacement.kind === "exit") return replacement.status;
          process.resume = -replacement.errno;
          process.pending = undefined;
          rewindBash(process);
          break;
        }
      }
    }
  }

  async function executeOperation(
    current: Process,
    pending: Extract<NonNullable<BashContinuation["pending"]>, { kind: "operation" }>,
    restoredResult?: KernelBashOperationResult,
    restoredOperationId?: string,
  ): Promise<KernelExitStatus | undefined> {
    let operation = pending.operation;
    let result = restoredResult;
    let operationId = restoredOperationId;
    for (;;) {
      const observed = await observeResident(current);
      const moved = await parkAtBoundary(
        current,
        {
          resume: current.process.resume,
          pending: { kind: "operation", operation, call: pending.call },
          ...(result === undefined ? {} : { result }),
          ...(operationId === undefined ? {} : { operationId }),
        },
        observed,
      );
      if (moved) return status(0);

      if (result === undefined) {
        if (operationId !== undefined)
          throw new Error("A parked Bash operation resumed without its stored result");
        const started = await startOperation(current.port, operation);
        if (started.kind === "pending") {
          if (current.port.park === undefined)
            throw new Error(
              "Bash port returned a pending operation without checkpoint park support",
            );
          const continuation: KernelBashCheckpointContinuation = {
            resume: current.process.resume,
            pending: {
              kind: "operation",
              operation,
              call: pending.call,
            },
            operationId: started.id,
          };
          const snapshot = createBashForkSnapshot(current.process, continuation);
          await guestRuns.freeze(async () => {
            await observeResident(current);
            await current.port.park!(await forkSource(snapshot.source), started.id);
          });
          recordResidentAfterPlacement(current);
          current.process.parked = true;
          return status(0);
        }
        result = started.result;
      }

      const effect = applyOperation(current, operation, pending.call, result);
      if (effect.kind === "exit") {
        current.process.pending = undefined;
        return effect.status;
      }
      if (effect.kind === "continue") {
        operation = effect.operation;
        result = undefined;
        operationId = undefined;
        continue;
      }
      current.process.resume = effect.value;
      current.process.pending = undefined;
      rewindBash(current.process);
      return undefined;
    }
  }

  /** Execute a fork transition once, placing either the current parent or its child as needed. */
  async function resumeFork(current: Process, observedBytes: number): Promise<boolean> {
    const process = current.process;
    const parked = await parkAtBoundary(
      current,
      { resume: process.resume, pending: forkCheckpoint("parent") },
      observedBytes,
    );
    if (parked) return true;
    await observeResident(current);
    const forked = await current.port.fork();
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      disposeFork(forked);
    };
    try {
      if (forked.kind === "error") {
        try {
          process.resume = -forked.errno;
          process.pending = undefined;
          rewindBash(process);
          return false;
        } finally {
          dispose();
        }
      }
    } catch (error) {
      dispose();
      throw error;
    }
    try {
      const projectedLocalBytes = residentWasmBytes() + process.exports.memory.buffer.byteLength;
      if (
        projectedLocalBytes > localForkPackingBytes ||
        projectedLocalBytes > slotWasmBudgetBytes
      ) {
        const continuation: KernelBashCheckpointContinuation = {
          resume: 0,
          pending: forkCheckpoint("child"),
        };
        const snapshot = createBashForkSnapshot(process, continuation);
        if (forked.port.placeFork !== undefined) {
          await guestRuns.freeze(async () => {
            await observeResident(current);
            await forked.port.placeFork!(await forkSource(snapshot.source));
          });
          dispose();
        } else {
          await runRemoteFork(current, forked, dispose, continuation);
        }
      } else {
        const child = create(forked.pid, forked.port);
        const source = process.exports.memory;
        const target = child.process.exports.memory;
        if (target.buffer.byteLength < source.buffer.byteLength)
          target.grow((source.buffer.byteLength - target.buffer.byteLength) / PAGE_BYTES);
        new Uint8Array(target.buffer).set(new Uint8Array(source.buffer));
        child.process.exports.__stack_pointer.value = process.exports.__stack_pointer.value;
        child.process.captures = process.captures.fork();
        rewindBash(child.process);
        const completion = Promise.resolve()
          .then(() => run(child))
          .finally(dispose)
          .then(
            () => {},
            () => {},
          );
        children.add(completion);
        void completion.then(() => children.delete(completion));
      }
      process.resume = forked.pid;
      process.pending = undefined;
      rewindBash(process);
      return false;
    } catch (error) {
      if (error instanceof BashForkStartError) {
        process.resume = -error.errno;
        process.pending = undefined;
        dispose();
        rewindBash(process);
        return false;
      }
      try {
        await forked.port.complete({ kind: "failure", message: String(error) });
      } finally {
        dispose();
      }
      throw error;
    }
  }

  async function parkAtBoundary(
    current: Process,
    continuation: KernelBashCheckpointContinuation,
    observedBytes: number,
  ): Promise<boolean> {
    const processBytes = current.process.exports.memory.buffer.byteLength;
    const mustPark = processBytes > slotWasmBudgetBytes;
    if (!mustPark && (current.placed || observedBytes <= localForkPackingBytes)) return false;
    const canMove = processBytes <= slotWasmBudgetBytes && current.port.park !== undefined;
    if (!canMove && !mustPark) return false;
    if (mustPark && current.port.park === undefined) return false;
    if (current.port.park === undefined) return false;
    const snapshot = createBashForkSnapshot(current.process, continuation);
    await guestRuns.freeze(async () => {
      await observeResident(current);
      await current.port.park!(await forkSource(snapshot.source));
    });
    recordResidentAfterPlacement(current);
    current.process.parked = true;
    return true;
  }

  function applyOperation(
    current: Process,
    operation: KernelBashOperation,
    call: KernelBashImportCall,
    result: KernelBashOperationResult,
  ): KernelBashOperationEffect {
    switch (result.kind) {
      case "wasi":
        if (operation.kind !== "wasi")
          throw new TypeError(`Bash ${operation.kind} operation received ${result.kind} result`);
        if (current.binding.applyOperation === undefined)
          throw new Error("Bash binding cannot apply a restored syscall result");
        return current.binding.applyOperation(operation, call, result);
      case "bash":
        if (operation.kind !== "bash")
          throw new TypeError(`Bash ${operation.kind} operation received ${result.kind} result`);
        if (current.binding.applyOperation === undefined)
          throw new Error("Bash binding cannot apply a restored syscall result");
        return current.binding.applyOperation(operation, call, result);
      case "wait": {
        if (operation.kind !== "wait")
          throw new TypeError(`Bash ${operation.kind} operation received ${result.kind} result`);
        const waited = result.value;
        if (waited.kind === "error") return { kind: "resume", value: -waited.errno };
        if (waited.status !== undefined) {
          const statusPointer = Number(call.args[1] ?? 0);
          if (statusPointer !== 0) {
            const bytes = range(current.process.exports.memory, statusPointer, 4);
            new DataView(bytes.buffer, bytes.byteOffset, 4).setInt32(
              0,
              waitStatus(waited.status),
              true,
            );
          }
        }
        return { kind: "resume", value: waited.pid };
      }
      case "exec":
        if (operation.kind !== "exec")
          throw new TypeError(`Bash ${operation.kind} operation received ${result.kind} result`);
        return result.value.kind === "error"
          ? { kind: "resume", value: -result.value.errno }
          : { kind: "exit", status: result.value.status };
    }
  }

  async function startOperation(
    port: KernelBashPort,
    operation: KernelBashOperation,
  ): Promise<KernelBashOperationStart> {
    if (port.startOperation !== undefined)
      return copyKernelRpcRecord(await port.startOperation(operation));
    switch (operation.kind) {
      case "wasi":
        return {
          kind: "ready",
          result: { kind: "wasi", value: copyKernelRpcRecord(await port.call(operation.request)) },
        };
      case "bash":
        return {
          kind: "ready",
          result: {
            kind: "bash",
            value: copyKernelRpcRecord(await port.callBash(operation.request)),
          },
        };
      case "wait":
        return {
          kind: "ready",
          result: {
            kind: "wait",
            value: copyKernelRpcRecord(await port.wait(operation.pid, operation.options)),
          },
        };
      case "exec":
        return {
          kind: "ready",
          result: { kind: "exec", value: copyKernelRpcRecord(await port.exec(operation.request)) },
        };
    }
  }

  async function runRemoteFork(
    current: Process,
    forked: Extract<Awaited<ReturnType<KernelBashPort["fork"]>>, { kind: "fork" }>,
    dispose: () => void,
    continuation: KernelBashCheckpointContinuation,
  ) {
    const snapshot = createBashForkSnapshot(current.process, continuation);
    const source = await forkSource(snapshot.source);
    const remote = Promise.resolve()
      .then(() => forked.port.runFork(source))
      .then(copyKernelRpcRecord);
    const completion = remote.finally(dispose).then(
      () => {},
      () => {},
    );
    children.add(completion);
    void completion.then(() => children.delete(completion));
    const outcome = await Promise.race([
      snapshot.copied.then(() => ({ kind: "copied" as const })),
      remote.then(
        (status) => ({ kind: "exit" as const, status }),
        (error: unknown) => ({ kind: "failure" as const, error }),
      ),
    ]);
    if (outcome.kind === "copied") return;
    snapshot.discard();
    if (outcome.kind === "exit" && outcome.status.signal !== 0) return;

    const failure =
      outcome.kind === "failure"
        ? outcome.error
        : Object.assign(new Error("Bash fork worker exited before restoring its snapshot"), {
            code: "EIO",
          });
    try {
      disposeKernelRpcReply(await current.port.wait(forked.pid, 0));
    } catch {
      // The remote completion is already observed; wait only removes its process-table entry.
    }
    throw new BashForkStartError(errno(failure), failure);
  }

  async function forkSource(source: KernelBashForkSource): Promise<KernelBashForkSource> {
    return (await options.createForkSource?.(source)) ?? source;
  }

  async function run(current: Process): Promise<KernelExitStatus> {
    try {
      return await runProcess(current);
    } finally {
      resident.delete(current.process.exports.memory);
      peakPostEnforcementResidentWasmBytes = Math.max(
        peakPostEnforcementResidentWasmBytes,
        residentWasmBytes(),
      );
    }
  }

  async function runProcess(current: Process): Promise<KernelExitStatus> {
    try {
      let result: KernelExitStatus;
      try {
        result = await execute(current);
      } catch (error) {
        if (error instanceof KernelProcessSignal) result = error.exitStatus;
        else {
          if (!current.process.parked)
            await current.port.complete({
              kind: "failure",
              message: error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
          throw error;
        }
      }
      if (!current.process.parked) await current.port.complete({ kind: "exit", status: result });
      return result;
    } finally {
      resident.delete(current.process.exports.memory);
    }
  }

  return {
    get peakResidentWasmBytes() {
      return Math.max(peakObservedResidentWasmBytes, residentWasmBytes());
    },
    get peakObservedResidentWasmBytes() {
      return Math.max(peakObservedResidentWasmBytes, residentWasmBytes());
    },
    get peakPostEnforcementResidentWasmBytes() {
      return peakPostEnforcementResidentWasmBytes;
    },
    async run(): Promise<KernelExitStatus> {
      if (root !== undefined) throw new Error("GNU Bash reactor has already started");
      root = Promise.resolve().then(async () => {
        const current = await createInitialProcess();
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

function forkCheckpoint(
  role: "parent" | "child",
): Extract<NonNullable<KernelBashCheckpointContinuation["pending"]>, { readonly kind: "fork" }> {
  return {
    kind: "fork",
    role,
    call: { namespace: "nimbus_proc", name: "fork", args: [] },
  };
}

function waitStatus(child: KernelExitStatus): number {
  return child.signal === 0
    ? (child.exitCode & 255) << 8
    : (child.signal & 127) | (child.coreDumped ? 128 : 0);
}

class BashGuestRunGate {
  #active = 0;
  #frozen = false;
  #waiters: (() => void)[] = [];
  #idle = new Set<() => void>();
  #freezeTail = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    while (this.#frozen) await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#active++;
    try {
      return await work();
    } finally {
      this.#active--;
      if (this.#active === 0) {
        for (const resolve of this.#idle) resolve();
        this.#idle.clear();
      }
    }
  }

  freeze<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#freezeTail.then(async () => {
      this.#frozen = true;
      if (this.#active > 0) await new Promise<void>((resolve) => this.#idle.add(resolve));
      try {
        return await work();
      } finally {
        this.#frozen = false;
        for (const resolve of this.#waiters.splice(0)) resolve();
      }
    });
    this.#freezeTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

// RPC fork results own their returned port stubs; same-isolate results have no disposer.
function disposeFork(result: object): void {
  disposeKernelRpcReply(result);
}
