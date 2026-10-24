// @effect-diagnostics globalTimers:off cryptoRandomUUID:off - the Promise-based kernel owns operation scheduling and opaque resume tokens.
import type { KernelBashPort } from "./KernelBashPort.ts";
import type {
  KernelBashOperation,
  KernelBashOperationResult,
  KernelBashOperationStart,
} from "./KernelBashCheckpoint.ts";
import { runKernelSuspensionObserver } from "./KernelSuspension.ts";
import { copyKernelRpcRecord } from "./KernelRpcReply.ts";

type Port = Pick<KernelBashPort, "call" | "callBash" | "wait" | "exec">;

type Outcome =
  | { readonly status: "ok"; readonly result: KernelBashOperationResult }
  | { readonly status: "error"; readonly error: unknown };

interface OwnedOperation {
  readonly id: string;
  readonly startFinished: Promise<void>;
  readonly finishStart: () => void;
  settled: Promise<Outcome>;
  taking: boolean;
}

const emptyOutcome: Promise<Outcome> = Promise.resolve({
  status: "error",
  error: new Error("Bash operation has not started"),
});

/** Keeps one in-flight Bash host operation available to the parent without rerunning it. */
export function createKernelBashOperations(port: Port) {
  let current: OwnedOperation | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  async function start(operation: KernelBashOperation): Promise<KernelBashOperationStart> {
    if (closed) throw new Error("Bash operation host is closed");
    if (current !== undefined) throw new Error("A Bash host operation is already active");

    let finishStart!: () => void;
    const startFinished = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const owned: OwnedOperation = {
      id: crypto.randomUUID(),
      startFinished,
      finishStart,
      settled: emptyOutcome,
      taking: false,
    };
    current = owned;

    let didSuspend = false;
    let signalSuspension!: () => void;
    const suspended = new Promise<void>((resolve) => {
      signalSuspension = resolve;
    });
    const notify = () => {
      if (didSuspend) return;
      didSuspend = true;
      signalSuspension();
    };

    try {
      owned.settled = runKernelSuspensionObserver(notify, () => {
        try {
          return invokeAfterBoundary(port, operation).then(
            (result): Outcome => ({ status: "ok", result }),
            (error: unknown): Outcome => ({ status: "error", error }),
          );
        } catch (error) {
          return Promise.resolve({ status: "error", error });
        }
      });

      if (operation.kind === "exec" || didSuspend) {
        return { kind: "pending", id: owned.id };
      }

      const first = await Promise.race([
        owned.settled.then((outcome) => ({ kind: "settled" as const, outcome })),
        suspended.then(() => ({ kind: "suspended" as const })),
      ]);
      if (first.kind === "suspended") return { kind: "pending", id: owned.id };

      current = undefined;
      if (first.outcome.status === "error") throw first.outcome.error;
      return { kind: "ready", result: first.outcome.result };
    } finally {
      owned.finishStart();
      if (current === owned && !didSuspend && operation.kind !== "exec") {
        const outcome = await owned.settled;
        if (outcome.status === "error") current = undefined;
      }
    }
  }

  async function take(id: string): Promise<KernelBashOperationResult> {
    const owned = current;
    if (owned === undefined || owned.id !== id || owned.taking) {
      throw new Error("Unknown or consumed Bash operation");
    }
    owned.taking = true;
    const outcome = await owned.settled;
    if (current === owned) current = undefined;
    if (outcome.status === "error") throw outcome.error;
    return outcome.result;
  }

  function close(): Promise<void> {
    return (closing ??= (async () => {
      closed = true;
      const owned = current;
      if (owned === undefined) return;
      await owned.startFinished;
      await owned.settled;
      if (current === owned && !owned.taking) current = undefined;
    })());
  }

  return { start, take, close };
}

function invoke(port: Port, operation: KernelBashOperation): Promise<KernelBashOperationResult> {
  switch (operation.kind) {
    case "wasi":
      return port
        .call(operation.request)
        .then((reply) => ({ kind: "wasi", value: copyKernelRpcRecord(reply) }));
    case "bash":
      return port
        .callBash(operation.request)
        .then((reply) => ({ kind: "bash", value: copyKernelRpcRecord(reply) }));
    case "wait":
      return port
        .wait(operation.pid, operation.options)
        .then((reply) => ({ kind: "wait", value: copyKernelRpcRecord(reply) }));
    case "exec":
      return port
        .exec(operation.request)
        .then((reply) => ({ kind: "exec", value: copyKernelRpcRecord(reply) }));
  }
}

function invokeAfterBoundary(
  port: Port,
  operation: KernelBashOperation,
): Promise<KernelBashOperationResult> {
  if (operation.kind !== "exec") return invoke(port, operation);
  return new Promise((resolve, reject) => {
    // Admission can block on another child; let this RPC return pending first.
    setTimeout(() => {
      try {
        void invoke(port, operation).then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    }, 0);
  });
}
