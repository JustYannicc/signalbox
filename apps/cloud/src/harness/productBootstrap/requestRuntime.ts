import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { HarnessHostSession } from "../HarnessSessionHost.ts";
import type { HarnessFacetRequestRuntime } from "../HarnessRequestFacet.ts";
import { HarnessRequestFacetError } from "../HarnessRequestFacet.ts";
import {
  createHarnessRequestTurnRuntime,
  type HarnessRequestTurnOptions,
} from "../HarnessRequestTurn.ts";
import type { HarnessCProductCapabilities } from "./capabilities.ts";
import type { HarnessCProductTurnBindings } from "./facetContracts.ts";

/** Builds the same request runtime for restored and newly created product sessions. */
export function createHarnessCProductRequestRuntime<G>(input: {
  readonly runId: string;
  readonly threadId: ThreadId;
  readonly capabilities: HarnessCProductCapabilities<G>;
  readonly turnBindings: HarnessCProductTurnBindings<G>;
  readonly session: HarnessHostSession<G>;
}): Effect.Effect<HarnessFacetRequestRuntime, HarnessRequestFacetError, Scope.Scope> {
  const options: Omit<HarnessRequestTurnOptions<G>, "restore"> = {
    ...(input.turnBindings.deadline === undefined ? {} : { deadline: input.turnBindings.deadline }),
    readInput: (reference, context) =>
      Effect.gen(function* () {
        const turn = yield* input.turnBindings.readTurn(reference, context);
        const access = yield* Effect.tryPromise({
          try: () =>
            input.capabilities.access.resolveTurnAccess({
              threadId: input.threadId,
              runId: input.runId,
              requestId: context.requestId,
            }),
          catch: (cause) => failed("Turn access could not be resolved.", cause),
        });
        return {
          turn,
          access: {
            ...access,
            signal: context.signal,
            ...(input.capabilities.turnGrantSource === undefined
              ? {}
              : {
                  publisher: {
                    generation: context.publisher.generation,
                    facetNonce: context.publisher.facetNonce,
                  },
                }),
          },
        };
      }),
    onEvent: input.turnBindings.onEvent,
    writeResult: input.turnBindings.writeResult,
    writeCheckpoint: input.turnBindings.writeCheckpoint,
    verify: input.turnBindings.verify,
  };
  return createHarnessRequestTurnRuntime(options, input.session);
}

function failed(message: string, cause?: unknown) {
  return new HarnessRequestFacetError(message, cause === undefined ? undefined : { cause });
}
