import type {
  AutomationError,
  AutomationErrorDetail,
  AutomationRunSummary,
  AutomationRunTrigger,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { AutomationRow, RunRow } from "./WorkflowStore.ts";

/** The run core's entry points, as the modules around the engine call them. */

export interface Launch {
  readonly automation: AutomationRow;
  readonly input: unknown;
  readonly trigger: AutomationRunTrigger;
  /** The run whose `w.start` started this one. */
  readonly parent?: RunRow;
  readonly runId?: string;
  readonly webhook?: { readonly headers?: unknown; readonly rawBody?: unknown };
  /** What an event trigger fired on, for the run's trigger. */
  readonly event?: { readonly event: string; readonly eventId: string };
  /** For runs started by another automation's events, which count toward the start depth. */
  readonly depth?: number;
  /** Runs in the insert's transaction; returning a run id means that run stands in for this one. */
  readonly claim?: (runId: string) => Effect.Effect<string | undefined, AutomationError>;
  /** The run this one retries, whose input, trigger, seed and clock it replays with. */
  readonly retryOf?: RunRow;
  /** Defaults to the live version. */
  readonly version?: number;
}

/** Records a new run and queues its first replay. `duplicate` when a claimed run stood in for it. */
export type LaunchRun = (
  launch: Launch,
) => Effect.Effect<
  { readonly run: AutomationRunSummary; readonly duplicate: boolean },
  AutomationError
>;

/** How a run ended. */
export type RunOutcome =
  | { readonly status: "succeeded"; readonly output: unknown }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly detail?: AutomationErrorDetail | null;
    }
  | { readonly status: "cancelled" };

/** Ends a running run once; false when it had already ended. */
export type EndRun = (run: RunRow, outcome: RunOutcome) => Effect.Effect<boolean, AutomationError>;

/** How a step settles; failures carry the why/fix when the engine knows them. */
export type Settlement =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string; readonly detail?: AutomationErrorDetail | null };
