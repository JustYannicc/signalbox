import { createRuntimeFailureState } from "./node/workerThreads/runtimeFailure.ts";
import { markNodeBuiltinCapability } from "./NodeBuiltinCapabilities.ts";

const nativeBases = new WeakMap<object, object>();

/** Capability inspection can retain native identities through this host-owned overlay. */
export const nodeRuntimeNativeModule = (module: object) => nativeBases.get(module) ?? module;

/** An unobserved native Worker cannot participate in an acknowledged harness result. */
export function createNodeRuntimeCompatibility(native: object) {
  const report: unknown = Reflect.get(native, "reportRuntimeFailure");
  const assert: unknown = Reflect.get(native, "assertRuntimeCompatibility");
  const failure: unknown = Reflect.get(native, "runtimeFailure");
  if (report !== undefined || assert !== undefined || failure !== undefined) {
    if (
      typeof report !== "function" ||
      typeof assert !== "function" ||
      failure === null ||
      typeof failure !== "object" ||
      typeof Reflect.get(failure, "then") !== "function"
    )
      throw new TypeError("Worker runtime compatibility capability is incomplete");
    const pending = Promise.resolve(failure).then(() => {
      throw new Error("Worker runtime failure signal resolved unexpectedly");
    });
    void pending.catch(() => undefined);
    return {
      module: native,
      failure: pending,
      assert: async () => {
        await Reflect.apply(assert, native, []);
      },
    };
  }

  const state = createRuntimeFailureState();
  const module = Object.freeze({
    ...native,
    Worker: markNodeBuiltinCapability(
      function Worker(..._args: readonly unknown[]) {
        const error = Object.assign(new Error("Worker runtime failure reporting is unavailable"), {
          code: "NODE_WORKER_RUNTIME_UNOBSERVED",
        });
        state.report(error);
        throw error;
      },
      {
        status: "unsupported",
        evidence:
          "Native workers are rejected before launch because they do not expose the host-owned failure and checkpoint channel.",
      },
    ),
    runtimeFailure: state.failure,
    reportRuntimeFailure: markNodeBuiltinCapability(state.report, {
      status: "supported",
      evidence:
        "The process-owned compatibility latch preserves the first reported failure as a host-owned Error until this realm is destroyed.",
    }),
    assertRuntimeCompatibility: markNodeBuiltinCapability(
      async () => {
        state.assert();
      },
      {
        status: "supported",
        evidence: "Checks the process-owned sticky failure latch without resetting it.",
      },
    ),
  });
  nativeBases.set(module, native);
  return { module, failure: state.failure, assert: module.assertRuntimeCompatibility };
}
