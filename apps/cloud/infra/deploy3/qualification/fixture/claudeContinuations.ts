import * as Effect from "effect/Effect";
import type {
  HarnessContinuation,
  HarnessContinuationPublisher,
} from "../../../../src/harness/HarnessContinuations.ts";
import { HarnessError } from "../../../../src/harness/Harness.ts";

/** Disposable fixture binding behind the public product continuation contract. */
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
            message: "Claude continuation could not be recorded by its qualification fixture.",
            cause,
          }),
      }),
  };
}
