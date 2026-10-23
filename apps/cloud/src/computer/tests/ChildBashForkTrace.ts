import type { KernelBashForkSource } from "../../kernel/KernelBashFork.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelBashOperation } from "../../kernel/KernelBashCheckpoint.ts";

export interface BashPortWithState extends KernelBashPort {
  metadata(): Promise<{ readonly pid: number; readonly residentByteLimit: number }>;
  forkSnapshot(): KernelBashForkSource | undefined;
}

export type BashForkTraceEvent = Record<string, unknown>;
export type BashCapacityMetrics = () => {
  readonly active: number;
  readonly waiting: number;
};

export function traceForkPort<Port extends KernelBashPort>(
  port: Port,
  pid: number,
  trace: BashForkTraceEvent[],
  capacityMetrics: BashCapacityMetrics = () => ({ active: 0, waiting: 0 }),
): Port {
  return new Proxy(port, {
    get(target, property, receiver) {
      if (property === "fork") {
        return async () => {
          const forked = await target.fork();
          trace.push({
            event: "fork",
            pid,
            childPid: forked.kind === "fork" ? forked.pid : undefined,
            errno: forked.kind === "error" ? forked.errno : undefined,
            ...capacityMetrics(),
          });
          if (forked.kind === "error") return forked;
          const childPort = traceForkPort(forked.port, forked.pid, trace, capacityMetrics);
          return new Proxy(forked, {
            get(forkTarget, key, forkReceiver) {
              if (key === "port") return childPort;
              const value = Reflect.get(forkTarget, key, forkReceiver);
              return typeof value === "function" ? value.bind(forkTarget) : value;
            },
          });
        };
      }
      if (property === "wait") {
        return async (childPid: number, flags: number) => {
          const waited = await target.wait(childPid, flags);
          trace.push({ event: "wait", pid, childPid, result: waited });
          return waited;
        };
      }
      if (property === "forkSnapshot") {
        const getSnapshot = Reflect.get(target, property, target);
        if (typeof getSnapshot !== "function") return getSnapshot;
        return async () => {
          const source = await getSnapshot.call(target);
          if (source === undefined) return source;
          return {
            async state() {
              const state = await source.state();
              const pending = state.continuation.pending;
              trace.push({
                event: "restore-state",
                pid,
                memoryBytes: state.memoryBytes,
                stackPointer: state.stackPointer,
                captureTop: state.captures.top,
                resume: state.continuation.resume,
                pending: pending?.kind,
                operationName:
                  pending?.kind === "operation"
                    ? pending.operation.kind === "wasi" || pending.operation.kind === "bash"
                      ? pending.operation.request.name
                      : pending.operation.kind
                    : undefined,
                role: pending?.kind === "fork" ? pending.role : undefined,
                operationId: state.continuation.operationId,
                result: state.continuation.result,
              });
              return state;
            },
            read: (offset: number, length: number) => source.read(offset, length),
            async restored() {
              trace.push({ event: "restored", pid });
              return source.restored();
            },
          };
        };
      }
      if (property === "startOperation" && target.startOperation !== undefined) {
        return async (operation: KernelBashOperation) => {
          if (operation.kind === "wait") {
            trace.push({ event: "wait-operation", pid, childPid: operation.pid });
          } else if (
            (operation.kind === "wasi" || operation.kind === "bash") &&
            ["fd_read", "fd_write"].includes(operation.request.name)
          ) {
            trace.push({
              event: "syscall",
              pid,
              name: operation.request.name,
              args: operation.request.args,
              ...(operation.kind === "wasi"
                ? {
                    transferOffset: operation.request.transferOffset,
                    transferLength: operation.request.transferLength,
                  }
                : {}),
              ...capacityMetrics(),
            });
          }
          const started = await target.startOperation!(operation);
          if (
            started.kind === "pending" &&
            (operation.kind === "wasi" || operation.kind === "bash") &&
            ["fd_read", "fd_write"].includes(operation.request.name)
          ) {
            trace.push({
              event: "operation-pending",
              pid,
              name: operation.request.name,
              args: operation.request.args,
              operationId: started.id,
              ...(operation.kind === "wasi"
                ? {
                    transferOffset: operation.request.transferOffset,
                    transferLength: operation.request.transferLength,
                  }
                : {}),
              ...capacityMetrics(),
            });
          }
          return started;
        };
      }
      if (property === "complete") {
        return async (result: Parameters<KernelBashPort["complete"]>[0]) => {
          trace.push({ event: "complete", pid, result });
          return target.complete(result);
        };
      }
      if (property === "park") {
        const park = target.park;
        if (park === undefined) return undefined;
        return (source: KernelBashForkSource, operationId?: string) => {
          trace.push({ event: "park", pid, operationId });
          return park.call(target, source, operationId);
        };
      }
      if (property === "placeFork") {
        const placeFork = target.placeFork;
        if (placeFork === undefined) return undefined;
        return async (source: KernelBashForkSource) => {
          trace.push({ event: "placeFork", pid, ...capacityMetrics() });
          await placeFork.call(target, source);
          trace.push({ event: "placeFork-return", pid, ...capacityMetrics() });
        };
      }
      if (property === "runFork") {
        return (source: KernelBashForkSource) => {
          trace.push({ event: "runFork", pid });
          return target.runFork(source);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
