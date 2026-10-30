// The private control channel uses Node MessagePorts, which have no targetOrigin argument.
/* oxlint-disable unicorn/require-post-message-target-origin */
import type { NodeWorkerPorts } from "./portRuntime.ts";
import type { NodeWorkerThreadContext } from "./workerProtocol.ts";
import {
  createRuntimeFailureState,
  createWorkerRuntimeFailureMessage,
  readWorkerRuntimeFailure,
} from "./runtimeFailure.ts";

const checkType = "signalbox:worker-runtime-check:v1";
const checkedType = "signalbox:worker-runtime-checked:v1";

function checkId(value: unknown, type: string): number | undefined {
  if (value === null || typeof value !== "object") return;
  const id: unknown = Reflect.get(value, "id");
  return Reflect.get(value, "type") === type &&
    typeof id === "number" &&
    Number.isSafeInteger(id) &&
    id > 0
    ? id
    : undefined;
}

/** The private channel survives guest parentPort closure and listener removal. */
export function createWorkerRuntimeControl(
  ports: NodeWorkerPorts,
  context: NodeWorkerThreadContext,
) {
  const state = createRuntimeFailureState();
  const workers = new Set<{ checkpoint(): Promise<void> }>();
  const parentControl =
    context.runtimePort === undefined ? undefined : ports.adopt(context.runtimePort);
  parentControl?.unref();

  function report(error: unknown) {
    if (!state.report(error)) return;
    parentControl?.postMessage(createWorkerRuntimeFailureMessage(state.error));
  }

  async function assert(): Promise<void> {
    state.assert();
    const checked = new Set<object>();
    for (;;) {
      const active = [...workers].filter((worker) => !checked.has(worker));
      for (const worker of active) checked.add(worker);
      await Promise.race([Promise.all(active.map((worker) => worker.checkpoint())), state.failure]);
      await ports.drain();
      state.assert();
      if ([...workers].every((worker) => checked.has(worker))) return;
    }
  }

  parentControl?.on("message", (value) => {
    const id = checkId(value, checkType);
    if (id === undefined) {
      report(new Error("Worker runtime checkpoint is invalid"));
      return;
    }
    void assert()
      .catch(report)
      .then(() => {
        parentControl.postMessage({ type: checkedType, id });
      })
      .catch((error: unknown) => ports.reportFailure(error));
  });

  return {
    failure: state.failure,
    get error() {
      return state.error;
    },
    report,
    assert,
    workerChannel() {
      const channel = ports.channel();
      channel.port1.unref();
      channel.port2.unref();
      const checks = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
      let sequence = 0;
      let stopped = false;
      channel.port1.on("message", (value) => {
        const failure = readWorkerRuntimeFailure(value);
        if (failure !== undefined) {
          report(failure);
          return;
        }
        const id = checkId(value, checkedType);
        const pending = id === undefined ? undefined : checks.get(id);
        if (pending === undefined) {
          report(new Error("Worker runtime checkpoint acknowledgement is invalid"));
          return;
        }
        checks.delete(id!);
        pending.resolve();
      });
      const worker = {
        async checkpoint() {
          if (stopped) return;
          const id = ++sequence;
          const pending = Promise.withResolvers<void>();
          checks.set(id, pending);
          channel.port1.postMessage({ type: checkType, id });
          await pending.promise;
        },
      };
      workers.add(worker);
      return {
        port: channel.port2,
        /** Called only after the supervisor confirms stop and its reports have drained. */
        stopped() {
          stopped = true;
          workers.delete(worker);
          for (const pending of checks.values()) pending.resolve();
          checks.clear();
          channel.port1.close();
        },
        discard() {
          workers.delete(worker);
          channel.port1.close();
          channel.port2.close();
        },
      };
    },
  };
}
