// @effect-diagnostics nodeBuiltinImport:off - correlate asynchronous test observations without changing the guest's waits.
import * as NodeAsyncHooks from "node:async_hooks";
import { onTestFinished, vi } from "vite-plus/test";
import { BashWorkerPhase } from "../BashWorkerPhase.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { createBashGateway } from "./ChildBashGatewayFixture.ts";
import { traceReaderWakes } from "./BashReaderWakeTrace.ts";

type Details = Record<string, unknown>;
type Operation = Details & { key: number; port: number; pendingId?: string };

function readerTrace(gateway: ReturnType<typeof createBashGateway>) {
  const context = new NodeAsyncHooks.AsyncLocalStorage<Operation>();
  const ports = new Map<KernelBashPort, number>();
  const portPids = new Map<number, number>();
  const processes = new Set<number>();
  const operations = new Map<number, Operation>();
  const pendingIds = new Map<string, Operation>();
  const recent: Details[] = [];
  const restores: (() => void)[] = [];
  const started = performance.now();
  let sequence = 0;
  let nextOperation = 0;
  const record = (event: string, details: Details = {}) => {
    recent.push({
      sequence: ++sequence,
      elapsedMs: performance.now() - started,
      event,
      operation: context.getStore()?.key,
      ...details,
    });
    if (recent.length > 256) recent.shift();
    return sequence;
  };
  const observe = <T>(promise: Promise<T>, port: number) => {
    const operation = context.getStore();
    void promise.then(
      () => {
        const settled = record("operation-settled", { port, operation: operation?.key });
        if (operation !== undefined) operation.settled = settled;
      },
      (error: unknown) =>
        record("operation-rejected", { port, operation: operation?.key, error: String(error) }),
    );
    return promise;
  };
  const portId = (port: KernelBashPort) => {
    const existing = ports.get(port);
    if (existing !== undefined) return existing;
    const id = ports.size + 1;
    ports.set(port, id);
    const call = port.call.bind(port);
    const callBash = port.callBash.bind(port);
    const wait = port.wait.bind(port);
    const exec = port.exec.bind(port);
    const spies = [
      vi.spyOn(port, "call").mockImplementation((request) => observe(call(request), id)),
      vi.spyOn(port, "callBash").mockImplementation((request) => observe(callBash(request), id)),
      vi.spyOn(port, "wait").mockImplementation((pid, flags) => observe(wait(pid, flags), id)),
      vi.spyOn(port, "exec").mockImplementation((request) => observe(exec(request), id)),
    ];
    restores.push(() => spies.forEach((spy) => spy.mockRestore()));
    return id;
  };
  const startOperation = BashWorkerPhase.prototype.startOperation;
  const startSpy = vi
    .spyOn(BashWorkerPhase.prototype, "startOperation")
    .mockImplementation(function (this: BashWorkerPhase, port, operation) {
      const id = portId(port);
      const previous = operations.get(id);
      if (previous?.pendingId !== undefined) pendingIds.delete(previous.pendingId);
      const current: Operation = {
        key: ++nextOperation,
        port: id,
        kind: operation.kind,
        ...(operation.kind === "wasi" || operation.kind === "bash"
          ? { name: operation.request.name, args: operation.request.args }
          : {}),
        ...(operation.kind === "wait" ? { selector: operation.pid, flags: operation.options } : {}),
      };
      operations.set(id, current);
      return context.run(current, () => {
        current.started = record("operation-start", current);
        const pending = startOperation.call(this, port, operation);
        void pending.then(
          (result) => {
            current.startReturned = record("operation-start-return", {
              result: result.kind,
              pendingId: result.kind === "pending" ? result.id : undefined,
            });
            if (result.kind === "pending") {
              current.pendingId = result.id;
              pendingIds.set(result.id, current);
            }
          },
          (error: unknown) => record("operation-start-rejected", { error: String(error) }),
        );
        return pending;
      });
    });
  const park = BashWorkerPhase.prototype.park;
  const parkSpy = vi.spyOn(BashWorkerPhase.prototype, "park").mockImplementation(function (
    this: BashWorkerPhase,
    port,
    pid,
    source,
    operationId,
  ) {
    portPids.set(portId(port), pid);
    record("checkpoint-park", { pid, operationId });
    return park.call(this, port, pid, source, operationId);
  });
  const table = gateway.fixture.context.processes;
  const originalWaitpid = table.waitpid;
  const waitpid = originalWaitpid.bind(table);
  // Vitest reuses an existing spy on this method, so wrapping it with spyOn would recurse.
  table.waitpid = (parent, selector, flags) => {
    const parentInfo = table.info(parent);
    const result = waitpid(parent, selector, flags);
    record("waitpid", {
      parentPid: parentInfo.status === "ok" ? parentInfo.value.pid : undefined,
      selector,
      flags,
      result,
    });
    return result;
  };
  const push = gateway.forkTrace.push.bind(gateway.forkTrace);
  const pushSpy = vi.spyOn(gateway.forkTrace, "push").mockImplementation((...events) => {
    for (const event of events) {
      if (typeof event.pid === "number") processes.add(event.pid);
      if (typeof event.childPid === "number") processes.add(event.childPid);
      const { result, event: traceEvent, command: _command, ...details } = event;
      const observed = record("gateway", {
        ...details,
        traceEvent,
        resultKind:
          typeof result === "object" && result !== null && "kind" in result
            ? result.kind
            : undefined,
      });
      if (
        event.event === "restore-state" &&
        typeof event.operationId === "string" &&
        result !== undefined
      ) {
        const operation = pendingIds.get(event.operationId);
        if (operation !== undefined) operation.consumed = observed;
      }
    }
    return push(...events);
  });
  const wakeTrace = traceReaderWakes(
    gateway.fixture.context.wakes,
    record,
    () => context.getStore()?.key,
  );
  return {
    snapshot() {
      return {
        elapsedMs: performance.now() - started,
        active: gateway.fixture.capacity.active,
        waiting: gateway.fixture.capacity.waiting,
        processCount: table.size,
        processes: [...processes].map((pid) => ({ pid, state: table.lookupPid(pid) })),
        operations: [...operations.values()].map((operation) => ({
          ...operation,
          pid: portPids.get(operation.port),
        })),
        ...wakeTrace.snapshot(),
        totalEvents: sequence,
        recent,
      };
    },
    restore() {
      wakeTrace.restore();
      startSpy.mockRestore();
      parkSpy.mockRestore();
      table.waitpid = originalWaitpid;
      pushSpy.mockRestore();
      for (const restore of restores) restore();
    },
  };
}

export function traceBashReaderFailure(
  gateway: ReturnType<typeof createBashGateway>,
  cleanup: (failed: boolean) => Promise<void>,
) {
  const trace = readerTrace(gateway);
  let saved: string | undefined;
  let cleaning: Promise<void> | undefined;
  const close = (failed: boolean) => {
    if (cleaning !== undefined) return cleaning;
    try {
      saved = JSON.stringify(
        trace.snapshot(),
        (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
        2,
      );
    } catch (error) {
      saved = `Trace capture failed: ${String(error)}`;
    }
    cleaning = cleanup(failed).finally(() => trace.restore());
    return cleaning;
  };
  onTestFinished(async (test) => {
    try {
      if (cleaning === undefined) await close(test.task.result?.state === "fail");
    } finally {
      if (test.task.result?.state === "fail") {
        for (const error of test.task.result.errors ?? [])
          error.message += `\n[bash-reader-trace]\n${saved}`;
      }
    }
  });
  return close;
}
