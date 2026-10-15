import type { AutomationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * A durable workflow backend that runs each automation run as one instance
 * of its version's code and journals its steps (in Signalbox Cloud,
 * Cloudflare Dynamic Workflows). The engine records runs and steps for
 * people to see; the backend owns replay, timers and waiting.
 */
export interface AutomationRunnerShape {
  /** Starts the run as a new instance pinned to `version`. */
  readonly create: (run: {
    readonly runId: string;
    readonly automationId: string;
    readonly version: number;
    readonly input: unknown;
    readonly trigger: unknown;
  }) => Effect.Effect<void, AutomationError>;
  /**
   * Delivers a step's outcome to the instance waiting on it. Events sent
   * before the instance reaches its wait are buffered by the backend.
   */
  readonly sendEvent: (
    runId: string,
    type: string,
    payload: unknown,
  ) => Effect.Effect<void, AutomationError>;
  /** Stops the instance; a run that already finished is left as it is. */
  readonly terminate: (runId: string) => Effect.Effect<void>;
}

export class AutomationRunner extends Context.Service<AutomationRunner, AutomationRunnerShape>()(
  "@signalbox/automations/runner/AutomationRunner",
) {}
