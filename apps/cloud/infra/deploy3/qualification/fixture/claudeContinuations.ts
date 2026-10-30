import * as Effect from "effect/Effect";
import type {
  HarnessContinuation,
  HarnessContinuationPublisher,
} from "../../../../src/harness/HarnessContinuations.ts";
import { HarnessError } from "../../../../src/harness/Harness.ts";

/** Implemented by the qualification capability through the normal thread command path. */
export interface ClaudeContinuationCapability {
  publishContinuation(request: HarnessContinuation): Promise<void>;
}

export function createClaudeContinuationPublisher(
  capability: ClaudeContinuationCapability,
): HarnessContinuationPublisher {
  return {
    publish: (request) =>
      Effect.tryPromise({
        try: () => capability.publishContinuation(request),
        catch: (cause) =>
          new HarnessError({
            operation: "turn",
            message: "Claude continuation could not be committed through the public thread path.",
            cause,
          }),
      }),
  };
}
