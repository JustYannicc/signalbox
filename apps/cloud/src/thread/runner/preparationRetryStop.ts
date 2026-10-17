import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MachineBackend from "./MachineBackend.ts";

/** Stops the old machine before the Runner may ask for the retried generation. */
export const stopForPreparationRetry = Effect.fn("ThreadRunner.stopForPreparationRetry")(function* <
  ReportR = never,
  SettleR = never,
>(input: {
  readonly backends: MachineBackend.MachineBackends;
  readonly threadId: ThreadId;
  readonly generation: number;
  readonly report?: (status: MachineBackend.MachineStatus) => Effect.Effect<void, never, ReportR>;
  readonly settle: (generation: number) => Effect.Effect<boolean, never, SettleR>;
}) {
  let stopped = true;
  for (const backend of MachineBackend.distinctBackends(input.backends)) {
    const status = yield* backend.stop(input.threadId);
    if (status.actual !== "none" && input.report !== undefined) {
      yield* input.report(status);
    }
    stopped &&= MachineBackend.isStopped(status);
  }
  return {
    stopped,
    settled: stopped ? yield* input.settle(input.generation) : false,
  };
});
